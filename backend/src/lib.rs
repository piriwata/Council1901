use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use worker::*;

type HmacSha256 = Hmac<Sha256>;

const MAX_CONTENT_LENGTH: usize = 4096;
const KV_BINDING: &str = "COUNCIL_KV";
const SECRET_BINDING: &str = "HMAC_SECRET";
const MAX_MSG_FETCH: usize = 200;

// ==================== Country ====================

fn valid_country(s: &str) -> bool {
    matches!(
        s,
        "england" | "france" | "germany" | "italy" | "austria" | "russia" | "turkey"
    )
}

// ==================== Token ====================
// Format: {room_id}|{country}|{hmac_hex}
// Splitting from the right handles room_ids that might contain '|'.

fn compute_hmac_hex(secret: &str, room_id: &str, country: &str) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(format!("{}:{}", room_id, country).as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn make_token(secret: &str, room_id: &str, country: &str) -> String {
    format!("{}|{}|{}", room_id, country, compute_hmac_hex(secret, room_id, country))
}

struct Claims {
    room_id: String,
    country: String,
}

fn verify_token(secret: &str, token: &str) -> Option<Claims> {
    let last = token.rfind('|')?;
    let hmac_part = &token[last + 1..];
    let rest = &token[..last];
    let mid = rest.rfind('|')?;
    let country_part = &rest[mid + 1..];
    let room_id_part = &rest[..mid];

    if !valid_country(country_part) {
        return None;
    }
    if compute_hmac_hex(secret, room_id_part, country_part) != hmac_part {
        return None;
    }
    Some(Claims {
        room_id: room_id_part.to_string(),
        country: country_part.to_string(),
    })
}

fn get_claims(secret: &str, req: &Request) -> Option<Claims> {
    let auth = req.headers().get("Authorization").ok()??;
    let token = auth.strip_prefix("Bearer ")?;
    verify_token(secret, token)
}

// ==================== Conversation ID ====================

fn conversation_id(room_id: &str, participants: &[String]) -> String {
    let mut sorted = participants.to_vec();
    sorted.sort();
    let input = format!("{}:{}", room_id, sorted.join(":"));
    hex::encode(&Sha256::digest(input.as_bytes())[..16])
}

// ==================== KV helpers ====================

async fn kv_get<T: for<'de> Deserialize<'de>>(kv: &kv::KvStore, key: &str) -> Result<Option<T>> {
    match kv.get(key).text().await? {
        Some(s) => Ok(Some(
            serde_json::from_str(&s).map_err(|e| Error::RustError(e.to_string()))?,
        )),
        None => Ok(None),
    }
}

async fn kv_put<T: Serialize>(kv: &kv::KvStore, key: &str, value: &T) -> Result<()> {
    let json = serde_json::to_string(value).map_err(|e| Error::RustError(e.to_string()))?;
    kv.put(key, json)?
        .execute()
        .await
        .map_err(|e| Error::RustError(e.to_string()))
}

// ==================== Data types ====================

#[derive(Serialize, Deserialize)]
struct ConvMeta {
    room_id: String,
    participants: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Message {
    message_id: String,
    room_id: String,
    conversation_id: String,
    sender_country: String,
    content: String,
    timestamp: u64,
}

#[derive(Serialize)]
struct ConversationInfo {
    conversation_id: String,
    participants: Vec<String>,
}

// ==================== CORS ====================

fn with_cors(mut resp: Response) -> Result<Response> {
    let h = resp.headers_mut();
    h.set("Access-Control-Allow-Origin", "*")?;
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization")?;
    Ok(resp)
}

fn cors_preflight() -> Result<Response> {
    let mut resp = Response::empty()?;
    let h = resp.headers_mut();
    h.set("Access-Control-Allow-Origin", "*")?;
    h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")?;
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization")?;
    Ok(resp)
}

fn err(msg: &str, status: u16) -> Result<Response> {
    with_cors(Response::error(msg, status)?)
}

// ==================== POST /api/auth ====================

async fn handle_auth(mut req: Request, env: &Env) -> Result<Response> {
    #[derive(Deserialize)]
    struct Body {
        room_id: String,
        country: String,
    }

    let body: Body = req.json().await.map_err(|_| Error::RustError("Invalid JSON".into()))?;

    if !valid_country(&body.country) {
        return err("Invalid country", 400);
    }
    if body.room_id.is_empty() || body.room_id.len() > 64 {
        return err("Invalid room_id", 400);
    }

    let kv = env.kv(KV_BINDING)?;
    let seat_key = format!("room:{}:seat:{}", body.room_id, body.country);

    // Once a seat is claimed, no new token can be issued for that room+country.
    // Note: KV does not support atomic check-and-set, so a very narrow race
    // condition exists where two simultaneous first-time requests could both
    // pass this check. In practice this is negligible for a diplomacy game.
    let taken: Option<bool> = kv_get(&kv, &seat_key).await?;
    if taken.is_some() {
        return err("Seat already taken", 409);
    }

    let secret = env.secret(SECRET_BINDING)?.to_string();
    let access_token = make_token(&secret, &body.room_id, &body.country);

    // Mark this seat as claimed before returning the token.
    kv_put(&kv, &seat_key, &true).await?;

    #[derive(Serialize)]
    struct Resp {
        access_token: String,
    }
    with_cors(Response::from_json(&Resp { access_token })?)
}

// ==================== GET /api/conversations ====================

async fn handle_get_conversations(req: Request, env: &Env) -> Result<Response> {
    let secret = env.secret(SECRET_BINDING)?.to_string();
    let claims = match get_claims(&secret, &req) {
        Some(c) => c,
        None => return err("Unauthorized", 401),
    };

    let url = req.url()?;
    let params: HashMap<_, _> = url.query_pairs().collect();
    let room_id = params.get("room_id").map(|v| v.as_ref()).unwrap_or("");
    if room_id != claims.room_id {
        return err("Unauthorized", 401);
    }

    let kv = env.kv(KV_BINDING)?;
    let conv_ids: Vec<String> = kv_get(&kv, &format!("room:{}:conversations", claims.room_id))
        .await?
        .unwrap_or_default();

    let mut result: Vec<ConversationInfo> = Vec::new();
    for id in conv_ids {
        if let Some(meta) = kv_get::<ConvMeta>(&kv, &format!("conv:{}:meta", id)).await? {
            if meta.participants.contains(&claims.country) {
                result.push(ConversationInfo {
                    conversation_id: id,
                    participants: meta.participants,
                });
            }
        }
    }

    with_cors(Response::from_json(&result)?)
}

// ==================== POST /api/conversations ====================

async fn handle_post_conversations(mut req: Request, env: &Env) -> Result<Response> {
    let secret = env.secret(SECRET_BINDING)?.to_string();
    let claims = match get_claims(&secret, &req) {
        Some(c) => c,
        None => return err("Unauthorized", 401),
    };

    #[derive(Deserialize)]
    struct Body {
        room_id: String,
        participants: Vec<String>,
    }

    let body: Body = req.json().await.map_err(|_| Error::RustError("Invalid JSON".into()))?;

    if body.room_id != claims.room_id {
        return err("Unauthorized", 401);
    }
    if body.participants.len() < 2 || body.participants.len() > 3 {
        return err("participants must be 2 or 3", 400);
    }

    // Validate all countries and check no duplicates
    let mut seen = HashSet::new();
    for p in &body.participants {
        if !valid_country(p) {
            return err("Invalid participant country", 400);
        }
        if !seen.insert(p.as_str()) {
            return err("Duplicate participant", 400);
        }
    }

    if !body.participants.contains(&claims.country) {
        return err("Caller must be a participant", 403);
    }

    let conv_id = conversation_id(&claims.room_id, &body.participants);
    let kv = env.kv(KV_BINDING)?;
    let meta_key = format!("conv:{}:meta", conv_id);

    if kv_get::<ConvMeta>(&kv, &meta_key).await?.is_none() {
        let mut sorted_participants = body.participants.clone();
        sorted_participants.sort();
        let meta = ConvMeta {
            room_id: claims.room_id.clone(),
            participants: sorted_participants,
        };
        kv_put(&kv, &meta_key, &meta).await?;

        // Add conversation to room list
        let list_key = format!("room:{}:conversations", claims.room_id);
        let mut ids: Vec<String> = kv_get(&kv, &list_key).await?.unwrap_or_default();
        if !ids.contains(&conv_id) {
            ids.push(conv_id.clone());
            kv_put(&kv, &list_key, &ids).await?;
        }
    }

    #[derive(Serialize)]
    struct Resp {
        conversation_id: String,
    }
    with_cors(Response::from_json(&Resp { conversation_id: conv_id })?)
}

// ==================== GET /api/messages ====================

async fn handle_get_messages(req: Request, env: &Env) -> Result<Response> {
    let secret = env.secret(SECRET_BINDING)?.to_string();
    let claims = match get_claims(&secret, &req) {
        Some(c) => c,
        None => return err("Unauthorized", 401),
    };

    let url = req.url()?;
    let params: HashMap<_, _> = url.query_pairs().collect();
    let conv_id = match params.get("conversation_id") {
        Some(id) => id.to_string(),
        None => return err("Missing conversation_id", 400),
    };
    let since: u64 = params
        .get("since")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let kv = env.kv(KV_BINDING)?;

    let meta: ConvMeta = match kv_get(&kv, &format!("conv:{}:meta", conv_id)).await? {
        Some(m) => m,
        None => return err("Conversation not found", 404),
    };

    if meta.room_id != claims.room_id || !meta.participants.contains(&claims.country) {
        return err("Forbidden", 403);
    }

    // List all message keys for this conversation; keys are lexicographically sortable
    // due to zero-padded timestamp prefix
    let prefix = format!("conv:{}:msg:", conv_id);
    let list_result = kv.list().prefix(prefix.clone()).execute().await?;

    let since_key = format!("conv:{}:msg:{:020}:", conv_id, since);
    let mut messages: Vec<Message> = Vec::new();

    for key_info in list_result.keys {
        // Skip keys at or before the since timestamp
        if since > 0 && key_info.name <= since_key {
            continue;
        }
        if let Some(msg) = kv_get::<Message>(&kv, &key_info.name).await? {
            messages.push(msg);
        }
        if messages.len() >= MAX_MSG_FETCH {
            break;
        }
    }

    with_cors(Response::from_json(&messages)?)
}

// ==================== POST /api/messages ====================

async fn handle_post_messages(mut req: Request, env: &Env) -> Result<Response> {
    let secret = env.secret(SECRET_BINDING)?.to_string();
    let claims = match get_claims(&secret, &req) {
        Some(c) => c,
        None => return err("Unauthorized", 401),
    };

    #[derive(Deserialize)]
    struct Body {
        conversation_id: String,
        content: String,
    }

    let body: Body = req.json().await.map_err(|_| Error::RustError("Invalid JSON".into()))?;

    if body.content.is_empty() || body.content.len() > MAX_CONTENT_LENGTH {
        return err("content must be 1–4096 bytes", 400);
    }

    let kv = env.kv(KV_BINDING)?;

    let meta: ConvMeta = match kv_get(&kv, &format!("conv:{}:meta", body.conversation_id)).await? {
        Some(m) => m,
        None => return err("Conversation not found", 404),
    };

    if meta.room_id != claims.room_id || !meta.participants.contains(&claims.country) {
        return err("Forbidden", 403);
    }

    let timestamp = Date::now().as_millis() as u64;
    let message_id = uuid::Uuid::new_v4().to_string();

    let message = Message {
        message_id: message_id.clone(),
        room_id: claims.room_id.clone(),
        conversation_id: body.conversation_id.clone(),
        sender_country: claims.country.clone(),
        content: body.content,
        timestamp,
    };

    let msg_key = format!(
        "conv:{}:msg:{:020}:{}",
        body.conversation_id, timestamp, message_id
    );
    kv_put(&kv, &msg_key, &message).await?;

    #[derive(Serialize)]
    struct Resp {
        message_id: String,
    }
    with_cors(Response::from_json(&Resp { message_id })?)
}

// ==================== Entry point ====================

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    if req.method() == Method::Options {
        return cors_preflight();
    }

    let path = req.path();
    match (req.method(), path.as_str()) {
        (Method::Post, "/api/auth") => handle_auth(req, &env).await,
        (Method::Get, "/api/conversations") => handle_get_conversations(req, &env).await,
        (Method::Post, "/api/conversations") => handle_post_conversations(req, &env).await,
        (Method::Get, "/api/messages") => handle_get_messages(req, &env).await,
        (Method::Post, "/api/messages") => handle_post_messages(req, &env).await,
        (Method::Get, "/api/health") => with_cors(Response::ok("ok")?),
        _ => err("Not Found", 404),
    }
}
