;; Node identity: an Ed25519 key per gateway node, named by its did:key.
;;
;; A node needs no account, registry or central authority to exist: its id is
;; derived from its public key, and everything it publishes (manifest, session
;; heads, delegated requests) is signed with that key so any peer can verify
;; it offline. `cryptography` is already a Hermes Agent dependency.

(import base64 hashlib json os time
        cryptography.exceptions [InvalidSignature]
        cryptography.hazmat.primitives [serialization]
        cryptography.hazmat.primitives.asymmetric.ed25519 [Ed25519PrivateKey
                                                           Ed25519PublicKey])

(setv B58-ALPHABET "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
      ED25519-PUB-PREFIX b"\xed\x01"   ; multicodec ed25519-pub, varint
      SIGNATURE-MAX-SKEW 300)

(defn b58encode [data]
  (setv n (int.from_bytes data "big")
        out "")
  (while (> n 0)
    (setv [n r] (divmod n 58)
          out (+ (get B58-ALPHABET r) out)))
  (+ (* "1" (- (len data) (len (.lstrip data b"\x00")))) out))

(defn b58decode [text]
  (setv n 0)
  (for [ch text]
    (setv n (+ (* n 58) (.index B58-ALPHABET ch))))
  (setv body (if (> n 0) (.to_bytes n (// (+ (.bit_length n) 7) 8) "big") b""))
  (+ (* b"\x00" (- (len text) (len (.lstrip text "1")))) body))

(defn canonical [obj]
  "Deterministic JSON bytes (sorted keys, no whitespace) — what gets hashed and signed."
  (.encode (json.dumps obj :sort_keys True :separators #("," ":") :ensure_ascii False)
           "utf-8"))

(defn b64u [data] (.rstrip (.decode (base64.urlsafe_b64encode data) "ascii") "="))
(defn unb64u [text] (base64.urlsafe_b64decode (+ text (* "=" (% (- 4 (% (len text) 4)) 4)))))

(defn did-from-public [raw-public]
  (+ "did:key:z" (b58encode (+ ED25519-PUB-PREFIX raw-public))))

(defn public-from-did [did]
  "Ed25519PublicKey for a did:key, or None if it is not an Ed25519 did:key."
  (when (not (and (isinstance did str) (.startswith did "did:key:z")))
    (return None))
  (try
    (setv raw (b58decode (cut did 9 None)))
    (except [ValueError] (return None)))
  (when (or (not (.startswith raw ED25519-PUB-PREFIX)) (!= (len raw) 34))
    (return None))
  (Ed25519PublicKey.from_public_bytes (cut raw 2 None)))

(defn verify [did message signature]
  "True when `signature` (base64url) over `message` bytes was made by `did`."
  (setv key (public-from-did did))
  (when (is key None) (return False))
  (try
    (.verify key (unb64u signature) message)
    True
    (except [[InvalidSignature ValueError TypeError]] False)))

(defn is-signed [document]
  "Verify a document signed by `sign-document`: {..., \"signer\" did, \"signature\" sig}."
  (and (isinstance document dict)
       (isinstance (.get document "signature") str)
       (verify (.get document "signer")
               (canonical (dfor [k v] (.items document) :if (!= k "signature") k v))
               (get document "signature"))))

(defn body-digest [body]
  (.hexdigest (hashlib.sha256 (or body b""))))

(defn request-message [method path timestamp body]
  "Bytes a node signs to call a peer: method, path, unix time and body hash."
  (.encode (.join "\n" [(.upper method) path (str timestamp) (body-digest body)]) "utf-8"))

(defclass NodeIdentity []
  (defn __init__ [self private-key]
    (setv self.key private-key
          raw (.public_bytes (.public_key private-key)
                             serialization.Encoding.Raw serialization.PublicFormat.Raw)
          self.did (did-from-public raw)))

  (defn [classmethod] generate [cls]
    (cls (Ed25519PrivateKey.generate)))

  (defn [classmethod] load-or-create [cls path]
    "Load the node key at `path`, creating it (mode 0600) on first run."
    (when (os.path.isfile path)
      (with [f (open path "rb")]
        (return (cls (serialization.load_pem_private_key (.read f) :password None)))))
    (setv node (.generate cls)
          pem (.private_bytes node.key serialization.Encoding.PEM
                              serialization.PrivateFormat.PKCS8
                              (serialization.NoEncryption)))
    (os.makedirs (os.path.dirname (os.path.abspath path)) :exist_ok True)
    (setv fd (os.open path (| os.O_WRONLY os.O_CREAT os.O_EXCL) 0o600))
    (with [f (os.fdopen fd "wb")]
      (.write f pem))
    node)

  (defn sign [self message]
    (b64u (.sign self.key message)))

  (defn sign-document [self document]
    "Return `document` plus signer and signature over its canonical form."
    (setv doc {#** document "signer" self.did})
    (.pop doc "signature" None)
    {#** doc "signature" (.sign self (canonical doc))})

  (defn request-headers [self method path body]
    "Headers that authenticate this node to a peer (see `verify-request`)."
    (setv ts (int (time.time)))
    {"X-Kotoba-Node" self.did
     "X-Kotoba-Timestamp" (str ts)
     "X-Kotoba-Signature" (.sign self (request-message method path ts body))}))

(defn verify-request [headers method path body [now None]]
  "The calling node's did when the signed request headers are valid, else None."
  (setv did (.get headers "X-Kotoba-Node")
        sig (.get headers "X-Kotoba-Signature")
        ts (.get headers "X-Kotoba-Timestamp"))
  (when (not (and did sig ts)) (return None))
  (try (setv ts (int ts)) (except [ValueError] (return None)))
  (when (> (abs (- (or now (time.time)) ts)) SIGNATURE-MAX-SKEW) (return None))
  (if (verify did (request-message method path ts body) sig) did None))
