;; Lease client: which profiles this node may tick, as granted by the murakumo
;; control plane (cloud-murakumo `profiles-http`, profile distribution phase 3).
;;
;; Every interval the node posts a heartbeat signed with its Ed25519 did:key
;; and the leases it holds; the answer is its lease set. A profile may be
;; ticked only while its lease is unexpired on THIS node's clock. Server
;; expiry is converted to local time from the server's own `now`, so clock
;; skew cannot stretch a lease. When heartbeats fail, held leases simply run
;; out and the node stops ticking those profiles: it cannot tell a partition
;; from a control-plane outage, so it fails closed.

(import json sys threading time
        urllib.request [Request urlopen]
        urllib.error [HTTPError URLError]
        urllib.parse [urlsplit]
        kotoba_gateway.identity [body-digest])

(setv SIGNING-DOMAIN "murakumo-profile-lease-v1"
      DEFAULT-INTERVAL-SECONDS 120)

(defn signing-input [did endpoint body-sha256]
  "Bytes signed for a lease heartbeat; must match profiles-http/signing-input."
  (.encode (+ SIGNING-DOMAIN "\n" did "\n" endpoint "\n" body-sha256 "\n") "utf-8"))

(defn http-post [url body headers [timeout 15]]
  "[status decoded-json-or-None] for a POST; network errors raise."
  (setv req (Request url :method "POST" :data body))
  (for [[k v] (.items headers)] (.add_header req k v))
  (try
    (with [res (urlopen req :timeout timeout)]
      [res.status (json.loads (.read res))])
    (except [e HTTPError]
      [e.code (try (json.loads (.read e)) (except [Exception] None))])))

(defclass LeaseClient []
  (defn __init__ [self base-url node [caps None] [capacity None]
                  [interval DEFAULT-INTERVAL-SECONDS] [clock time.time] [post http-post]
                  [on-change None] [endpoint None]]
    ;; `endpoint` is the origin the signature binds; it defaults to the URL's
    ;; own origin and is overridden only for a local stand-in of the plane.
    (setv parts (urlsplit base-url)
          self.endpoint (or endpoint f"{parts.scheme}://{parts.netloc}")
          self.url (+ (.rstrip base-url "/") "/api/profiles/nodes/" node.did "/heartbeat")
          self.node node
          self.caps (or caps [])
          self.capacity (or capacity {})
          self.interval interval
          self.clock clock
          self.post post
          self.on-change on-change
          self.lock (threading.Lock)
          self.leases {}          ; profile -> {"epoch" n "expires" local-epoch-seconds}
          self.last-observed 0
          self.last-ok None
          self.last-error None))

  (defn held [self]
    (with [self.lock]
      (lfor [p l] (.items self.leases) {"profile" p "epoch" (get l "epoch")})))

  (defn allows [self profile [now None]]
    "May this node tick `profile` right now?"
    (setv now (or now (self.clock)))
    (with [self.lock]
      (setv l (.get self.leases profile)))
    (and (is-not l None) (< now (get l "expires"))))

  (defn allowed-set [self [now None]]
    (setv now (or now (self.clock)))
    (with [self.lock]
      (sfor [p l] (.items self.leases) :if (< now (get l "expires")) p)))

  (defn body [self]
    "The heartbeat body; observed_at_ms strictly grows (replay guard)."
    (setv ms (max (int (* 1000 (self.clock))) (+ self.last-observed 1))
          self.last-observed ms)
    (.encode (json.dumps {"observed_at_ms" ms "held" (.held self)
                          "caps" self.caps "capacity" self.capacity}
                         :separators #("," ":"))
             "utf-8"))

  (defn heartbeat [self]
    "One heartbeat. Returns True when the lease set was refreshed."
    (setv raw (.body self)
          sig (.sign self.node (signing-input self.node.did self.endpoint (body-digest raw)))
          sent-at (self.clock))
    (try
      (setv [status reply] (self.post self.url raw {"content-type" "application/json"
                                                   "x-murakumo-signature" sig}))
      (except [e [URLError OSError]]
        (setv self.last-error f"unreachable: {e}")
        (return False)))
    (when (or (!= status 200) (not (isinstance reply dict)))
      (setv reason (when (isinstance reply dict) (.get reply "error"))
            self.last-error f"HTTP {status}: {reason}")
      (return False))
    ;; Expiry on our clock: (server expires - server now), counted from when
    ;; we SENT the request, so request latency only shortens the lease.
    (setv server-now (/ (.get reply "now" 0) 1000)
          fresh (dfor l (.get reply "leases" [])
                      (get l "profile")
                      {"epoch" (get l "epoch")
                       "expires" (+ sent-at (- (/ (get l "expires_at") 1000) server-now))}))
    (with [self.lock]
      (setv before (set (.keys self.leases))
            self.leases fresh))
    (setv self.last-ok (self.clock) self.last-error None)
    (when (and self.on-change (!= before (set (.keys fresh))))
      (self.on-change (set (.keys fresh))))
    True)

  (defn run-forever [self stop-event]
    (while (not (.is-set stop-event))
      (try (.heartbeat self)
           (except [e Exception]
             (setv self.last-error (repr e))
             (print f"[kotoba-lease] heartbeat failed: {e !r}" :file sys.stderr)))
      (.wait stop-event self.interval)))

  (defn start [self]
    (setv stop (threading.Event))
    (.start (threading.Thread :target self.run-forever :args #(stop)
                              :name "kotoba-lease" :daemon True))
    stop)

  (defn status [self]
    (setv now (self.clock))
    {"endpoint" self.endpoint
     "held" (len (.allowed-set self now))
     "last_ok_seconds_ago" (when self.last-ok (round (- now self.last-ok) 1))
     "last_error" self.last-error}))
