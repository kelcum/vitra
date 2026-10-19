use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::sha2::{Digest, Sha256};
use rsa::signature::{SignatureEncoding, Signer};
use rsa::RsaPrivateKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{Manager, State};

use crate::auth::{self, Identity};
use crate::bail;
use crate::error::{Error, Result};
use crate::instances::Instance;
use crate::state::AppState;
use crate::util;

const API: &str = "https://api.xan.gripe";
const TOKEN_MARGIN_MS: i64 = 2 * 3600 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VitraCape {
    pub id: String,
    pub url: String,
    pub w: u32,
    pub h: u32,
    pub frames: u32,
    pub delay: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub slug: String,
    pub name: String,
    pub cape: VitraCape,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CosmeticsStatus {
    pub cape: Option<VitraCape>,
    pub presets: Vec<Preset>,
    pub online: Option<u64>,
    pub players: Option<u64>,
}

static GAME_TOKEN: Mutex<Option<(String, String, i64)>> = Mutex::new(None);

async fn api_error(resp: reqwest::Response) -> Error {
    let status = resp.status();
    let msg = resp.json::<Value>().await.ok().and_then(|v| v["error"].as_str().map(String::from));
    Error::Msg(msg.unwrap_or_else(|| format!("Vitra's cape server answered {status}.")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Certificates {
    key_pair: KeyPair,
    public_key_signature_v2: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyPair {
    private_key: String,
    public_key: String,
}

async fn proof(state: &AppState, uuid: &str, token: &str, purpose: &str) -> Result<Value> {
    let resp = state.http.post("https://api.minecraftservices.com/player/certificates").bearer_auth(token).send().await?;
    if !resp.status().is_success() {
        bail!("Mojang didn't hand out this account's key ({}). Try signing in again.", resp.status());
    }
    let certs: Certificates = resp.json().await?;
    let b64 = base64::engine::general_purpose::STANDARD;
    let der = |pem: &str| b64.decode(pem.lines().filter(|l| !l.starts_with("-----")).collect::<String>());
    let private = der(&certs.key_pair.private_key).map_err(|_| Error::Msg("Mojang sent an unreadable key.".into()))?;
    let public = der(&certs.key_pair.public_key).map_err(|_| Error::Msg("Mojang sent an unreadable key.".into()))?;
    let expires_at = chrono::DateTime::parse_from_rfc3339(&certs.expires_at)
        .map_err(|_| Error::Msg("Mojang sent an unreadable key.".into()))?
        .timestamp_millis();
    let key = RsaPrivateKey::from_pkcs8_der(&private).map_err(|_| Error::Msg("Mojang sent an unreadable key.".into()))?;
    let uuid = uuid.replace('-', "");
    let ts = util::now_millis();
    let signature = SigningKey::<Sha256>::new(key).sign(format!("vitra|{uuid}|{ts}|{purpose}").as_bytes());
    Ok(json!({
        "uuid": uuid,
        "publicKey": b64.encode(public),
        "expiresAt": expires_at,
        "keySignature": certs.public_key_signature_v2,
        "ts": ts,
        "signature": b64.encode(signature.to_bytes()),
    }))
}

fn mod_jar(state: &AppState, game_version: &str) -> Option<PathBuf> {
    let line: Vec<&str> = game_version.split('.').take(2).collect();
    let name = format!("resources/mods/vitra-cosmetics-{}.jar", line.join("."));
    state.app.path().resolve(name, BaseDirectory::Resource).ok().filter(|p| p.is_file())
}

async fn game_token(state: &AppState, identity: &Identity) -> Result<String> {
    if let Some((uuid, token, expires)) = GAME_TOKEN.lock().unwrap().clone() {
        if uuid == identity.uuid && expires - util::now_millis() > TOKEN_MARGIN_MS {
            return Ok(token);
        }
    }
    let proof = proof(state, &identity.uuid, &identity.token, "auth").await?;
    let resp = state
        .http
        .post(format!("{API}/v1/auth"))
        .json(&json!({ "name": identity.name, "proof": proof }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await?;
    let token = body["token"].as_str().ok_or_else(|| Error::Msg("Vitra's cape server sent no token.".into()))?.to_string();
    let expires = util::now_millis() + body["expiresIn"].as_i64().unwrap_or(0);
    *GAME_TOKEN.lock().unwrap() = Some((identity.uuid.clone(), token.clone(), expires));
    Ok(token)
}

pub async fn launch_args(state: &AppState, inst: &Instance, identity: &Identity) -> Vec<String> {
    let settings = state.settings();
    if !(settings.cosmetics || settings.memories) || inst.loader != "fabric" {
        return vec![];
    }
    let Some(jar) = mod_jar(state, &inst.game_version) else { return vec![] };
    let mut args = vec![format!("-Dfabric.addMods={}", jar.display())];
    if settings.memories {
        args.push("-Dvitra.moments=true".into());
    }
    if !settings.cosmetics {
        args.push("-Dvitra.cosmetics.off=true".into());
    } else if !identity.demo {
        match game_token(state, identity).await {
            Ok(token) => args.push(format!("-Dvitra.cosmetics.token={token}")),
            Err(e) => log::warn!("Vitra badge is off for this session: {e}"),
        }
    }
    args
}

#[tauri::command]
pub fn cosmetics_supported(state: State<'_, Arc<AppState>>, loader: String, game_version: String) -> bool {
    loader == "fabric" && mod_jar(&state, &game_version).is_some()
}

#[tauri::command]
pub async fn cosmetics_status(state: State<'_, Arc<AppState>>) -> Result<CosmeticsStatus> {
    let presets = async {
        let resp = state.http.get(format!("{API}/v1/presets")).send().await?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }
        Ok::<Vec<Preset>, Error>(serde_json::from_value(resp.json::<Value>().await?["presets"].take())?)
    };
    let cape = async {
        let account = auth::active_account(&state)?;
        let resp = state.http.get(format!("{API}/v1/players/{}", account.uuid.replace('-', ""))).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        serde_json::from_value::<Option<VitraCape>>(resp.json::<Value>().await.ok()?["cape"].take()).ok().flatten()
    };
    let stats = async {
        match state.http.get(format!("{API}/v1/stats")).send().await {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.unwrap_or_default(),
            _ => Value::Null,
        }
    };
    let (presets, cape, stats) = tokio::join!(presets, cape, stats);
    Ok(CosmeticsStatus { cape, presets: presets?, online: stats["online"].as_u64(), players: stats["players"].as_u64() })
}

#[tauri::command]
pub async fn delete_vitra_data(state: State<'_, Arc<AppState>>) -> Result<()> {
    let (account, token) = auth::access_token(&state).await?;
    let proof = proof(&state, &account.uuid, &token, "delete").await?;
    let resp = state
        .http
        .delete(format!("{API}/v1/me"))
        .json(&json!({ "name": account.name, "proof": proof }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    *GAME_TOKEN.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn set_vitra_cape(
    state: State<'_, Arc<AppState>>,
    preset: Option<String>,
    image: Option<String>,
    frames: Option<u32>,
    delay: Option<u32>,
) -> Result<Option<VitraCape>> {
    let (account, token) = auth::access_token(&state).await?;
    if image.as_ref().is_some_and(|i| i.len() > 2_100_000) {
        bail!("That cape is too big. Keep it under 1.5 MB.");
    }
    let mut body = json!({ "name": account.name });
    let purpose = match (preset, image) {
        (Some(slug), _) => {
            let purpose = format!("cape:preset:{slug}");
            body["preset"] = json!(slug);
            purpose
        }
        (None, Some(img)) => {
            let purpose = format!("cape:image:{}", hex::encode(Sha256::digest(img.as_bytes())));
            body["image"] = json!(img);
            body["frames"] = json!(frames);
            body["delay"] = json!(delay.unwrap_or(100));
            purpose
        }
        (None, None) => {
            body["remove"] = json!(true);
            "cape:remove".to_string()
        }
    };
    body["proof"] = proof(&state, &account.uuid, &token, &purpose).await?;
    let resp = state.http.put(format!("{API}/v1/me/cape")).json(&body).send().await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    Ok(serde_json::from_value(resp.json::<Value>().await?["cape"].take()).ok().flatten())
}
