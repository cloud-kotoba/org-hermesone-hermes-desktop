;; Lease client: signed heartbeats to the murakumo control plane, a lease set
;; held on the local clock, and the shard host ticking only leased profiles.

(import json os tempfile unittest
        concurrent.futures [ThreadPoolExecutor]
        kotoba_gateway.identity [NodeIdentity verify body-digest]
        kotoba_gateway.lease [LeaseClient signing-input]
        kotoba_gateway.shard [ProfileIndex ShardHost])
(import tests.test_shard [write-jobs job Clock T0])

(defclass FakePlane []
  "Records requests; answers with a scripted lease set."
  (defn __init__ [self server-now-ms leases [status 200]]
    (setv self.calls [] self.server-now-ms server-now-ms self.leases leases
          self.status status self.fail False))
  (defn __call__ [self url body headers]
    (when self.fail (raise (OSError "network down")))
    (.append self.calls {"url" url "body" body "headers" headers})
    [self.status {"now" self.server-now-ms "leases" self.leases}]))

(defclass Client [unittest.TestCase]
  (defn setUp [self]
    (setv self.node (NodeIdentity.generate)
          self.clock (Clock T0)))

  (defn client [self plane [on-change None]]
    (LeaseClient "https://murakumo.cloud" self.node :caps ["python3"] :clock self.clock
                 :post plane :on-change on-change))

  ;; @lat: [[profile-distribution#Lease client#Tests#Heartbeats are signed under the lease domain]]
  (defn test-signed-heartbeat [self]
    (.assertEqual self (signing-input "did:key:z6Mk1" "https://murakumo.cloud" "ab")
                  b"murakumo-profile-lease-v1\ndid:key:z6Mk1\nhttps://murakumo.cloud\nab\n")
    (setv plane (FakePlane (* 1000 T0) []) c (.client self plane))
    (.heartbeat c)
    (setv call (get plane.calls 0)
          sig (get call "headers" "x-murakumo-signature"))
    (.assertEqual self (get call "url")
                  (+ "https://murakumo.cloud/api/profiles/nodes/" self.node.did "/heartbeat"))
    (.assertTrue self (verify self.node.did
                              (signing-input self.node.did "https://murakumo.cloud"
                                             (body-digest (get call "body")))
                              sig))
    (.assertEqual self (get (json.loads (get call "body")) "caps") ["python3"]))

  ;; @lat: [[profile-distribution#Lease client#Tests#Expiry is counted on the local clock]]
  (defn test-expiry-on-local-clock [self]
    ;; server clock is 1 h ahead of ours; lease runs 600 s from server now
    (setv server-now (+ (* 1000 T0) 3600000)
          plane (FakePlane server-now [{"profile" "a" "epoch" 3 "expires_at" (+ server-now 600000)}])
          c (.client self plane))
    (.heartbeat c)
    (.assertTrue self (.allows c "a" (+ T0 599)))
    (.assertFalse self (.allows c "a" (+ T0 600)))
    (.assertFalse self (.allows c "b"))
    (.assertEqual self (.held c) [{"profile" "a" "epoch" 3}]))

  ;; @lat: [[profile-distribution#Lease client#Tests#Leases run out when the plane is unreachable]]
  (defn test-fail-closed [self]
    (setv plane (FakePlane (* 1000 T0) [{"profile" "a" "epoch" 1 "expires_at" (+ (* 1000 T0) 600000)}])
          c (.client self plane))
    (.assertTrue self (.heartbeat c))
    (setv plane.fail True)
    (setv self.clock.t (+ T0 300))
    (.assertFalse self (.heartbeat c))
    (.assertTrue self (.allows c "a"))          ; still within its lease
    (setv self.clock.t (+ T0 601))
    (.assertFalse self (.allows c "a")))        ; ran out: stop ticking

  ;; @lat: [[profile-distribution#Lease client#Tests#Observed time strictly grows]]
  (defn test-observed-monotonic [self]
    (setv plane (FakePlane (* 1000 T0) []) c (.client self plane))
    (.heartbeat c) (.heartbeat c)               ; same clock reading twice
    (setv [a b] (lfor call plane.calls (get (json.loads (get call "body")) "observed_at_ms")))
    (.assertGreater self b a))

  ;; @lat: [[profile-distribution#Lease client#Tests#Lease changes are announced]]
  (defn test-on-change [self]
    (setv seen []
          plane (FakePlane (* 1000 T0) [{"profile" "a" "epoch" 1 "expires_at" (+ (* 1000 T0) 600000)}])
          c (.client self plane :on-change (fn [s] (.append seen s))))
    (.heartbeat c) (.heartbeat c)
    (setv plane.leases [])
    (.heartbeat c)
    (.assertEqual self seen [#{"a"} (set)])))

(defclass ShardWithLeases [unittest.TestCase]
  (defn setUp [self]
    (setv self.tmp (tempfile.TemporaryDirectory) self.home self.tmp.name)
    (for [name ["mine" "theirs"]]
      (write-jobs (os.path.join self.home "profiles" name) [(job (- T0 1))])))
  (defn tearDown [self] (.cleanup self.tmp))

  ;; @lat: [[profile-distribution#Lease client#Tests#Only leased profiles are ticked]]
  (defn test-only-leased-profiles-tick [self]
    (setv held #{"mine"} calls []
          host (ShardHost (ProfileIndex self.home)
                          (fn [name home] (.append calls name) (write-jobs home [(job (+ T0 86400))]))
                          :mode "run" :max-turns 2 :rescan-seconds 30 :housekeeping-seconds 1e9
                          :clock (Clock T0) :allow (fn [name] (in name held))))
    (.step host)
    (.shutdown host.pool :wait True)
    (.assertEqual self calls ["mine"])
    ;; gaining a lease schedules the profile; the next pass ticks it
    (setv host.pool (ThreadPoolExecutor :max_workers 2))
    (.add held "theirs")
    (.reapply-leases host)
    (.step host)
    (.shutdown host.pool :wait True)
    (.assertEqual self (sorted calls) ["mine" "theirs"]))

  ;; @lat: [[profile-distribution#Lease client#Tests#A lease lost before the tick is not acted on]]
  (defn test-lease-checked-at-tick-time [self]
    (setv held #{"mine"} calls []
          host (ShardHost (ProfileIndex self.home) (fn [name home] (.append calls name))
                          :mode "run" :clock (Clock T0) :allow (fn [name] (in name held))))
    (.discard held "mine")                      ; lost between scheduling and tick
    (.tick-profile host "mine")
    (.assertEqual self calls [])))

(when (= __name__ "__main__")
  (unittest.main))
