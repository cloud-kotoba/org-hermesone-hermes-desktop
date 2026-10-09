;; Content-addressed session ledger.
;;
;; Every completed turn becomes an immutable block named by its CID (CIDv1,
;; dag-json codec, sha2-256), chained to the session's previous turn by
;; `prev`. The session head ({session, seq, cid}) is signed by the node that
;; wrote it. A peer that knows only a head can pull the chain block by block,
;; verify every hash and signature, and hold an exact replica — no server is
;; the source of truth, the content is.

(import base64 hashlib json os threading time
        kotoba_gateway.identity [canonical is-signed])

(setv CID-PREFIX (bytes [0x01 0xa9 0x02 0x12 0x20])  ; v1, dag-json (0x0129), sha2-256, 32 bytes
      CID-RE-CHARS (set "abcdefghijklmnopqrstuvwxyz234567"))

(defn cid-of [data]
  "CIDv1 (base32, multibase prefix `b`) for canonical block bytes."
  (+ "b" (.rstrip (.lower (.decode (base64.b32encode (+ CID-PREFIX (.digest (hashlib.sha256 data))))
                                   "ascii"))
                  "=")))

(defn is-valid-cid [cid]
  (and (isinstance cid str) (.startswith cid "b") (< 50 (len cid) 70)
       (.issubset (set (cut cid 1 None)) CID-RE-CHARS)))

(defclass BlockStore []
  "Immutable blocks on disk, one file per CID. Reads re-verify the hash."
  (defn __init__ [self root]
    (setv self.root root)
    (os.makedirs root :exist_ok True))

  (defn _path [self cid] (os.path.join self.root cid))

  (defn put-bytes [self data]
    (setv cid (cid-of data)
          path (._path self cid))
    (when (not (os.path.exists path))
      (setv tmp (+ path ".tmp"))
      (with [f (open tmp "wb")] (.write f data))
      (os.replace tmp path))
    cid)

  (defn put [self obj] (.put-bytes self (canonical obj)))

  (defn get-bytes [self cid]
    "Block bytes, or None when absent or corrupted (hash mismatch)."
    (when (not (is-valid-cid cid)) (return None))
    (setv path (._path self cid))
    (when (not (os.path.isfile path)) (return None))
    (with [f (open path "rb")] (setv data (.read f)))
    (if (= (cid-of data) cid) data None))

  (defn get [self cid]
    (setv data (.get-bytes self cid))
    (if (is data None) None (json.loads data)))

  (defn has-block [self cid] (is-not (.get-bytes self cid) None)))

(defclass Ledger []
  "Per-session signed hash chains over a BlockStore."
  (defn __init__ [self blocks heads-path node]
    (setv self.blocks blocks
          self.heads-path heads-path
          self.node node
          self.lock (threading.Lock)
          self.heads (self._load)))

  (defn _load [self]
    (if (os.path.isfile self.heads-path)
        (with [f (open self.heads-path :encoding "utf-8")] (json.load f))
        {}))

  (defn _save [self]
    (setv tmp (+ self.heads-path ".tmp"))
    (with [f (open tmp "w" :encoding "utf-8")] (json.dump self.heads f))
    (os.replace tmp self.heads-path))

  (defn head [self session]
    (with [self.lock] (.get self.heads session)))

  (defn append [self session entry]
    "Append one turn to `session`'s chain and return the new signed head."
    (with [self.lock]
      (setv prev (.get self.heads session)
            seq (if prev (+ (get prev "seq") 1) 0)
            block {"type" "kotoba.turn" "session" session "seq" seq
                   "prev" (when prev (get prev "cid"))
                   "node" self.node.did "at" (time.time) #** entry}
            cid (.put self.blocks block)
            head (.sign-document self.node {"type" "kotoba.head" "session" session
                                            "seq" seq "cid" cid}))
      (setv (get self.heads session) head)
      (._save self)
      head))

  (defn history [self session]
    "The session's turns as OpenAI-style messages, oldest first."
    (setv head (.head self session)
          turns [])
    (setv cid (when head (get head "cid")))
    (while cid
      (setv block (.get self.blocks cid))
      (when (is block None) (break))
      (.append turns block)
      (setv cid (.get block "prev")))
    (setv out [])
    (for [t (reversed turns)]
      (.extend out [{"role" "user" "content" (.get t "input" "")}
                    {"role" "assistant" "content" (.get t "output" "")}]))
    out)

  (defn adopt [self head fetch-block]
    "Replicate a peer's chain: verify `head`, pull missing blocks via
    `fetch-block(cid) -> bytes|None`, check every link, then take the head.
    Returns the number of blocks fetched; raises ValueError on any mismatch."
    (when (not (and (is-signed head) (= (.get head "type") "kotoba.head")))
      (raise (ValueError "head signature is invalid")))
    (setv session (get head "session")
          cid (get head "cid")
          expected-seq (get head "seq")
          fetched 0)
    (while cid
      (setv data (.get-bytes self.blocks cid))
      (when (is data None)
        (setv data (fetch-block cid))
        (when (or (is data None) (!= (cid-of data) cid))
          (raise (ValueError f"block {cid} is missing or does not match its CID")))
        (.put-bytes self.blocks data)
        (+= fetched 1))
      (setv block (json.loads data))
      (when (or (!= (.get block "session") session) (!= (.get block "seq") expected-seq))
        (raise (ValueError f"block {cid} is not seq {expected-seq} of {session}")))
      (setv cid (.get block "prev")
            expected-seq (- expected-seq 1)))
    (with [self.lock]
      (setv current (.get self.heads session))
      (when (or (is current None) (> (get head "seq") (get current "seq")))
        (setv (get self.heads session) head)
        (._save self)))
    fetched))
