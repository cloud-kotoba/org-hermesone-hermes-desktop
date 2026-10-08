;; Decentralized operation: three echo-backed nodes, each with its own key,
;; ledger and peer table, talking only to each other over HTTP.

(import json os tempfile threading time unittest
        urllib.request [Request urlopen]
        urllib.error [HTTPError])
(import kotoba_gateway.backend [EchoBackend]
        kotoba_gateway.identity [NodeIdentity canonical is-signed verify-request]
        kotoba_gateway.ledger [BlockStore Ledger cid-of]
        kotoba_gateway.server [make-server])

(setv KEY "mesh-key-0123456789abcdef")

(defclass Node []
  (defn __init__ [self]
    (setv self.state (tempfile.TemporaryDirectory)
          [self.server self.gateway] (make-server "127.0.0.1" 0 (EchoBackend) KEY
                                                  :state-dir self.state.name)
          self.url self.gateway.public-url
          self.did self.gateway.node.did)
    (.start (threading.Thread :target self.server.serve_forever :daemon True)))

  (defn close [self]
    (.shutdown self.server)
    (.server_close self.server)
    (.cleanup self.state))

  (defn call [self method path [body None] [key KEY]]
    (setv req (Request (+ self.url path) :method method
                       :data (when (is-not body None) (.encode (json.dumps body)))))
    (.add_header req "Content-Type" "application/json")
    (when key (.add_header req "Authorization" (+ "Bearer " key)))
    (with [res (urlopen req :timeout 15)]
      (setv raw (.decode (.read res) "utf-8")))
    (try (json.loads raw) (except [ValueError] raw))))

(defn introduce [a b]
  "a learns b's address and trusts b; b trusts a."
  (.call a "POST" "/v1/peers" {"url" b.url "trust" b.did})
  (.call b "POST" "/v1/peers" {"trust" a.did}))

(defclass Mesh [unittest.TestCase]
  (defn setUp [self]
    (setv self.a (Node) self.b (Node) self.c (Node)))

  (defn tearDown [self]
    (for [n [self.a self.b self.c]] (.close n)))

  ;; @lat: [[gateway-hy#Tests#Manifest is self-certifying]]
  (defn test-manifest-is-self-certifying [self]
    (setv m (.call self.a "GET" "/.well-known/kotoba-node" :key None))
    (.assertTrue self (is-signed m))
    (.assertEqual self (get m "did") self.a.did)
    (setv (get m "model") "forged")
    (.assertFalse self (is-signed m)))

  ;; @lat: [[gateway-hy#Tests#Untrusted nodes are refused]]
  (defn test-untrusted-nodes-are-refused [self]
    ;; b knows a's address but never trusted it: a's signed call is a 401.
    (.call self.a "POST" "/v1/peers" {"url" self.b.url})
    (with [ctx (.assertRaises self HTTPError)]
      (.call self.a.gateway.peers self.b.did "GET" "/v1/peers"))
    (.assertEqual self ctx.exception.code 401))

  ;; @lat: [[gateway-hy#Tests#Delegated run replicates the session]]
  (defn test-delegated-run-replicates-the-session [self]
    (introduce self.a self.b)
    (setv started (.call self.a "POST" "/v1/runs"
                         {"input" "far away" "session_id" "s-1" "peer" self.b.did})
          raw (.call self.a "GET" (+ "/v1/runs/" (get started "run_id") "/events"))
          events (lfor block (.split raw "\n\n") :if (.startswith block "data: ")
                       (json.loads (cut block 6 None)))
          last (get events -1))
    (.assertEqual self (get last "event") "run.completed")
    (.assertEqual self (get last "output") "echo: far away")
    (.assertEqual self (get last "node") self.b.did)
    ;; b wrote and signed the turn; a holds a verified replica of the chain.
    (setv head-b (.call self.b "GET" "/v1/sessions/s-1/head")
          head-a (.call self.a "GET" "/v1/sessions/s-1/head"))
    (.assertEqual self (get head-a "cid") (get head-b "cid"))
    (.assertEqual self (get head-a "signer") self.b.did)
    (.assertEqual self (.history self.a.gateway.ledger "s-1")
                  [{"role" "user" "content" "far away"}
                   {"role" "assistant" "content" "echo: far away"}]))

  ;; @lat: [[gateway-hy#Tests#A session continues on another node]]
  (defn test-session-continues-on-another-node [self]
    (introduce self.a self.b)
    (.call self.a "POST" "/v1/runs" {"input" "one" "session_id" "s-2" "peer" self.b.did})
    (for [_ (range 100)]
      (when (.head self.a.gateway.ledger "s-2") (break))
      (time.sleep 0.05))
    ;; The next turn runs locally on a, extending the replicated chain.
    (setv started (.call self.a "POST" "/v1/runs" {"input" "two" "session_id" "s-2"}))
    (.call self.a "GET" (+ "/v1/runs/" (get started "run_id") "/events"))
    (setv head (.call self.a "GET" "/v1/sessions/s-2/head")
          block (json.loads (.get-bytes self.a.gateway.ledger.blocks (get head "cid"))))
    (.assertEqual self (get head "seq") 1)
    (.assertEqual self (get head "signer") self.a.did)
    (.assertIsNotNone self (get block "prev")))

  ;; @lat: [[gateway-hy#Tests#Gossip spreads addresses not trust]]
  (defn test-gossip-spreads-addresses-not-trust [self]
    (introduce self.a self.b)
    (introduce self.b self.c)
    (setv learned (.gossip-once self.a.gateway.peers))
    (.assertIn self self.c.did learned)
    (.assertFalse self (.is-trusted self.a.gateway.peers self.c.did)))

  ;; @lat: [[gateway-hy#Tests#Delegation is one hop and local only]]
  (defn test-delegation-is-local-only [self]
    (introduce self.a self.b)
    (with [ctx (.assertRaises self HTTPError)]
      (.call self.a.gateway.peers self.b.did "POST" "/v1/runs"
             {"input" "x" "peer" self.a.did}))
    (.assertEqual self ctx.exception.code 403)))

(defclass LedgerIntegrity [unittest.TestCase]
  ;; @lat: [[gateway-hy#Tests#Tampered blocks are rejected]]
  (defn test-tampered-blocks-are-rejected [self]
    (with [d (tempfile.TemporaryDirectory)]
      (setv node (NodeIdentity.generate)
            src (Ledger (BlockStore (os.path.join d "a")) (os.path.join d "a.json") node)
            dst (Ledger (BlockStore (os.path.join d "b")) (os.path.join d "b.json")
                        (NodeIdentity.generate))
            head (.append src "s" {"input" "hi" "output" "yo"}))
      (with [ctx (.assertRaises self ValueError)]
        (.adopt dst head (fn [cid] (canonical {"session" "s" "seq" 0 "forged" True}))))
      (.assertIn self "does not match" (str ctx.exception))
      (.assertEqual self (.adopt dst head (fn [cid] (.get-bytes src.blocks cid))) 1)
      (setv (get head "seq") 7)
      (with [ctx (.assertRaises self ValueError)]
        (.adopt dst head (fn [cid] None)))))

  ;; @lat: [[gateway-hy#Tests#Signed requests expire and bind the body]]
  (defn test-signed-requests [self]
    (setv node (NodeIdentity.generate)
          h (.request-headers node "POST" "/v1/runs" b"{}"))
    (.assertEqual self (verify-request h "POST" "/v1/runs" b"{}") node.did)
    (.assertIsNone self (verify-request h "POST" "/v1/runs" b"{\"x\":1}"))
    (.assertIsNone self (verify-request h "POST" "/v1/peers" b"{}"))
    (.assertIsNone self (verify-request h "POST" "/v1/runs" b"{}" :now (+ (time.time) 3600)))))

(when (= __name__ "__main__")
  (unittest.main))
