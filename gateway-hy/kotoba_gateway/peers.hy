;; Peer table: who else speaks the Hermes API, verified by signature.
;;
;; Discovery and trust are separate on purpose:
;;   - discovery (static seeds + gossip over GET /v1/peers) only ever adds a
;;     peer whose signed manifest checks out against its own did:key;
;;   - trust (KOTOBA_TRUSTED_PEERS / kotoba-peers.json "trusted") decides which
;;     dids may call this node — delegate runs, read blocks, list peers.
;; Gossip can therefore spread addresses freely without spreading authority.

(import json os threading time
        urllib.request [Request urlopen]
        urllib.error [HTTPError URLError]
        kotoba_gateway.identity [signed?])

(setv MAX-PEERS 256
      HTTP-TIMEOUT 10
      MANIFEST-PATH "/.well-known/kotoba-node")

(defn split-list [text]
  (lfor part (.split (or text "") ",") :if (.strip part) (.strip part)))

(defn normalize-url [url]
  (.rstrip (.strip url) "/"))

(defclass PeerTable []
  (defn __init__ [self node path [seeds None] [trusted None]]
    (setv self.node node
          self.path path
          self.lock (threading.Lock)
          self.peers {}            ; did -> {"did" "url" "manifest" "seen_at"}
          self.seeds []
          self.trusted #{node.did})
    (setv saved (self._load))
    (.extend self.seeds (+ (.get saved "seeds" []) (or seeds [])))
    (.update self.trusted (+ (.get saved "trusted" []) (or trusted [])))
    (for [p (.get saved "peers" [])]
      (when (and (isinstance p dict) (.get p "did") (.get p "url"))
        (setv (get self.peers (get p "did")) p))))

  (defn _load [self]
    (if (os.path.isfile self.path)
        (try
          (with [f (open self.path :encoding "utf-8")] (json.load f))
          (except [ValueError] {}))
        {}))

  (defn save [self]
    (with [self.lock]
      (setv data {"seeds" (sorted (set self.seeds))
                  "trusted" (sorted (- self.trusted #{self.node.did}))
                  "peers" (lfor p (.values self.peers)
                                {"did" (get p "did") "url" (get p "url")
                                 "seen_at" (.get p "seen_at")})}))
    (os.makedirs (os.path.dirname (os.path.abspath self.path)) :exist_ok True)
    (setv tmp (+ self.path ".tmp"))
    (with [f (open tmp "w" :encoding "utf-8")] (json.dump data f :indent 2))
    (os.replace tmp self.path))

  ;; -- trust --

  (defn trusted? [self did] (in did self.trusted))

  (defn trust [self did]
    (.add self.trusted did)
    (.save self))

  ;; -- HTTP --

  (defn _request [self method url [body None] [signed True] [timeout HTTP-TIMEOUT]]
    (setv data (when (is-not body None) (.encode (json.dumps body) "utf-8"))
          req (Request url :method method :data data))
    (.add_header req "Content-Type" "application/json")
    (when signed
      (for [[k v] (.items (.request-headers self.node method (path-of url) data))]
        (.add_header req k v)))
    (urlopen req :timeout timeout))

  (defn fetch-manifest [self url]
    "A peer's verified manifest, or None. The signer must be the manifest's did."
    (try
      (with [res (._request self "GET" (+ (normalize-url url) MANIFEST-PATH) :signed False)]
        (setv manifest (json.loads (.read res))))
      (except [[HTTPError URLError OSError ValueError]] (return None)))
    (if (and (signed? manifest)
             (= (.get manifest "type") "kotoba.node")
             (= (.get manifest "did") (.get manifest "signer")))
        manifest
        None))

  (defn add-url [self url]
    "Verify and record the node at `url`. Returns its did or None."
    (setv url (normalize-url url)
          manifest (.fetch-manifest self url))
    (when (or (is manifest None) (= (get manifest "did") self.node.did))
      (return None))
    (with [self.lock]
      (when (and (not-in (get manifest "did") self.peers) (>= (len self.peers) MAX-PEERS))
        (return None))
      (setv (get self.peers (get manifest "did"))
            {"did" (get manifest "did") "url" url "manifest" manifest "seen_at" (time.time)}))
    (get manifest "did"))

  (defn get-peer [self did]
    (with [self.lock] (.get self.peers did)))

  (defn listing [self]
    "Public peer list for gossip: addresses and dids only, never trust."
    (with [self.lock]
      (lfor p (.values self.peers) {"did" (get p "did") "url" (get p "url")
                                    "seen_at" (.get p "seen_at")})))

  (defn gossip-once [self]
    "Visit seeds and known peers, learn their peers. Returns newly verified dids."
    (setv learned [])
    (for [url self.seeds]
      (setv did (.add-url self url))
      (when did (.append learned did)))
    (for [p (.listing self)]
      (try
        (with [res (._request self "GET" (+ (get p "url") "/v1/peers"))]
          (setv remote (.get (json.loads (.read res)) "peers" [])))
        (except [[HTTPError URLError OSError ValueError]] (continue)))
      (for [q remote]
        (when (and (isinstance q dict) (.get q "url") (.get q "did")
                   (!= (get q "did") self.node.did)
                   (is (.get-peer self (get q "did")) None))
          (setv did (.add-url self (get q "url")))
          ;; The listed did must be the one the address actually proves.
          (when (and did (= did (get q "did")))
            (.append learned did)))))
    (.save self)
    learned)

  (defn start-gossip [self interval]
    (defn loop []
      (while True
        (try (.gossip-once self) (except [Exception]))
        (time.sleep interval)))
    (.start (threading.Thread :target loop :name "kotoba-gossip" :daemon True)))

  ;; -- calls to a peer --

  (defn call [self did method path [body None] [timeout HTTP-TIMEOUT]]
    "Signed JSON call to peer `did`. Returns the decoded body; raises on HTTP errors."
    (setv peer (.get-peer self did))
    (when (is peer None)
      (raise (LookupError f"unknown peer {did}")))
    (with [res (._request self method (+ (get peer "url") path) body :timeout timeout)]
      (json.loads (.read res))))

  (defn fetch-block [self did cid]
    (setv peer (.get-peer self did))
    (when (is peer None) (return None))
    (try
      (with [res (._request self "GET" (+ (get peer "url") "/v1/blocks/" cid))]
        (.read res))
      (except [[HTTPError URLError OSError]] None)))

  (defn stream-events [self did run-id]
    "Yield a remote run's events (decoded dicts) until its stream closes."
    (setv peer (.get-peer self did))
    (with [res (._request self "GET" (+ (get peer "url") "/v1/runs/" run-id "/events")
                          :timeout 300)]
      (setv data-lines [])
      (for [raw res]
        (setv line (.rstrip (.decode raw "utf-8") "\r\n"))
        (cond
          (.startswith line "data: ") (.append data-lines (cut line 6 None))
          (and (= line "") data-lines)
          (do (setv payload (.join "\n" data-lines)
                    data-lines [])
              (try (yield (json.loads payload)) (except [ValueError]))))))))

(defn path-of [url]
  "Path (+ query) part of an absolute URL — what request signatures cover."
  (setv rest (get (.split url "://" 1) -1))
  (if (in "/" rest) (+ "/" (get (.split rest "/" 1) 1)) "/"))
