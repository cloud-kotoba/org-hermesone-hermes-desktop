;; Run registry for the Hermes `/v1/runs` surface.
;;
;; A run owns one event queue. The agent thread pushes events; exactly one SSE
;; reader drains them. `None` on the queue is the close sentinel, matching the
;; upstream api_server_runs contract.

(import queue threading time uuid)

(setv TERMINAL-STATUSES #{"completed" "failed" "cancelled" "interrupted"})

(defn run-event [run-id name #** fields]
  "One SSE payload. Key order (event, run_id, timestamp, ...) is wire format."
  {"event" name "run_id" run-id "timestamp" (time.time) #** fields})

(defclass Run []
  (defn __init__ [self run-id session-id]
    (setv self.run-id run-id
          self.session-id session-id
          self.status "queued"
          self.events (queue.Queue)
          self.agent None
          self.stop-requested False
          self.created-at (time.time)
          self.last-event None
          self.output None
          self.error None))

  (defn put [self event]
    (when event
      (setv self.last-event (get event "event")))
    (.put self.events event))

  (defn finish [self status #** fields]
    "Publish the terminal `run.<status>` event and close the stream."
    (when (in self.status TERMINAL-STATUSES)
      (return))
    (when (and self.stop-requested (!= status "failed"))
      (setv status "cancelled"))
    (setv self.status status
          self.output (.get fields "output")
          self.error (.get fields "error"))
    (.put self (run-event self.run-id f"run.{status}" #** fields))
    (.put self None))

  (defn snapshot [self]
    {"object" "hermes.run"
     "run_id" self.run-id
     "session_id" self.session-id
     "status" self.status
     "created_at" self.created-at
     "last_event" self.last-event
     "output" self.output
     "error" self.error}))

(defclass RunRegistry []
  (defn __init__ [self]
    (setv self.runs {}
          self.lock (threading.Lock)))

  (defn create [self session-id]
    (setv run (Run f"run_{(. (uuid.uuid4) hex)}" session-id))
    (with [self.lock]
      (setv (get self.runs run.run-id) run))
    run)

  (defn get-run [self run-id]
    (with [self.lock]
      (.get self.runs run-id)))

  (defn active-count [self]
    (with [self.lock]
      (len (lfor r (.values self.runs) :if (not-in r.status TERMINAL-STATUSES) r))))

  (defn stop [self run-id]
    "Request cancellation. Returns the run, or None when unknown."
    (setv run (.get-run self run-id))
    (when (is run None)
      (return None))
    (setv run.stop-requested True)
    (when (and run.agent (hasattr run.agent "interrupt"))
      (try
        (.interrupt run.agent "Stopped from Kotoba desktop.")
        (except [Exception])))
    run))
