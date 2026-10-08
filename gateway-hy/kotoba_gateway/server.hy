;; Hermes API-compatible HTTP server for Kotoba desktop.
;;
;; Implements the subset of the upstream Hermes Agent api_server
;; (gateway/platforms/api_server.py) that the desktop speaks:
;;
;;   GET  /health                    unauthenticated liveness
;;   GET  /health/detailed           readiness for dashboard probing
;;   GET  /api/status                gateway status (dashboard contract)
;;   GET  /v1/capabilities           feature detection
;;   GET  /v1/models                 configured model
;;   POST /v1/chat/completions       OpenAI chat, streaming + non-streaming
;;   POST /v1/runs                   start a run (202 + run_id)
;;   GET  /v1/runs/{id}              run status
;;   GET  /v1/runs/{id}/events       run SSE event stream
;;   POST /v1/runs/{id}/stop         interrupt a run
;;
;; Every route is mirrored under /p/<profile>/ like upstream; one process
;; serves one profile, so the prefix is accepted and stripped.
;;
;; stdlib only (plus Hy) so it runs inside Hermes Agent's own venv.

(import argparse hmac json os queue re signal sys threading time uuid
        http.server [BaseHTTPRequestHandler ThreadingHTTPServer]
        urllib.parse [urlsplit])
(import kotoba_gateway [__version__]
        kotoba_gateway.backend [Callbacks make-backend]
        kotoba_gateway.runs [RunRegistry run-event TERMINAL-STATUSES])

(setv MAX-BODY-BYTES (* 32 1024 1024)
      KEEPALIVE-SECONDS 15
      PROFILE-PREFIX-RE (re.compile r"^/p/[A-Za-z0-9_.-]+(/.*)$")
      RUN-PATH-RE (re.compile r"^/v1/runs/([A-Za-z0-9_-]+)(/events|/stop)?$")
      LOOPBACK #{"127.0.0.1" "::1" "localhost"})

(setv CAPABILITY-ENDPOINTS
      [["health" "GET" "/health"]
       ["models" "GET" "/v1/models"]
       ["chat_completions" "POST" "/v1/chat/completions"]
       ["runs" "POST" "/v1/runs"]
       ["run_status" "GET" "/v1/runs/{run_id}"]
       ["run_events" "GET" "/v1/runs/{run_id}/events"]
       ["run_stop" "POST" "/v1/runs/{run_id}/stop"]])

;; ─── Request parsing ─────────────────────────────────────────────────────

(defn content-text [content]
  "Flatten OpenAI content (string or part list) to text for history."
  (cond
    (isinstance content str) content
    (isinstance content list)
    (.join "\n" (lfor part content
                      :if (and (isinstance part dict) (= (.get part "type") "text"))
                      (or (.get part "text") "")))
    True (if (is content None) "" (str content))))

(defn split-chat-messages [messages]
  "OpenAI messages -> [instructions history user-message]."
  (setv system-parts []
        turns [])
  (for [m (or messages [])]
    (setv role (.get m "role"))
    (cond
      (in role #{"system" "developer"}) (.append system-parts (content-text (.get m "content")))
      (in role #{"user" "assistant"}) (.append turns m)))
  (when (or (not turns) (!= (.get (get turns -1) "role") "user"))
    (return [None [] None]))
  [(or (.join "\n\n" (filter None system-parts)) None)
   (lfor m (cut turns -1) {"role" (get m "role") "content" (content-text (.get m "content"))})
   (.get (get turns -1) "content")])

(defn normalize-history [history]
  (lfor m (or history [])
        :if (and (isinstance m dict) (in (.get m "role") #{"user" "assistant"}))
        {"role" (get m "role") "content" (content-text (.get m "content"))}))

;; ─── Gateway state ───────────────────────────────────────────────────────

(defclass Gateway []
  (defn __init__ [self backend api-key]
    (setv self.backend backend
          self.api-key (or api-key None)
          self.runs (RunRegistry)
          self.started-at (time.time)
          self.model (.model-name backend)
          self.hermes-version (.version backend)))

  (defn authorized? [self header]
    (when (not self.api-key)
      (return True))
    (setv expected (+ "Bearer " self.api-key))
    (hmac.compare_digest (.encode (or header "")) (.encode expected)))

  (defn launch-turn [self run user-message history instructions model]
    "Run one agent turn on a worker thread, feeding `run`'s event queue."
    (setv rid run.run-id)
    (defn on-tool [event]
      (.put run (run-event rid (.pop event "event") #** event)))
    (setv cb (Callbacks
               :on_delta (fn [d] (.put run (run-event rid "message.delta" :delta d)))
               :on_reasoning (fn [t] (.put run (run-event rid "reasoning.available" :text t)))
               :on_tool on-tool
               :on_approval (fn [data]
                              (setv run.status "waiting_for_approval")
                              (.put run (run-event rid "approval.request"
                                                   :description (str (.get data "description" ""))
                                                   :pattern_key (.get data "pattern_key"))))
               :on_agent (fn [a] (setv run.agent a))))
    (defn work []
      (setv run.status "running")
      (try
        (setv result (.run-turn self.backend
                                :callbacks cb
                                :run_id rid
                                :session_id run.session-id
                                :user_message user-message
                                :history history
                                :instructions instructions
                                :model model))
        (cond
          (.get result "interrupted")
          (.finish run "cancelled" :completed False :interrupted True)
          (or (.get result "failed") (= (.get result "completed") False))
          (.finish run "failed" :completed False
                   :error (str (or (.get result "error") "agent run failed")))
          True
          (.finish run "completed" :completed True
                   :output (or (.get result "final_response") "")
                   :usage (.get result "usage" {})
                   :runtime {"model" (or (getattr run.agent "model" None) model self.model)
                             "provider" (or (getattr run.agent "provider" None) "")}))
        (except [e Exception]
          (print f"[kotoba-gateway] run {rid} failed: {e!r}" :file sys.stderr)
          (.finish run "failed" :completed False :error (str e)))
        (finally
          (setv run.agent None))))
    (.start (threading.Thread :target work :name f"kotoba-run-{rid}" :daemon True))
    run))

;; ─── HTTP handler ────────────────────────────────────────────────────────

(defclass Handler [BaseHTTPRequestHandler]
  (setv protocol_version "HTTP/1.1"
        server_version f"kotoba-gateway/{__version__}"
        gateway None)

  (defn log_message [self fmt #* args]
    (when (os.environ.get "KOTOBA_GATEWAY_ACCESS_LOG")
      (.write sys.stderr (+ (% fmt args) "\n"))))

  ;; -- response helpers --

  (defn send-json [self status payload [headers None]]
    (setv body (.encode (json.dumps payload :ensure_ascii False) "utf-8"))
    (.send_response self status)
    (.send_header self "Content-Type" "application/json; charset=utf-8")
    (.send_header self "Content-Length" (str (len body)))
    (for [[k v] (.items (or headers {}))]
      (.send_header self k v))
    (.end_headers self)
    (.write self.wfile body))

  (defn send-error-json [self status message [code None]]
    (.send-json self status {"error" {"message" message
                                      "type" "invalid_request_error"
                                      "code" code}}))

  (defn start-sse [self [headers None]]
    (.send_response self 200)
    (.send_header self "Content-Type" "text/event-stream; charset=utf-8")
    (.send_header self "Cache-Control" "no-cache")
    (.send_header self "Connection" "close")
    (.send_header self "X-Accel-Buffering" "no")
    (for [[k v] (.items (or headers {}))]
      (.send_header self k v))
    (.end_headers self)
    (setv self.close_connection True))

  (defn sse [self data [event None]]
    (setv frame (+ (if event f"event: {event}\n" "")
                   "data: " (if (isinstance data str) data (json.dumps data :ensure_ascii False))
                   "\n\n"))
    (.write self.wfile (.encode frame "utf-8"))
    (.flush self.wfile))

  (defn read-json [self]
    (setv n (int (or (.get self.headers "Content-Length") 0)))
    (when (> n MAX-BODY-BYTES)
      (.send-error-json self 413 "Request body too large." "body_too_large")
      (return None))
    (try
      (setv body (json.loads (.decode (.read self.rfile n) "utf-8")))
      (except [Exception]
        (.send-error-json self 400 "Invalid JSON in request body." "invalid_json")
        (return None)))
    (if (isinstance body dict)
        body
        (do (.send-error-json self 400 "Request body must be a JSON object." "invalid_json")
            None)))

  ;; -- routing --

  (defn route-path [self]
    (setv path (. (urlsplit self.path) path)
          m (.match PROFILE-PREFIX-RE path))
    (if m (.group m 1) path))

  (defn dispatch [self method]
    (setv path (.route-path self)
          g self.gateway)
    (when (= path "/health")
      (return (.send-json self 200 {"status" "ok" "platform" "hermes-agent"
                                    "version" g.hermes-version
                                    "runtime" "kotoba-hy"})))
    (when (not (.authorized? g (.get self.headers "Authorization")))
      (return (.send-error-json self 401 "Invalid API key." "invalid_api_key")))
    (setv run-match (.match RUN-PATH-RE path))
    (cond
      (and (= method "GET") (= path "/health/detailed")) (.health-detailed self)
      (and (= method "GET") (= path "/api/status")) (.api-status self)
      (and (= method "GET") (= path "/v1/capabilities")) (.capabilities self)
      (and (= method "GET") (= path "/v1/models")) (.models self)
      (and (= method "POST") (= path "/v1/chat/completions")) (.chat-completions self)
      (and (= method "POST") (= path "/v1/runs")) (.start-run self)
      (and run-match (= method "GET") (is (.group run-match 2) None))
      (.run-status self (.group run-match 1))
      (and run-match (= method "GET") (= (.group run-match 2) "/events"))
      (.run-events self (.group run-match 1))
      (and run-match (= method "POST") (= (.group run-match 2) "/stop"))
      (.run-stop self (.group run-match 1))
      True (.send-error-json self 404 f"No route for {method} {path}." "not_found")))

  (defn do_GET [self] (.dispatch self "GET"))
  (defn do_POST [self] (.dispatch self "POST"))

  (defn do_OPTIONS [self]
    (.send_response self 204)
    (.send_header self "Allow" "GET, POST, OPTIONS")
    (.send_header self "Content-Length" "0")
    (.end_headers self))

  ;; -- status surfaces --

  (defn health-detailed [self]
    (setv g self.gateway
          active (.active-count g.runs))
    (.send-json self 200
                {"status" "ok" "platform" "hermes-agent" "version" g.hermes-version
                 "runtime" "kotoba-hy" "gateway_state" "running"
                 "platforms" {"api_server" {"state" "connected"}}
                 "active_agents" active
                 "gateway_busy" (> active 0) "gateway_drainable" True
                 "exit_reason" None "updated_at" None "pid" (os.getpid)}))

  (defn api-status [self]
    (setv g self.gateway)
    (.send-json self 200
                {"version" g.hermes-version "gateway_running" True
                 "gateway_state" "running" "gateway_pid" (os.getpid)
                 "active_agents" (.active-count g.runs)
                 "gateway_platforms" {"api_server" {"state" "connected"}}
                 "runtime" "kotoba-hy"}))

  (defn capabilities [self]
    (setv g self.gateway)
    (.send-json self 200
                {"object" "hermes.api_server.capabilities"
                 "platform" "hermes-agent"
                 "model" g.model
                 "auth" {"type" "bearer" "required" (bool g.api-key)}
                 "runtime" {"mode" "server_agent" "tool_execution" "server"
                            "split_runtime" False
                            "implementation" f"kotoba-gateway/{__version__} (hy)"
                            "backend" g.backend.name}
                 "features" {"chat_completions" True "chat_completions_streaming" True
                             "responses_api" False "responses_streaming" False
                             "run_submission" True "run_events" True "run_stop" True
                             "session_continuity_header" "X-Hermes-Session-Id"
                             "cors" False}
                 "endpoints" (dfor [name m p] CAPABILITY-ENDPOINTS
                                   name {"method" m "path" p})}))

  (defn models [self]
    (setv model self.gateway.model)
    (.send-json self 200
                {"object" "list"
                 "data" [{"id" model "object" "model" "created" (int (time.time))
                          "owned_by" "hermes" "permission" [] "root" model "parent" None}]}))

  ;; -- runs --

  (defn start-run [self]
    (setv body (.read-json self))
    (when (is body None) (return))
    (setv user-input (.get body "input"))
    (when (not user-input)
      (return (.send-error-json self 400 "`input` is required." "missing_input")))
    (setv session-id (or (.get body "session_id")
                         (.get self.headers "X-Hermes-Session-Id")
                         None)
          g self.gateway
          run (.create g.runs session-id))
    (when (is session-id None)
      (setv run.session-id run.run-id))
    (.launch-turn g run user-input
                  (normalize-history (.get body "conversation_history"))
                  (.get body "instructions")
                  (.get body "model"))
    (.send-json self 202 {"object" "hermes.run" "run_id" run.run-id
                          "status" "queued" "session_id" run.session-id}
                {"X-Hermes-Session-Id" run.session-id}))

  (defn run-status [self run-id]
    (setv run (.get-run self.gateway.runs run-id))
    (if run
        (.send-json self 200 (.snapshot run))
        (.send-error-json self 404 f"Run {run-id} not found." "run_not_found")))

  (defn run-events [self run-id]
    (setv run (.get-run self.gateway.runs run-id))
    (when (is run None)
      (return (.send-error-json self 404 f"Run {run-id} not found." "run_not_found")))
    (.start-sse self)
    (try
      (while True
        (try
          (setv event (.get run.events :timeout KEEPALIVE-SECONDS))
          (except [queue.Empty]
            (.write self.wfile b": keepalive\n\n")
            (.flush self.wfile)
            (continue)))
        (when (is event None)
          (break))
        (.sse self event))
      (except [[BrokenPipeError ConnectionResetError]]
        ;; Client went away: stop the agent rather than burn tokens unseen.
        (.stop self.gateway.runs run-id))))

  (defn run-stop [self run-id]
    (setv run (.stop self.gateway.runs run-id))
    (if run
        (.send-json self 200 {"object" "hermes.run" "run_id" run-id
                              "status" (if (in run.status TERMINAL-STATUSES) run.status "stopping")})
        (.send-error-json self 404 f"Run {run-id} not found." "run_not_found")))

  ;; -- chat completions --

  (defn chat-completions [self]
    (setv body (.read-json self))
    (when (is body None) (return))
    (setv [instructions history user-message] (split-chat-messages (.get body "messages")))
    (when (is user-message None)
      (return (.send-error-json self 400 "The last message must be a user message."
                                "invalid_messages")))
    (setv g self.gateway
          session-id (or (.get self.headers "X-Hermes-Session-Id")
                         (.get body "session_id")
                         f"api-{(cut (. (uuid.uuid4) hex) 16)}")
          run (.create g.runs session-id)
          model (or (.get body "model") g.model))
    (.launch-turn g run user-message history instructions (.get body "model"))
    (if (.get body "stream")
        (.stream-chat self run model)
        (.blocking-chat self run model)))

  (defn chunk [self run model delta [finish None] [usage None]]
    (setv payload {"id" (+ "chatcmpl-" run.run-id) "object" "chat.completion.chunk"
                   "created" (int run.created-at) "model" model
                   "choices" [{"index" 0 "delta" delta "finish_reason" finish}]})
    (when usage (setv (get payload "usage") usage))
    payload)

  (defn chat-usage [self usage]
    (setv usage (or usage {}))
    {"prompt_tokens" (.get usage "input_tokens" 0)
     "completion_tokens" (.get usage "output_tokens" 0)
     "total_tokens" (.get usage "total_tokens" 0)})

  (defn stream-chat [self run model]
    (.start-sse self {"X-Hermes-Session-Id" run.session-id})
    (setv streamed False)
    (try
      (.sse self (.chunk self run model {"role" "assistant"}))
      (while True
        (try
          (setv event (.get run.events :timeout KEEPALIVE-SECONDS))
          (except [queue.Empty]
            (.write self.wfile b": keepalive\n\n")
            (.flush self.wfile)
            (continue)))
        (when (is event None) (break))
        (setv name (get event "event"))
        (cond
          (= name "message.delta")
          (do (setv streamed True)
              (.sse self (.chunk self run model {"content" (get event "delta")})))
          (= name "reasoning.available")
          (.sse self (.chunk self run model {"reasoning_content" (get event "text")}))
          (in name #{"tool.started" "tool.completed"})
          (.sse self {"tool" (.get event "tool")
                      "label" (or (.get event "preview") (.get event "tool"))
                      "toolCallId" (+ run.run-id ":" (str (.get event "tool")))
                      "status" (if (= name "tool.started") "running"
                                   (if (.get event "error") "failed" "completed"))}
                :event "hermes.tool.progress")
          (= name "approval.request")
          (.sse self event :event "approval.request")
          (= name "run.completed")
          (do (when (and (not streamed) (.get event "output"))
                (.sse self (.chunk self run model {"content" (get event "output")})))
              (.sse self (.chunk self run model {} "stop"
                                 (.chat-usage self (.get event "usage")))))
          (= name "run.failed")
          (.sse self {"error" {"message" (.get event "error") "type" "server_error"}})
          (= name "run.cancelled")
          (.sse self (.chunk self run model {} "stop"))))
      (.sse self "[DONE]")
      (except [[BrokenPipeError ConnectionResetError]]
        (.stop self.gateway.runs run.run-id))))

  (defn blocking-chat [self run model]
    (while True
      (setv event (.get run.events))
      (when (is event None) (break)))
    (if (= run.status "failed")
        (.send-json self 500 {"error" {"message" (or run.error "agent run failed")
                                       "type" "server_error"}}
                    {"X-Hermes-Session-Id" run.session-id})
        (.send-json self 200
                    {"id" (+ "chatcmpl-" run.run-id) "object" "chat.completion"
                     "created" (int run.created-at) "model" model
                     "choices" [{"index" 0
                                 "message" {"role" "assistant" "content" (or run.output "")}
                                 "finish_reason" "stop"}]
                     "usage" {"prompt_tokens" 0 "completion_tokens" 0 "total_tokens" 0}}
                    {"X-Hermes-Session-Id" run.session-id}))))

;; ─── Process lifecycle ───────────────────────────────────────────────────

(defn read-env-file [path]
  "Minimal KEY=VALUE reader for HERMES_HOME/.env (used only for API_SERVER_KEY)."
  (setv out {})
  (when (os.path.isfile path)
    (with [f (open path :encoding "utf-8")]
      (for [line f]
        (setv line (.strip line))
        (when (and line (not (.startswith line "#")) (in "=" line))
          (setv [k v] (.split line "=" 1)
                (get out (.strip k)) (.strip (.strip v) "\"'"))))))
  out)

(defn write-pid-file [path]
  (when path
    (os.makedirs (os.path.dirname (os.path.abspath path)) :exist_ok True)
    (with [f (open path "w" :encoding "utf-8")]
      (.write f (json.dumps {"pid" (os.getpid) "kind" "kotoba-gateway"
                             "runtime" "hy" "started_at" (time.time)})))))

(defn remove-pid-file [path]
  (when (and path (os.path.isfile path))
    (try (os.remove path) (except [OSError]))))

(defn parse-args [argv]
  (setv p (argparse.ArgumentParser :prog "kotoba-gateway"
                                   :description "Hermes API-compatible gateway (Hy)."))
  (.add_argument p "--host" :default (os.environ.get "API_SERVER_HOST" "127.0.0.1"))
  (.add_argument p "--port" :type int :default (int (os.environ.get "API_SERVER_PORT" "8642")))
  (.add_argument p "--backend" :default (os.environ.get "KOTOBA_GATEWAY_BACKEND" "hermes")
                 :choices ["hermes" "echo"])
  (.add_argument p "--pid-file" :default (os.environ.get "KOTOBA_GATEWAY_PID_FILE"))
  (.parse_args p argv))

(defn make-server [host port backend api-key]
  (setv gateway (Gateway backend api-key)
        handler (type "BoundHandler" #(Handler) {"gateway" gateway})
        server (ThreadingHTTPServer #(host port) handler))
  (setv server.daemon_threads True)
  [server gateway])

(defn main [[argv None]]
  (setv args (parse-args argv)
        home (os.path.expanduser (os.environ.get "HERMES_HOME" "~/.hermes"))
        api-key (or (os.environ.get "API_SERVER_KEY")
                    (.get (read-env-file (os.path.join home ".env")) "API_SERVER_KEY")))
  (when (and (not api-key) (not-in args.host LOOPBACK))
    (print "[kotoba-gateway] Refusing to bind a non-loopback host without API_SERVER_KEY."
           :file sys.stderr)
    (return 78))
  (setv backend (make-backend args.backend)
        [server gateway] (make-server args.host args.port backend api-key))
  (write-pid-file args.pid-file)
  (defn shutdown [signum frame]
    (.start (threading.Thread :target server.shutdown :daemon True)))
  (signal.signal signal.SIGTERM shutdown)
  (signal.signal signal.SIGINT shutdown)
  (print f"[kotoba-gateway] Hermes API on http://{args.host}:{args.port} backend={backend.name} model={gateway.model}"
         :file sys.stderr :flush True)
  (try
    (.serve_forever server)
    (finally
      (.server_close server)
      (remove-pid-file args.pid-file)))
  0)
