//! Vitra cosmetics: the Vitra badge next to Vitra players' names, and free capes (animated ones
//! too). The Vitra Cosmetics mod draws them in game; it ships inside Vitra and is added to Fabric
//! instances at launch with `-Dfabric.addMods`, so players' mods folders stay untouched. Who uses
//! Vitra and which cape they wear lives at api.xan.gripe. Ownership is proven with the key pair
//! Mojang gives every account for chat signing: the access token only ever goes to Mojang, and the
//! private key never leaves this computer.

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
/// The game's presence token is reused while it has at least this long left.
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
    /// The signed-in player's Vitra cape.
    pub cape: Option<VitraCape>,
    pub presets: Vec<Preset>,
}

/// (account uuid, token, expires at ms)
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

/// Proof that we're this player, for `purpose` only: Mojang's signature over the account's public
/// key, plus our signature (with the matching private key) over the purpose and the time.
async fn proof(state: &AppState, uuid: &str, token: &str, purpose: &str) -> Result<Value> {
    let resp = state.http.post("https://api.minecraftservices.com/player/certificates").bearer_auth(token).send().await?;
    if !resp.status().is_success() {
        bail!("Mojang didn't hand out this account's key ({}). Try signing in again.", resp.status());
    }
    let certs: Certificates = resp.json().await?;
    let b64 = base64::engine::general_purpose::STANDARD;
    // Mojang labels these "RSA" PEM but they hold PKCS#8 / X.509 DER.
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

/// The mod built for this game version, if Vitra ships one (26.3 and 26.3.x share a build).
fn mod_jar(state: &AppState, game_version: &str) -> Option<PathBuf> {
    let line: Vec<&str> = game_version.split('.').take(2).collect();
    let name = format!("resources/mods/vitra-cosmetics-{}.jar", line.join("."));
    state.app.path().resolve(name, BaseDirectory::Resource).ok().filter(|p| p.is_file())
}

/// A token that lets the game tell api.xan.gripe "this player is on Vitra right now".
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

/// Extra JVM arguments that add the Vitra Cosmetics mod to a Fabric instance. Never fails the
/// launch: without the server the game just starts without our badge.
pub async fn launch_args(state: &AppState, inst: &Instance, identity: &Identity) -> Vec<String> {
    if !state.settings().cosmetics || inst.loader != "fabric" {
        return vec![];
    }
    let Some(jar) = mod_jar(state, &inst.game_version) else { return vec![] };
    let mut args = vec![format!("-Dfabric.addMods={}", jar.display())];
    if !identity.demo {
        match game_token(state, identity).await {
            Ok(token) => args.push(format!("-Dvitra.cosmetics.token={token}")),
            Err(e) => log::warn!("Vitra badge is off for this session: {e}"),
        }
    }
    args
}

/// Whether Vitra can show badges and capes in this instance.
#[tauri::command]
pub fn cosmetics_supported(state: State<'_, Arc<AppState>>, loader: String, game_version: String) -> bool {
    loader == "fabric" && mod_jar(&state, &game_version).is_some()
}

#[tauri::command]
pub async fn cosmetics_status(state: State<'_, Arc<AppState>>) -> Result<CosmeticsStatus> {
    let resp = state.http.get(format!("{API}/v1/presets")).send().await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let presets: Vec<Preset> = serde_json::from_value(resp.json::<Value>().await?["presets"].take())?;
    let mut cape = None;
    if let Some(account) = auth::active_account(&state) {
        let resp = state.http.get(format!("{API}/v1/players/{}", account.uuid.replace('-', ""))).send().await?;
        if resp.status().is_success() {
            cape = serde_json::from_value(resp.json::<Value>().await?["cape"].take()).ok().flatten();
        }
    }
    Ok(CosmeticsStatus { cape, presets })
}

/// Sets the signed-in player's Vitra cape: a preset, an uploaded image (a PNG of 2:1 cape textures
/// stacked top to bottom, base64), or none when both are missing.
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
