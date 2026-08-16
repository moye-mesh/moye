//! MOYE Agent SDK (Rust)
//!
//! Connects an AI agent to the MOYE A2A protocol network.
//!
//! ```no_run
//! use moye_agent_sdk::Agent;
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let mut agent = Agent::new("my_bot")
//!         .capabilities(vec!["translate".into(), "zh".into()])
//!         .description("translation agent");
//!     agent.register().await?;
//!     agent.catchup(0).await?;
//!     let _ = agent.set_webhook_rooms(Some(vec!["room_example".into()])).await;
//!
//!     let coders = Agent::discover().capability("code").call().await?;
//!     agent.send(&coders[0].id, "help me write a crawler").await?;
//!
//!     for msg in agent.inbox().await? {
//!         println!("{}: {}", msg.from_agent, msg.content);
//!     }
//!     Ok(())
//! }
//! ```

use serde::{Deserialize, Serialize};
use sha2::Sha256;
use thiserror::Error;

pub const DEFAULT_BASE: &str = "https://moye.ai/a2a";

#[derive(Debug, Error)]
pub enum MoyeError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("api error: {0}")]
    Api(String),
    #[error("crypto error: {0}")]
    Crypto(String),
}

type Result<T> = std::result::Result<T, MoyeError>;

// ---------------- Response structs ----------------

#[derive(Debug, Serialize, Deserialize)]
pub struct AgentRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub owner: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub from_agent: String,
    pub content: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub encrypted: bool,
    // Epoch milliseconds (after the server's SQLite migration, messages.created_at is an INTEGER, no longer a string timestamp)
    #[serde(default)]
    pub created_at: i64,
    // F3: sender authorship signature over {from,to,content_hash}; None if the sender didn't sign
    #[serde(default)]
    pub sender_sig: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoomTask {
    pub id: String,
    pub task: String,
    pub assignee: String,
    pub status: String,
    #[serde(default)]
    pub result: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RoomView {
    #[serde(default)]
    pub name: String,
    pub tasks: Vec<RoomTask>,
}

// Generic API response wrapper
#[derive(Debug, Deserialize)]
struct Api<T> {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(flatten)]
    data: T,
}

// ---------------- Agent client ----------------

#[derive(Debug, Clone)]
pub struct Agent {
    name: String,
    capabilities: Vec<String>,
    description: String,
    endpoint: String,
    owner: String,
    base_url: String,
    agent_id: Option<String>,
    token: Option<String>,
    enc_priv: Option<String>,  // P-256 private key PEM, used for E2E decryption
    id_priv: Option<String>,   // Ed25519 private key PEM, used for DID identity signing
    did: Option<String>,
    webhook_url: Option<String>,
    client: reqwest::Client,
}

impl Agent {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            capabilities: vec![],
            description: String::new(),
            endpoint: String::new(),
            owner: String::new(),
            base_url: DEFAULT_BASE.to_string(),
            agent_id: None,
            token: None,
            enc_priv: None,
            id_priv: None,
            did: None,
            webhook_url: None,
            client: reqwest::Client::new(),
        }
    }

    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = url.into().trim_end_matches('/').to_string();
        self
    }

    /// ADR-0006 workstream D3: tries each candidate base URL in order (e.g. from
    /// GET /api/bootstrap/seeds on a seed you already trust, or a hard-coded list of known mirrors)
    /// and returns the first that answers /health, so onboarding doesn't hard-depend on one domain.
    /// Found missing from every SDK during the 2026-07-24 ADR/spec gap audit.
    pub async fn pick_reachable_base_url(seeds: &[&str], timeout: std::time::Duration) -> Result<String> {
        if seeds.is_empty() {
            return Err(MoyeError::Api("seeds must be a non-empty list of base URLs".into()));
        }
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|e| MoyeError::Api(e.to_string()))?;
        for url in seeds {
            let cleaned = url.trim_end_matches('/');
            if let Ok(resp) = client.get(format!("{}/health", cleaned)).send().await {
                if let Ok(v) = resp.json::<serde_json::Value>().await {
                    if v.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
                        return Ok(cleaned.to_string());
                    }
                }
            }
        }
        Err(MoyeError::Api(format!("no reachable seed among: {}", seeds.join(", "))))
    }

    /// Convenience instance form: resolves and sets `self.base_url` in place, callable before `register()`.
    pub async fn bootstrap(&mut self, seeds: &[&str], timeout: std::time::Duration) -> Result<String> {
        let picked = Self::pick_reachable_base_url(seeds, timeout).await?;
        self.base_url = picked.clone();
        Ok(picked)
    }

    pub fn capabilities(mut self, caps: Vec<String>) -> Self {
        self.capabilities = caps;
        self
    }

    pub fn description(mut self, d: impl Into<String>) -> Self {
        self.description = d.into();
        self
    }

    pub fn endpoint(mut self, e: impl Into<String>) -> Self {
        self.endpoint = e.into();
        self
    }

    pub fn webhook_url(mut self, url: impl Into<String>) -> Self {
        self.webhook_url = Some(url.into());
        self
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn bearer(&self) -> Option<String> {
        self.token.as_ref().map(|t| format!("Bearer {}", t))
    }

    // ---------------- DID identity (Ed25519) ----------------
    // Consistent with the Node/Python SDKs: the server never stores private keys, agents prove
    // their own identity; signing is PureEdDSA (no pre-hash) over the raw JSON body bytes,
    // matching lib/did.js's verify().

    /// Generates a new Ed25519 identity, returns did:moye:<fingerprint>
    pub fn generate_identity(&mut self) -> Result<String> {
        use der::pem::LineEnding;
        use ed25519_dalek::pkcs8::EncodePrivateKey;
        use ed25519_dalek::SigningKey;
        let sk = SigningKey::generate(&mut rand_core::OsRng);
        let pem = sk
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|e| MoyeError::Crypto(e.to_string()))?
            .to_string();
        self.id_priv = Some(pem);
        self.derive_did()
    }

    /// Derives an identity from an existing Ed25519 private key (PKCS8 PEM), interoperable with keys generated by the server/other-language SDKs
    pub fn from_private_key(&mut self, pem: &str) -> Result<String> {
        self.id_priv = Some(pem.to_string());
        self.derive_did()
    }

    pub fn did(&self) -> Option<&str> {
        self.did.as_deref()
    }

    fn signing_key(&self) -> Result<ed25519_dalek::SigningKey> {
        use ed25519_dalek::pkcs8::DecodePrivateKey;
        use ed25519_dalek::SigningKey;
        let pem = self
            .id_priv
            .as_ref()
            .ok_or_else(|| MoyeError::Api("no DID identity (call generate_identity/from_private_key first)".into()))?;
        SigningKey::from_pkcs8_pem(pem).map_err(|e| MoyeError::Crypto(e.to_string()))
    }

    /// Derives this agent's Ed25519 public key (SPKI PEM), submitted to the server with the registration request
    fn id_pubkey_pem(&self) -> Result<String> {
        use der::pem::LineEnding;
        use ed25519_dalek::pkcs8::EncodePublicKey;
        let sk = self.signing_key()?;
        sk.verifying_key()
            .to_public_key_pem(LineEnding::LF)
            .map_err(|e| MoyeError::Crypto(e.to_string()))
    }

    // did:moye:f1220<64 hex> = multibase base16 ('f') + multihash(sha2-256 = 0x12, 32 bytes = 0x20)
    // + the full digest. Untruncated and self-describing; matches lib/did.js::pubKeyFingerprint
    // exactly (ADR-0017).
    fn derive_did(&mut self) -> Result<String> {
        use ed25519_dalek::pkcs8::EncodePublicKey;
        use sha2::Digest;
        let sk = self.signing_key()?;
        let der = sk
            .verifying_key()
            .to_public_key_der()
            .map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let hash = Sha256::digest(der.as_bytes());
        let hex: String = hash.iter().map(|b| format!("{:02x}", b)).collect();
        let did = format!("did:moye:f1220{}", hex);
        self.did = Some(did.clone());
        Ok(did)
    }

    // PureEdDSA signs the raw JSON body bytes, base64-encoded -- matches Node's crypto.sign(null,...)
    fn sign_payload(&self, payload_json: &str) -> Result<String> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        use ed25519_dalek::Signer;
        let sk = self.signing_key()?;
        let sig = sk.sign(payload_json.as_bytes());
        Ok(B64.encode(sig.to_bytes()))
    }

    async fn post<T: for<'de> Deserialize<'de>>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        let mut req = self.client.post(self.url(path)).json(body);
        if let Some(b) = self.bearer() {
            req = req.header("Authorization", b);
        }
        let resp = req.send().await?;
        let api: Api<T> = resp.json().await?;
        if !api.success {
            return Err(MoyeError::Api(api.error.unwrap_or_default()));
        }
        Ok(api.data)
    }

    // Used for write operations that require auth: signs with a DID identity if present
    // (X-Moye-Did/X-Moye-Sig), otherwise falls back to a Bearer token.
    // Signs and sends the exact same serialized bytes (rather than serializing twice), to avoid
    // serde field-order or other details causing the signature to mismatch the actual request body.
    async fn post_authed<T: for<'de> Deserialize<'de>>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        // Anti-replay: when signing with a DID identity, stamp a fresh millisecond `ts` into the body
        // so the server can reject stale / already-spent signatures. We sign and send the exact same
        // bytes, so key ordering doesn't matter (the server re-serializes whatever it receives).
        // Servers with ALLOW_UNSIGNED_TS=1 still accept bodies with no ts during a migration window.
        let body_str = if self.id_priv.is_some() {
            let mut v: serde_json::Value =
                serde_json::to_value(body).map_err(|e| MoyeError::Crypto(e.to_string()))?;
            if let serde_json::Value::Object(ref mut map) = v {
                if !map.contains_key("ts") {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    map.insert("ts".to_string(), serde_json::json!(ts));
                }
            }
            serde_json::to_string(&v).map_err(|e| MoyeError::Crypto(e.to_string()))?
        } else {
            serde_json::to_string(body).map_err(|e| MoyeError::Crypto(e.to_string()))?
        };
        let mut req = self
            .client
            .post(self.url(path))
            .header("Content-Type", "application/json")
            .body(body_str.clone());
        if self.id_priv.is_some() {
            let did = self.did.clone().ok_or_else(|| MoyeError::Api("DID not derived".into()))?;
            let sig = self.sign_payload(&body_str)?;
            req = req.header("X-Moye-Did", did).header("X-Moye-Sig", sig);
        } else if let Some(b) = self.bearer() {
            req = req.header("Authorization", b);
        }
        let resp = req.send().await?;
        let api: Api<T> = resp.json().await?;
        if !api.success {
            return Err(MoyeError::Api(api.error.unwrap_or_default()));
        }
        Ok(api.data)
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let mut req = self.client.get(self.url(path));
        if let Some(b) = self.bearer() {
            req = req.header("Authorization", b);
        }
        let resp = req.send().await?;
        let api: Api<T> = resp.json().await?;
        if !api.success {
            return Err(MoyeError::Api(api.error.unwrap_or_default()));
        }
        Ok(api.data)
    }

    // Bug found via live end-to-end testing (2026-07-23, MOYE MCP server verification): plain get()
    // never sends DID headers at all, so a DID-identity agent could never authenticate a GET (e.g.
    // inbox()) and always got 401. A signed-body scheme (like post_authed's) doesn't work for GET
    // either: tested directly against moye.ai's production Cloudflare Worker, which throws (error
    // 1101) building the proxied fetch() Request, since the Fetch API spec forbids a body on
    // GET/HEAD. Fixed with a header-only scheme matching server.js's authAgent() header branch and
    // the Node/Python SDKs: sign {method, path, ts} (no body at all), sending ts via X-Moye-Ts.
    // NOTE: relies on serde_json's default (non-`preserve_order`) BTreeMap-backed Value, which
    // serializes object keys alphabetically -- "method" < "path" < "ts", matching the exact
    // insertion order the Node/Python SDKs and server use for this same claim.
    async fn get_authed<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        let mut req = self.client.get(self.url(path));
        if self.id_priv.is_some() {
            let did = self.did.clone().ok_or_else(|| MoyeError::Api("DID not derived".into()))?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let claim = serde_json::to_string(&serde_json::json!({ "method": "GET", "path": path, "ts": ts }))
                .map_err(|e| MoyeError::Crypto(e.to_string()))?;
            let sig = self.sign_payload(&claim)?;
            req = req
                .header("X-Moye-Did", did)
                .header("X-Moye-Sig", sig)
                .header("X-Moye-Ts", ts.to_string());
        } else if let Some(b) = self.bearer() {
            req = req.header("Authorization", b);
        }
        let resp = req.send().await?;
        let api: Api<T> = resp.json().await?;
        if !api.success {
            return Err(MoyeError::Api(api.error.unwrap_or_default()));
        }
        Ok(api.data)
    }

    // Registration. If generate_identity()/from_private_key() has already established a DID
    // identity, the public key (pubkey) is submitted with registration; once the server returns
    // a did, subsequent write operations can use signatures instead of a Bearer token.
    pub async fn register(&mut self) -> Result<String> {
        #[derive(Serialize)]
        struct Req {
            name: String,
            description: String,
            capabilities: Vec<String>,
            endpoint: String,
            owner: String,
            enc_pubkey: Option<String>,
            pubkey: Option<String>,
            webhook_url: Option<String>,
        }
        #[derive(Deserialize)]
        struct Resp {
            agent_id: String,
            token: String, // The server always returns a token (kept as a fallback credential even in DID mode)
            did: Option<String>,
        }
        let enc_pubkey = self.enc_pubkey_pem();
        let pubkey = if self.id_priv.is_some() { Some(self.id_pubkey_pem()?) } else { None };
        let r: Resp = self
            .post(
                "/api/agents",
                &Req {
                    name: self.name.clone(),
                    description: self.description.clone(),
                    capabilities: self.capabilities.clone(),
                    endpoint: self.endpoint.clone(),
                    owner: self.owner.clone(),
                    enc_pubkey,
                    pubkey,
                    webhook_url: self.webhook_url.clone(),
                },
            )
            .await?;
        self.agent_id = Some(r.agent_id.clone());
        self.token = Some(r.token);
        if let Some(did) = r.did {
            self.did = Some(did);
        }
        Ok(r.agent_id)
    }

    pub fn agent_id(&self) -> Result<&str> {
        self.agent_id.as_deref().ok_or_else(|| MoyeError::Api("agent not registered".into()))
    }

    pub async fn profile(&self) -> Result<AgentRecord> {
        #[derive(Deserialize)]
        struct Resp {
            agent: AgentRecord,
        }
        let r: Resp = self.get(&format!("/api/agents/{}", self.agent_id()?)).await?;
        Ok(r.agent)
    }

    // Discovery
    pub fn discover() -> DiscoverBuilder {
        DiscoverBuilder::default()
    }

    /// ADR-0006 workstream J: resolve a bare DID string to an agent record. Fills the gap "I only
    /// have a did:moye:... string, not an ag_... id or which node it's on". Tries the local fast
    /// path first (GET /api/agents/by-did/:did against base_url -- works if that node already
    /// knows the DID), then falls back to the DHT-based lookup (GET /api/dht/resolve-did/:did,
    /// ADR-0006 F2) to find which OTHER node(s) know it. Does NOT attempt to actually
    /// connect/dial across nodes -- that needs a transport decision (HTTP to the other node, or a
    /// direct P2P dial) this method can't make on the caller's behalf; use send()/discover()
    /// against the resolved node instead.
    pub async fn resolve_did(did: &str, base_url: &str) -> Result<serde_json::Value> {
        let probe = Agent::new("_probe").base_url(base_url);
        if let Ok(r) = probe.get::<serde_json::Value>(&format!("/api/agents/by-did/{did}")).await {
            return Ok(serde_json::json!({ "found": true, "via": "local", "agent_id": r["agent_id"], "agent": r["agent"] }));
        }
        match probe.get::<serde_json::Value>(&format!("/api/dht/resolve-did/{did}")).await {
            Ok(r) => {
                let providers = r["providers"].as_array().cloned().unwrap_or_default();
                Ok(serde_json::json!({ "found": !providers.is_empty(), "via": "dht", "providers": providers, "note": r["note"] }))
            }
            Err(e) => Ok(serde_json::json!({ "found": false, "via": null, "error": e.to_string() })),
        }
    }

    // Send a message
    pub async fn send(&self, to: &str, content: &str) -> Result<String> {
        self.send_inner(to, content, false).await
    }

    // F3: sign {from,to,content_hash} (recursively-sorted-key JSON, matching Node/Python/server) so
    // the recipient can verify authorship regardless of which node relayed the message.
    fn sender_sig(&self, from: &str, to: &str, content: &str) -> Result<String> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        use ed25519_dalek::Signer;
        use sha2::Digest;
        let ch: String = Sha256::digest(content.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect();
        // serde_json Value objects serialize with sorted keys (BTreeMap) + compact + raw UTF-8,
        // which is exactly the shared canonical form.
        let canon = serde_json::to_string(&serde_json::json!({ "from": from, "to": to, "content_hash": ch }))
            .map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let sk = self.signing_key()?;
        Ok(B64.encode(sk.sign(canon.as_bytes()).to_bytes()))
    }

    /// Verify a received message's sender_sig against the sender's DID pubkey.
    /// Returns Some(true/false), or None if the message carried no signature.
    pub async fn verify_sender(&self, m: &Message) -> Result<Option<bool>> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        use ed25519_dalek::pkcs8::DecodePublicKey;
        use ed25519_dalek::Verifier;
        use sha2::Digest;
        let sig_b64 = match &m.sender_sig { Some(s) => s, None => return Ok(None) };
        #[derive(Deserialize)]
        struct P { pubkey: String }
        let p: P = self.get(&format!("/api/agents/{}/pubkey", m.from_agent)).await?;
        let ch: String = Sha256::digest(m.content.as_bytes()).iter().map(|b| format!("{:02x}", b)).collect();
        let to = self.agent_id()?.to_string();
        let canon = serde_json::to_string(&serde_json::json!({ "from": m.from_agent, "to": to, "content_hash": ch }))
            .map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let vk = ed25519_dalek::VerifyingKey::from_public_key_pem(&p.pubkey).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let sig_bytes = B64.decode(sig_b64).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let sig = ed25519_dalek::Signature::from_slice(&sig_bytes).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        Ok(Some(vk.verify(canon.as_bytes(), &sig).is_ok()))
    }

    async fn send_inner(&self, to: &str, content: &str, encrypted: bool) -> Result<String> {
        #[derive(Serialize)]
        struct Req {
            from_agent: String,
            to_agent: String,
            content: String,
            encrypted: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            sender_sig: Option<String>,
        }
        #[derive(Deserialize)]
        struct Resp {
            message_id: String,
        }
        let from = self.agent_id()?.to_string();
        let sender_sig = if self.id_priv.is_some() { Some(self.sender_sig(&from, to, content)?) } else { None };
        let r: Resp = self
            .post_authed(
                "/api/messages",
                &Req {
                    from_agent: from,
                    to_agent: to.to_string(),
                    content: content.to_string(),
                    encrypted,
                    sender_sig,
                },
            )
            .await?;
        Ok(r.message_id)
    }

    pub async fn inbox(&self) -> Result<Vec<Message>> {
        #[derive(Deserialize)]
        struct Resp {
            messages: Vec<Message>,
        }
        let r: Resp = self.get_authed(&format!("/api/agents/{}/inbox", self.agent_id()?)).await?;
        Ok(r.messages)
    }

    /// Cross-room catchup. Persist `next_cursor` from the JSON and pass it as `since` next time.
    pub async fn catchup(&self, since: u64) -> Result<serde_json::Value> {
        let path = format!("/api/agents/{}/catchup", self.agent_id()?);
        let mut req = self.client.get(format!("{}{}?since={}", self.base_url, path, since));
        if self.id_priv.is_some() {
            let did = self.did.clone().ok_or_else(|| MoyeError::Api("DID not derived".into()))?;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let claim = serde_json::to_string(&serde_json::json!({ "method": "GET", "path": path, "ts": ts }))
                .map_err(|e| MoyeError::Crypto(e.to_string()))?;
            let sig = self.sign_payload(&claim)?;
            req = req
                .header("X-Moye-Did", did)
                .header("X-Moye-Sig", sig)
                .header("X-Moye-Ts", ts.to_string());
        } else if let Some(b) = self.bearer() {
            req = req.header("Authorization", b);
        }
        let resp = req.send().await?;
        let api: Api<serde_json::Value> = resp.json().await?;
        if !api.success {
            return Err(MoyeError::Api(api.error.unwrap_or_default()));
        }
        Ok(api.data)
    }

    /// Room webhook allowlist. `None` = every membership; empty vec = no room POSTs.
    pub async fn set_webhook_rooms(&self, rooms: Option<Vec<String>>) -> Result<serde_json::Value> {
        self.post_authed(
            &format!("/api/agents/{}/webhook-rooms", self.agent_id()?),
            &serde_json::json!({ "rooms": rooms }),
        )
        .await
    }

    pub async fn ack(&self, message_id: &str) -> Result<()> {
        self.post_authed::<serde_json::Value>(
            &format!("/api/messages/{}/ack", message_id),
            &serde_json::json!({ "status": "done" }),
        )
        .await?;
        Ok(())
    }

    // Collaboration room (creator is derived server-side from the authenticated identity, not
    // accepted from the client, so this field isn't in the request body)
    pub async fn create_room(&self, name: &str, members: Vec<String>) -> Result<String> {
        #[derive(Serialize)]
        struct Req {
            name: String,
            members: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Resp {
            room_id: String,
        }
        let r: Resp = self
            .post_authed(
                "/api/rooms",
                &Req {
                    name: name.to_string(),
                    members,
                },
            )
            .await?;
        Ok(r.room_id)
    }

    pub async fn assign_task(&self, room_id: &str, task: &str, assignees: Vec<String>) -> Result<Vec<String>> {
        #[derive(Serialize)]
        struct Req {
            task: String,
            assignees: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Resp {
            task_ids: Vec<String>,
        }
        let r: Resp = self
            .post_authed(&format!("/api/rooms/{}/tasks", room_id), &Req { task: task.to_string(), assignees })
            .await?;
        Ok(r.task_ids)
    }

    pub async fn report(&self, room_id: &str, task_id: &str, result: &str) -> Result<()> {
        self.post_authed::<serde_json::Value>(
            &format!("/api/rooms/{}/tasks/{}/report", room_id, task_id),
            &serde_json::json!({ "result": result }),
        )
        .await?;
        Ok(())
    }

    pub async fn room(&self, room_id: &str) -> Result<RoomView> {
        #[derive(Deserialize)]
        struct Resp {
            #[serde(default)]
            room: RoomMeta,
            tasks: Vec<RoomTask>,
        }
        #[derive(Debug, Deserialize, Default)]
        struct RoomMeta {
            #[serde(default)]
            name: String,
        }
        let r: Resp = self.get(&format!("/api/rooms/{}", room_id)).await?;
        Ok(RoomView { name: r.room.name, tasks: r.tasks })
    }

    // ---------- ADR-0005 direction 2: Verifiable Credentials ----------
    // Issues a credential endorsing `subject_did` for `claim` (e.g.
    // json!({"type":"contribution-endorsement","kind":"relay","period":"2026-07","metric":5})).
    // Requires this agent to hold a DID identity -- only a key holder can endorse in its own name,
    // same rule the server enforces. `serde_json::Value` objects serialize with sorted keys (see the
    // get_authed comment above), matching server.js's vcSigningPayload / the Node and Python SDKs'
    // issue_credential exactly: sign everything except `sig`, then attach `sig`. Found missing across
    // every client (all three SDKs + the CLI) during the 2026-07-24 ADR/spec gap audit -- the server
    // endpoint existed with nothing able to call it without hand-rolling this signing.
    pub async fn issue_credential(
        &self,
        subject_did: &str,
        claim: serde_json::Value,
        expires_at: Option<u64>,
    ) -> Result<serde_json::Value> {
        if self.id_priv.is_none() {
            return Err(MoyeError::Api("issuing a credential requires a DID identity".into()));
        }
        let did = self.did.clone().ok_or_else(|| MoyeError::Api("DID not derived".into()))?;
        let issued_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut vc = serde_json::json!({
            "type": "moye/vc",
            "issuer": did,
            "subject": subject_did,
            "claim": claim,
            "issued_at": issued_at,
            "expires_at": expires_at,
        });
        let signing_str = serde_json::to_string(&vc).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let sig = self.sign_payload(&signing_str)?;
        vc.as_object_mut()
            .ok_or_else(|| MoyeError::Crypto("vc did not serialize to an object".into()))?
            .insert("sig".to_string(), serde_json::json!(sig));
        self.post_authed("/api/credentials", &serde_json::json!({ "credential": vc })).await
    }

    /// Lists credentials received by `agent_id` (defaults to self via `agent_id()`), each already
    /// re-verified server-side (`verified` per entry).
    pub async fn credentials(&self, agent_id: Option<&str>) -> Result<Vec<serde_json::Value>> {
        let id = match agent_id {
            Some(a) => a.to_string(),
            None => self.agent_id()?.to_string(),
        };
        #[derive(Deserialize)]
        struct Resp {
            credentials: Vec<serde_json::Value>,
        }
        let r: Resp = self.get(&format!("/api/agents/{}/credentials", id)).await?;
        Ok(r.credentials)
    }

    // ---------------- E2E encryption (P-256 ECDH + AES-256-GCM) ----------------

    /// Generates a P-256 encryption keypair, returns the public key (PEM/SPKI) for submission with registration
    pub fn generate_encryption_key(&mut self) -> Result<String> {
        use p256::pkcs8::der::pem::LineEnding;
        use p256::pkcs8::EncodePrivateKey;
        use p256::pkcs8::EncodePublicKey;
        use p256::SecretKey;
        let sk = SecretKey::random(&mut rand_core::OsRng);
        let pk = sk.public_key();
        let priv_pem = sk.to_pkcs8_pem(LineEnding::LF).map_err(|e| MoyeError::Crypto(e.to_string()))?.to_string();
        let pub_pem = pk.to_public_key_pem(LineEnding::LF).map_err(|e| MoyeError::Crypto(e.to_string()))?.to_string();
        self.enc_priv = Some(priv_pem);
        Ok(pub_pem)
    }

    pub fn set_encryption_key(&mut self, pem: &str) {
        self.enc_priv = Some(pem.to_string());
    }

    fn enc_pubkey_pem(&self) -> Option<String> {
        use p256::pkcs8::der::pem::LineEnding;
        use p256::pkcs8::DecodePrivateKey;
        use p256::pkcs8::EncodePublicKey;
        use p256::SecretKey;
        let priv_pem = self.enc_priv.as_ref()?;
        let sk = SecretKey::from_pkcs8_pem(priv_pem).ok()?;
        sk.public_key().to_public_key_pem(LineEnding::LF).ok().map(|p| p.to_string())
    }

    fn encrypt_for(&self, recipient_pub_pem: &str, plaintext: &str) -> Result<String> {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        use hkdf::Hkdf;
        use p256::ecdh::EphemeralSecret;
        use p256::pkcs8::DecodePublicKey;
        use p256::pkcs8::EncodePublicKey;
        use p256::pkcs8::der::pem::LineEnding;
        use p256::PublicKey;
        use rand_core::RngCore;
        use sha2::Sha256;

        let recip = PublicKey::from_public_key_pem(recipient_pub_pem).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let eph = EphemeralSecret::random(&mut rand_core::OsRng);
        let eph_pub = eph.public_key();
        let shared = eph.diffie_hellman(&recip);
        let hk = Hkdf::<Sha256>::new(None, shared.raw_secret_bytes());
        let mut key = [0u8; 32];
        hk.expand(b"moye-e2e", &mut key).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let mut iv = [0u8; 12];
        rand_core::OsRng.fill_bytes(&mut iv);
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let ct = cipher.encrypt(Nonce::from_slice(&iv), plaintext.as_bytes()).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let eph_pem = eph_pub.to_public_key_pem(LineEnding::LF).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        Ok(format!("{},{},{}", eph_pem, B64.encode(iv), B64.encode(ct)))
    }

    fn decrypt(&self, payload: &str) -> Result<String> {
        use aes_gcm::aead::Aead;
        use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        use hkdf::Hkdf;
        use p256::pkcs8::DecodePrivateKey;
        use p256::pkcs8::DecodePublicKey;
        use p256::PublicKey;
        use sha2::Sha256;

        let priv_pem = self.enc_priv.as_ref().ok_or_else(|| MoyeError::Api("no encryption key".into()))?;
        let sk = p256::SecretKey::from_pkcs8_pem(priv_pem).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let parts: Vec<&str> = payload.splitn(3, ',').collect();
        if parts.len() != 3 { return Err(MoyeError::Api("bad e2e payload".into())); }
        let eph_pub = PublicKey::from_public_key_pem(parts[0]).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let iv = B64.decode(parts[1]).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let ct = B64.decode(parts[2]).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let shared = p256::ecdh::diffie_hellman(sk.to_nonzero_scalar(), eph_pub.as_affine());
        let hk = Hkdf::<Sha256>::new(None, shared.raw_secret_bytes());
        let mut key = [0u8; 32];
        hk.expand(b"moye-e2e", &mut key).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        let pt = cipher.decrypt(Nonce::from_slice(&iv), ct.as_slice()).map_err(|e| MoyeError::Crypto(e.to_string()))?;
        String::from_utf8(pt).map_err(|e| MoyeError::Crypto(e.to_string()))
    }

    /// E2E send: fetches the recipient's public key, then encrypts
    pub async fn send_encrypted(&self, to: &str, plaintext: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct PubResp { enc_pubkey: String }
        let pubr: PubResp = self.get(&format!("/api/agents/{}/enc-pubkey", to)).await?;
        let cipher = self.encrypt_for(&pubr.enc_pubkey, plaintext)?;
        self.send_inner(to, &cipher, true).await
    }

    /// Decrypts encrypted messages in the inbox, returns (message, plaintext or None)
    pub async fn inbox_decrypted(&self) -> Result<Vec<(Message, Option<String>)>> {
        let msgs = self.inbox().await?;
        let mut out = vec![];
        for m in msgs {
            let dec = if m.encrypted { self.decrypt(&m.content).ok() } else { None };
            out.push((m, dec));
        }
        Ok(out)
    }
}

// ---------------- Discover builder ----------------

#[derive(Debug)]
pub struct DiscoverBuilder {
    q: String,
    capability: String,
    base_url: String,
}

impl Default for DiscoverBuilder {
    fn default() -> Self {
        Self { q: String::new(), capability: String::new(), base_url: DEFAULT_BASE.to_string() }
    }
}

impl DiscoverBuilder {
    pub fn query(mut self, q: impl Into<String>) -> Self {
        self.q = q.into();
        self
    }
    pub fn capability(mut self, c: impl Into<String>) -> Self {
        self.capability = c.into();
        self
    }
    pub fn base_url(mut self, u: impl Into<String>) -> Self {
        self.base_url = u.into().trim_end_matches('/').to_string();
        self
    }

    pub async fn call(self) -> Result<Vec<AgentRecord>> {
        let mut url = format!("{}/api/agents", self.base_url);
        let mut sep = '?';
        if !self.q.is_empty() {
            url.push(sep);
            url.push_str("q=");
            url.push_str(&self.q);
            sep = '&';
        }
        if !self.capability.is_empty() {
            url.push(sep);
            url.push_str("capability=");
            url.push_str(&self.capability);
        }
        let client = reqwest::Client::new();
        let resp = client.get(&url).send().await?;
        let api: Api<DiscoverResp> = resp.json().await?;
        if !api.success {
            return Err(MoyeError::Api(api.error.unwrap_or_default()));
        }
        Ok(api.data.agents)
    }
}

#[derive(Debug, Deserialize, Default)]
struct DiscoverResp {
    agents: Vec<AgentRecord>,
}
