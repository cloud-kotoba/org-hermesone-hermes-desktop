;; Agent backends behind the Hermes API surface.
;;
;; `HermesBackend` builds a Hermes Agent `AIAgent` in-process the same way the
;; upstream api_server's `_create_agent` does (runtime provider resolution,
;; platform toolsets, SessionDB persistence), so sessions written here show up
;; in `hermes sessions` and the desktop's session list unchanged.
;;
;; `EchoBackend` needs no Hermes install; tests and smoke runs use it.

(import os sys threading time)

(setv USAGE-FIELDS [["input_tokens" "session_prompt_tokens"]
                    ["output_tokens" "session_completion_tokens"]
                    ["total_tokens" "session_total_tokens"]])

(setv PREVIEW-MAX-CHARS 500)

(defn clip [value [limit PREVIEW-MAX-CHARS]]
  (setv text (if (is value None) "" (str value)))
  (if (> (len text) limit) (+ (cut text limit) "…") text))

(defn usage-of [agent]
  (dfor [wire attr] USAGE-FIELDS
        wire (or (getattr agent attr 0) 0)))

(defclass Callbacks []
  "Sink for one turn. Every hook defaults to a no-op."
  (defn __init__ [self #** hooks]
    (setv self.on-delta (.get hooks "on_delta" (fn [d] None))
          self.on-reasoning (.get hooks "on_reasoning" (fn [t] None))
          self.on-tool (.get hooks "on_tool" (fn [e] None))
          self.on-approval (.get hooks "on_approval" (fn [e] None))
          self.on-agent (.get hooks "on_agent" (fn [a] None)))))

;; ─── Echo backend ────────────────────────────────────────────────────────

(defclass EchoBackend []
  (setv name "echo")

  (defn model-name [self] "kotoba-echo")
  (defn version [self] "kotoba-echo")
  (defn ready [self] True)

  (defn run-turn [self #** turn]
    (setv cb (get turn "callbacks")
          text (+ "echo: " (str (get turn "user_message"))))
    (.on-tool cb {"event" "tool.started" "tool" "echo" "preview" "echo"})
    (for [word (.split text " ")]
      (.on-delta cb (+ word " "))
      (time.sleep 0.005))
    (.on-tool cb {"event" "tool.completed" "tool" "echo" "duration" 0.0
                  "error" False "preview" "ok"})
    {"final_response" (.rstrip (+ text " "))
     "completed" True
     "usage" {"input_tokens" 0 "output_tokens" 0 "total_tokens" 0}}))

;; ─── Hermes backend ──────────────────────────────────────────────────────

(defn ensure-hermes-path []
  "Make the Hermes Agent checkout importable (desktop spawns us with cwd=HERMES_REPO)."
  (setv repo (or (os.environ.get "HERMES_REPO") (os.getcwd)))
  (when (and (os.path.isfile (os.path.join repo "run_agent.py"))
             (not-in repo sys.path))
    (.insert sys.path 0 repo)))

(defclass HermesBackend []
  (setv name "hermes")

  (defn __init__ [self]
    (ensure-hermes-path)
    ;; Fail fast at startup, not on the first chat.
    (import run_agent)
    (setv self.db-lock (threading.Lock)
          self.session-db None))

  (defn version [self]
    (try
      (import hermes_cli.version_info [get_version_info])
      (. (get_version_info) base_version)
      (except [Exception] "unknown")))

  (defn model-name [self]
    (try
      (import gateway.run [_resolve_gateway_model])
      (or (_resolve_gateway_model) "hermes-agent")
      (except [Exception] "hermes-agent")))

  (defn ready [self] True)

  (defn _db [self]
    (with [self.db-lock]
      (when (is self.session-db None)
        (try
          (import hermes_constants [get_hermes_home]
                  hermes_state_registry [acquire])
          (setv self.session-db (acquire (/ (get_hermes_home) "state.db")))
          (except [e Exception]
            (print f"[kotoba-gateway] SessionDB unavailable: {e}" :file sys.stderr))))
      self.session-db))

  (defn _create-agent [self session-id requested-model instructions cb]
    (import run_agent [AIAgent]
            gateway.run [_checkpoint_agent_kwargs _current_max_iterations
                         _load_gateway_config _resolve_gateway_model
                         _resolve_runtime_agent_kwargs GatewayRunner]
            hermes_cli.tools_config [_get_platform_tools])
    (setv runtime (_resolve_runtime_agent_kwargs)
          configured (or (.pop runtime "model" None) (_resolve_gateway_model))
          model (if (and requested-model (!= requested-model "hermes-agent"))
                    requested-model
                    configured)
          config (_load_gateway_config))
    (.pop runtime "_fallback_notice" None)

    (defn tool-progress [event-type [tool-name None] [preview None] [args None] #** kw]
      (cond
        (= event-type "tool.started")
        (.on-tool cb {"event" "tool.started" "tool" tool-name "preview" (clip preview)})
        (= event-type "tool.completed")
        (.on-tool cb {"event" "tool.completed" "tool" tool-name
                      "duration" (round (or (.get kw "duration") 0) 3)
                      "error" (bool (.get kw "is_error" False))
                      "preview" (clip (.get kw "result"))})
        (= event-type "reasoning.available")
        (.on-reasoning cb (or preview ""))))

    (setv agent
          (AIAgent :model model
                   #** runtime
                   #** (_checkpoint_agent_kwargs config)
                   :max_iterations (_current_max_iterations)
                   :quiet_mode True
                   :verbose_logging False
                   :ephemeral_system_prompt (or instructions None)
                   :enabled_toolsets (sorted (_get_platform_tools config "api_server"))
                   :session_id session-id
                   :platform "api_server"
                   :stream_delta_callback (fn [d] (when d (.on-delta cb d)))
                   :tool_progress_callback tool-progress
                   :reasoning_callback (fn [t #* _] (when t (.on-reasoning cb t)))
                   :session_db (._db self)
                   :fallback_model (GatewayRunner._load_fallback_model)
                   :reasoning_config (GatewayRunner._load_reasoning_config model)))
    (.on-agent cb agent)
    agent)

  (defn run-turn [self #** turn]
    (setv cb (get turn "callbacks")
          session-id (.get turn "session_id")
          approval-key (or session-id (.get turn "run_id") "kotoba"))
    (import tools.approval [register_gateway_notify unregister_gateway_notify]
            tools.approval_context [set_current_session_key reset_current_session_key])
    (setv token (set_current_session_key approval-key))
    (register_gateway_notify approval-key (fn [data] (.on-approval cb data)))
    (try
      (setv agent (._create-agent self session-id (.get turn "model")
                                  (.get turn "instructions") cb)
            result (.run_conversation agent
                                      :user_message (get turn "user_message")
                                      :conversation_history (or (.get turn "history") [])
                                      :task_id (or session-id (.get turn "run_id"))))
      (setv (get result "usage") (usage-of agent))
      result
      (finally
        (unregister_gateway_notify approval-key)
        (reset_current_session_key token)))))

(defn make-backend [name]
  (if (= name "echo") (EchoBackend) (HermesBackend)))
