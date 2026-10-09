;; Shard host: one heap for all profiles' cron schedules, ticking only due
;; profiles. Upstream tick is replaced by a recording fake; time by a clock.

(import json os sqlite3 tempfile threading time unittest
        datetime [datetime timezone timedelta])
(import kotoba_gateway.shard [ProfileIndex ShardHost cost-report live-multiplexer
                              profile-schedule])

(setv T0 1791500000.0)   ; 2026-10-08T... UTC, an arbitrary fixed "now"

(defn iso [epoch]
  (.isoformat (datetime.fromtimestamp epoch timezone.utc)))

(defn write-jobs [home jobs]
  (os.makedirs (os.path.join home "cron") :exist_ok True)
  (setv path (os.path.join home "cron" "jobs.json"))
  (with [f (open path "w")] (json.dump {"jobs" jobs} f))
  ;; distinct mtimes even within one clock tick of the filesystem
  (setv st (os.stat path))
  (os.utime path :ns #(st.st_atime_ns (+ st.st_mtime_ns 1000000)))
  path)

(defn job [due [enabled True] [state "scheduled"]]
  {"id" "j" "enabled" enabled "state" state "next_run_at" (when due (iso due))})

(defclass Clock []
  (defn __init__ [self t] (setv self.t t))
  (defn __call__ [self] self.t))

(defclass Fixture [unittest.TestCase]
  (defn setUp [self]
    (setv self.tmp (tempfile.TemporaryDirectory)
          self.home self.tmp.name)
    (os.makedirs (os.path.join self.home "profiles") :exist_ok True))
  (defn tearDown [self] (.cleanup self.tmp))
  (defn profile [self name jobs]
    (setv home (os.path.join self.home "profiles" name))
    (os.makedirs home :exist_ok True)
    (write-jobs home jobs)
    home))

(defclass Schedules [Fixture]
  ;; @lat: [[profile-distribution#Shard host implementation#Tests#Earliest active job sets a profile's due time]]
  (defn test-earliest-active-job [self]
    (setv home (.profile self "a" [(job (+ T0 300)) (job (+ T0 100))
                                   (job (+ T0 50) :enabled False)
                                   (job (+ T0 10) :state "paused")]))
    (.assertEqual self (profile-schedule (os.path.join home "cron" "jobs.json") T0)
                  [(+ T0 100) 2])
    (setv home2 (.profile self "b" [(job None)]))
    (.assertEqual self (get (profile-schedule (os.path.join home2 "cron" "jobs.json") T0) 0) T0)
    (setv home3 (.profile self "c" [(job (+ T0 5) :state "paused")]))
    (.assertEqual self (profile-schedule (os.path.join home3 "cron" "jobs.json") T0) [None 0]))

  ;; @lat: [[profile-distribution#Shard host implementation#Tests#Unchanged profiles cost one stat]]
  (defn test-rescan-rereads-only-changed [self]
    (for [i (range 50)] (.profile self f"p{i}" [(job (+ T0 3600))]))
    (setv index (ProfileIndex self.home))
    (.assertEqual self (len (.scan index T0)) 51)        ; default + 50, first sight
    (.assertEqual self (.scan index T0) [])              ; nothing changed
    (write-jobs (os.path.join self.home "profiles" "p7") [(job (+ T0 60))])
    (.assertEqual self (.scan index T0) ["p7"])
    (.assertEqual self (get index.entries "p7" "due") (+ T0 60))))

(defclass Host [Fixture]
  (defn host [self mode clock calls [max-turns 2] [on-tick None]]
    (defn tick-fn [name home]
      (.append calls name)
      (when on-tick (on-tick name home)))
    (ShardHost (ProfileIndex self.home) tick-fn :mode mode :max-turns max-turns
               :rescan-seconds 30 :housekeeping-seconds 1e9 :clock clock))

  ;; @lat: [[profile-distribution#Shard host implementation#Tests#Only due profiles are ticked]]
  (defn test-only-due-profiles-tick [self]
    (.profile self "soon" [(job (+ T0 100))])
    (.profile self "later" [(job (+ T0 10000))])
    (.profile self "idle" [])
    (setv clock (Clock T0) calls []
          host (.host self "run" clock calls
                      :on-tick (fn [name home] (write-jobs home [(job (+ T0 86400))]))))
    (.step host)
    (.assertEqual self calls [])                         ; nothing due yet
    (setv clock.t (+ T0 150))
    (.step host)
    (.shutdown host.pool :wait True)
    (.assertEqual self calls ["soon"])
    ;; ticked profile re-read and rescheduled for its advanced next_run_at
    (.assertAlmostEqual self (.next-due host) (+ T0 10000)))

  ;; @lat: [[profile-distribution#Shard host implementation#Tests#Observe mode never executes]]
  (defn test-observe-never-ticks [self]
    (.profile self "a" [(job (- T0 5))])
    (.profile self "b" [(job (- T0 1))])
    (setv clock (Clock T0) calls [] host (.host self "observe" clock calls))
    (.step host)
    (.step host)
    (.assertEqual self calls [])
    (.assertEqual self host.fires 2)
    (.assertEqual self (sorted (lfor r host.recent (get r "profile"))) ["a" "b"]))

  ;; @lat: [[profile-distribution#Shard host implementation#Tests#Concurrent ticks are bounded]]
  (defn test-bounded-concurrency [self]
    (for [i (range 6)] (.profile self f"p{i}" [(job (- T0 1))]))
    (setv gate (threading.Event) lock (threading.Lock) state {"now" 0 "peak" 0})
    (defn on-tick [name home]
      (with [lock]
        (+= (get state "now") 1)
        (setv (get state "peak") (max (get state "peak") (get state "now"))))
      (.wait gate 2)
      (write-jobs home [(job (+ T0 86400))])
      (with [lock] (-= (get state "now") 1)))
    (setv calls [] host (.host self "run" (Clock T0) calls :max-turns 2 :on-tick on-tick))
    (.step host)
    (time.sleep 0.2)
    (.set gate)
    (.shutdown host.pool :wait True)
    (.assertEqual self (len calls) 6)
    (.assertEqual self (get state "peak") 2))

  ;; @lat: [[profile-distribution#Shard host implementation#Tests#Run mode refuses a live multiplexer]]
  (defn test-live-multiplexer-guard [self]
    (setv state (os.path.join self.home "gateway_state.json"))
    (.assertIsNone self (live-multiplexer self.home))
    (with [f (open state "w")] (json.dump {"gateway_state" "running" "pid" (os.getpid)} f))
    (.assertEqual self (live-multiplexer self.home) (os.getpid))
    (with [f (open state "w")] (json.dump {"gateway_state" "stopped" "pid" (os.getpid)} f))
    (.assertIsNone self (live-multiplexer self.home))))

(defclass Costs [Fixture]
  ;; @lat: [[profile-distribution#Shard host implementation#Tests#Cost report comes from execution history]]
  (defn test-cost-report [self]
    (setv home (.profile self "busy" [(job (+ T0 60))])
          db (sqlite3.connect (os.path.join home "cron" "executions.db")))
    (.execute db "CREATE TABLE executions (id TEXT, job_id TEXT, status TEXT, started_at TEXT, finished_at TEXT)")
    ;; 14 runs over the last 7 days, 60 s each
    (for [i (range 14)]
      (setv start (- T0 (* i 43200) 100))
      (.execute db "INSERT INTO executions VALUES (?,?,?,?,?)"
                #(f"e{i}" "j" "completed" (iso start) (iso (+ start 60)))))
    (.commit db) (.close db)
    (setv report (cost-report self.home :nodes 2 :turns-per-node 1 :now T0)
          busy (get report "costliest" 0))
    (.assertEqual self (get busy "profile") "busy")
    (.assertAlmostEqual self (get busy "cost_ema_seconds") 60 :places 1)
    (.assertAlmostEqual self (get busy "fires_per_day") 2 :places 1)
    (.assertAlmostEqual self (get report "busy_seconds_per_day") 120 :places 0)))

(when (= __name__ "__main__")
  (unittest.main))
