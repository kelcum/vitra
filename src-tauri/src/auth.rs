use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, State};

use crate::bail;
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::util;

const DEVICE_CODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const SCOPE: &str = "XboxLive.signin offline_access";
const KEYRING_SERVICE: &str = "app.vitra.launcher";
const KEYRING_USER: &str = "account-token-key";
pub const MC_API: &str = "https://api.minecraftservices.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub uuid: String,
    pub name: String,
    pub owns_game: bool,
    pub added_at: i64,
    pub skin_url: Option<String>,
    pub skin_variant: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Secret {
    msa_refresh: String,
    mc_token: String,
    mc_expires_at: i64,
    xuid: String,
}

pub struct Identity {
    pub name: String,
    pub uuid: String,
    pub token: String,
    pub xuid: String,
    pub user_type: String,
    pub demo: bool,
}

fn key() -> Result<Key> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| Error::Msg(format!("Secure storage is unavailable: {e}")))?;
    let b64 = base64::engine::general_purpose::STANDARD;
    match entry.get_password() {
        Ok(s) => {
            let bytes = b64.decode(s).map_err(|_| Error::Msg("Secure storage key is damaged".into()))?;
            if bytes.len() != 32 {
                bail!("Secure storage key is damaged");
            }
            Ok(*Key::from_slice(&bytes))
        }
        Err(keyring::Error::NoEntry) => {
            let k = ChaCha20Poly1305::generate_key(&mut OsRng);
            entry
                .set_password(&b64.encode(k))
                .map_err(|e| Error::Msg(format!("Couldn't save to secure storage: {e}")))?;
            Ok(k)
        }
        Err(e) => bail!("Secure storage is unavailable: {e}"),
    }
}

fn load_secrets(state: &AppState) -> HashMap<String, Secret> {
    let path = state.root.join("accounts.secure");
    let Ok(blob) = std::fs::read(&path) else { return HashMap::new() };
    if blob.len() < 13 {
        return HashMap::new();
    }
    let Ok(k) = key() else { return HashMap::new() };
    let cipher = ChaCha20Poly1305::new(&k);
    let (nonce, data) = blob.split_at(12);
    cipher
        .decrypt(Nonce::from_slice(nonce), data)
        .ok()
        .and_then(|plain| serde_json::from_slice(&plain).ok())
        .unwrap_or_default()
}

fn save_secrets(state: &AppState, secrets: &HashMap<String, Secret>) -> Result<()> {
    let cipher = ChaCha20Poly1305::new(&key()?);
    let nonce = ChaCha20Poly1305::generate_nonce(&mut OsRng);
    let plain = serde_json::to_vec(secrets)?;
    let encrypted = cipher.encrypt(&nonce, plain.as_ref()).map_err(|_| Error::Msg("Encryption failed".into()))?;
    let mut out = nonce.to_vec();
    out.extend(encrypted);
    util::write_atomic(&state.root.join("accounts.secure"), &out)
}

pub fn load_accounts(state: &AppState) -> Vec<Account> {
    util::read_json(&state.root.join("accounts.json")).unwrap_or_default()
}

fn save_accounts(state: &AppState, accounts: &[Account]) -> Result<()> {
    util::write_json(&state.root.join("accounts.json"), &accounts)
}

#[derive(Deserialize)]
struct DeviceCodeResp {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

#[derive(Deserialize)]
struct MsaTokens {
    access_token: String,
    refresh_token: String,
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct XboxResp {
    token: String,
    display_claims: XboxClaims,
}
#[derive(Deserialize)]
struct XboxClaims {
    xui: Vec<HashMap<String, String>>,
}

const BUILTIN_CLIENT_ID: [u8; 36] = [
    0x13, 0x59, 0x12, 0x10, 0x55, 0x02, 0x0a, 0x58, 0x5c, 0x46, 0x0b, 0x01, 0x1f, 0x4a, 0x58, 0x59, 0x47, 0x11, 0x5b, 0x08, 0x15, 0x4b, 0x04, 0x17,
    0x5f, 0x0b, 0x44, 0x41, 0x58, 0x00, 0x1e, 0x06, 0x5a, 0x04, 0x41, 0x44,
];
const MASK: &[u8] = b"vitra:liquid-glass";

pub fn builtin_client_id() -> String {
    BUILTIN_CLIENT_ID.iter().zip(MASK.iter().cycle()).map(|(b, k)| (b ^ k) as char).collect()
}

fn custom_client_id(state: &AppState) -> Option<String> {
    state.settings().msa_client_id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty())
}

fn client_id(state: &AppState) -> Result<String> {
    Ok(custom_client_id(state).unwrap_or_else(builtin_client_id))
}

fn xsts_error(xerr: u64) -> String {
    match xerr {
        2148916227 => "This account was banned from Xbox services.".into(),
        2148916229 => "This account needs an adult's permission to play online. An adult can grant it at account.microsoft.com/family.".into(),
        2148916233 => "This Microsoft account doesn't have an Xbox profile yet. Sign in once at minecraft.net to create one, then try again.".into(),
        2148916235 => "Xbox Live isn't available in your country or region.".into(),
        2148916236 | 2148916237 => "This account needs age verification on xbox.com before it can sign in.".into(),
        2148916238 => "This is a child account. An adult must add it to a Microsoft family before it can play.".into(),
        other => format!("Xbox sign-in failed (error {other})."),
    }
}

async fn xbox_chain(http: &reqwest::Client, msa_access: &str) -> Result<(String, i64, String)> {
    let xbl: XboxResp = http
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .json(&json!({
            "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={msa_access}") },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await?
        .error_for_status()
        .map_err(|e| Error::Msg(format!("Xbox Live sign-in failed: {e}")))?
        .json()
        .await?;
    let uhs = xbl.display_claims.xui.first().and_then(|c| c.get("uhs").cloned()).unwrap_or_default();

    let resp = http
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .json(&json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [xbl.token] },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await?;
    if resp.status().as_u16() == 401 {
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        let xerr = body.get("XErr").and_then(|v| v.as_u64()).unwrap_or(0);
        return Err(Error::Msg(xsts_error(xerr)));
    }
    let xsts: XboxResp = resp.error_for_status().map_err(|e| Error::Msg(format!("Xbox sign-in failed: {e}")))?.json().await?;
    let xuid = xsts.display_claims.xui.first().and_then(|c| c.get("xid").cloned()).unwrap_or_default();

    let resp = http
        .post(format!("{MC_API}/authentication/login_with_xbox"))
        .json(&json!({ "identityToken": format!("XBL3.0 x={uhs};{}", xsts.token) }))
        .send()
        .await?;
    if resp.status().as_u16() == 403 {
        bail!("Minecraft rejected this sign-in: the app hasn't been approved by Mojang for Minecraft sign-in yet. Please try again later.");
    }
    let mc: serde_json::Value = resp
        .error_for_status()
        .map_err(|e| Error::Msg(format!("Minecraft sign-in failed: {e}")))?
        .json()
        .await?;
    let token = mc.get("access_token").and_then(|v| v.as_str()).ok_or("Minecraft sign-in returned no token")?;
    let expires_in = mc.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(86400);
    Ok((token.to_string(), util::now_millis() + expires_in * 1000, xuid))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub skins: Vec<McSkin>,
    #[serde(default)]
    pub capes: Vec<McCape>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McSkin {
    pub id: String,
    pub state: String,
    pub url: String,
    #[serde(default)]
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McCape {
    pub id: String,
    pub state: String,
    pub url: String,
    #[serde(default)]
    pub alias: Option<String>,
}

pub async fn fetch_profile(http: &reqwest::Client, token: &str) -> Result<Option<McProfile>> {
    let resp = http.get(format!("{MC_API}/minecraft/profile")).bearer_auth(token).send().await?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    Ok(Some(resp.error_for_status()?.json().await?))
}

async fn owns_game(http: &reqwest::Client, token: &str) -> bool {
    let Ok(resp) = http.get(format!("{MC_API}/entitlements/mcstore")).bearer_auth(token).send().await else {
        return false;
    };
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    body.get("items")
        .and_then(|i| i.as_array())
        .map(|items| {
            items.iter().any(|i| {
                matches!(i.get("name").and_then(|n| n.as_str()), Some("game_minecraft" | "product_minecraft"))
            })
        })
        .unwrap_or(false)
}

async fn finish_login(state: &AppState, msa: MsaTokens) -> Result<Account> {
    let (token, expires_at, xuid) = xbox_chain(&state.http, &msa.access_token).await?;
    let profile = fetch_profile(&state.http, &token).await?;
    let owns = owns_game(&state.http, &token).await || profile.is_some();
    let (uuid, name, skin) = match &profile {
        Some(p) => (p.id.clone(), p.name.clone(), p.skins.iter().find(|s| s.state == "ACTIVE").cloned()),
        None => (demo_uuid(&xuid), "Demo player".to_string(), None),
    };
    let account = Account {
        uuid: uuid.clone(),
        name,
        owns_game: owns && profile.is_some(),
        added_at: util::now_millis(),
        skin_url: skin.as_ref().map(|s| s.url.clone()),
        skin_variant: skin.and_then(|s| s.variant),
    };

    let mut secrets = load_secrets(state);
    secrets.insert(uuid.clone(), Secret { msa_refresh: msa.refresh_token, mc_token: token, mc_expires_at: expires_at, xuid });
    save_secrets(state, &secrets)?;

    let mut accounts = load_accounts(state);
    accounts.retain(|a| a.uuid != uuid);
    accounts.push(account.clone());
    save_accounts(state, &accounts)?;
    state.update_settings(|s| s.active_account = Some(uuid))?;
    Ok(account)
}

fn demo_uuid(seed: &str) -> String {
    let hash = util::sha1_bytes(format!("VitraDemo:{seed}").as_bytes());
    let mut chars: Vec<char> = hash.chars().take(32).collect();
    chars[12] = '3';
    chars.into_iter().collect()
}

static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn refresh(state: &AppState, uuid: &str) -> Result<(String, String)> {
    let _one_at_a_time = REFRESH_LOCK.lock().await;
    let mut secrets = load_secrets(state);
    let Some(secret) = secrets.get(uuid).cloned() else {
        bail!("SIGN_IN_AGAIN: This account's sign-in expired. Remove it and sign in again.");
    };
    if secret.mc_expires_at - util::now_millis() > 10 * 60 * 1000 {
        return Ok((secret.mc_token, secret.xuid));
    }
    let resp = state
        .http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id(state)?.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", secret.msa_refresh.as_str()),
            ("scope", SCOPE),
        ])
        .send()
        .await
        .map_err(|e| Error::Msg(format!("Couldn't reach Microsoft to refresh your sign-in: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let body: serde_json::Value = resp.json().await.unwrap_or_default();
        let code = body["error"].as_str().unwrap_or_default();
        if matches!(code, "invalid_grant" | "interaction_required" | "consent_required" | "login_required") {
            bail!("SIGN_IN_AGAIN: Microsoft asked you to sign in again. Remove the account and add it back.");
        }
        bail!("Microsoft's sign-in service isn't answering right now ({status}). Try again in a minute.");
    }
    let msa: MsaTokens = resp.json().await?;
    secrets.insert(uuid.to_string(), Secret { msa_refresh: msa.refresh_token.clone(), ..secret });
    save_secrets(state, &secrets)?;
    let (token, expires_at, xuid) = xbox_chain(&state.http, &msa.access_token).await?;
    secrets.insert(
        uuid.to_string(),
        Secret { msa_refresh: msa.refresh_token, mc_token: token.clone(), mc_expires_at: expires_at, xuid: xuid.clone() },
    );
    save_secrets(state, &secrets)?;
    Ok((token, xuid))
}

fn saved_token(state: &AppState, uuid: &str) -> Option<(String, String)> {
    load_secrets(state).get(uuid).map(|s| (s.mc_token.clone(), s.xuid.clone()))
}

pub(crate) fn sync_account_name(state: &AppState, uuid: &str, name: &str) -> Result<()> {
    let mut accounts = load_accounts(state);
    let Some(account) = accounts.iter_mut().find(|a| a.uuid.replace('-', "") == uuid.replace('-', "")) else { return Ok(()) };
    if account.name != name {
        account.name = name.to_string();
        save_accounts(state, &accounts)?;
    }
    Ok(())
}

pub(crate) fn active_account(state: &AppState) -> Option<Account> {
    let accounts = load_accounts(state);
    let active = state.settings().active_account;
    accounts
        .iter()
        .find(|a| Some(&a.uuid) == active.as_ref())
        .cloned()
        .or_else(|| accounts.first().cloned())
}

pub async fn session_join(state: &AppState, uuid: &str, token: &str) -> Result<String> {
    let server_id = uuid::Uuid::new_v4().simple().to_string();
    let resp = state
        .http
        .post("https://sessionserver.mojang.com/session/minecraft/join")
        .json(&json!({ "accessToken": token, "selectedProfile": uuid.replace('-', ""), "serverId": server_id }))
        .send()
        .await?;
    if !resp.status().is_success() {
        bail!("Mojang didn't confirm your session ({}). Try signing in again.", resp.status());
    }
    Ok(server_id)
}

pub async fn access_token(state: &AppState) -> Result<(Account, String)> {
    let Some(account) = active_account(state) else {
        bail!("NO_ACCOUNT: Sign in with a Microsoft account first.");
    };
    let (token, _) = refresh(state, &account.uuid).await?;
    Ok((account, token))
}

pub async fn launch_identity(state: &AppState, demo: bool) -> Result<Identity> {
    match active_account(state) {
        None if demo => Ok(Identity {
            name: "Player".into(),
            uuid: demo_uuid("local"),
            token: "0".into(),
            xuid: "0".into(),
            user_type: "msa".into(),
            demo: true,
        }),
        None => bail!("NO_ACCOUNT: Sign in with a Microsoft account to play, or start the free demo."),
        Some(account) => {
            let (token, xuid) = match refresh(state, &account.uuid).await {
                Ok(fresh) => fresh,
                Err(e) if !e.to_string().starts_with("SIGN_IN_AGAIN") => match saved_token(state, &account.uuid) {
                    Some(saved) => {
                        log::warn!("Couldn't refresh the sign-in ({e}); starting with the last saved one.");
                        saved
                    }
                    None => return Err(e),
                },
                Err(e) => return Err(e),
            };
            if !account.owns_game && !demo {
                bail!("NOT_OWNED: {} doesn't own Minecraft: Java Edition. You can play the free demo instead.", account.name);
            }
            Ok(Identity {
                name: account.name,
                uuid: account.uuid,
                token,
                xuid: if xuid.is_empty() { "0".into() } else { xuid },
                user_type: "msa".into(),
                demo: !account.owns_game,
            })
        }
    }
}

#[tauri::command]
pub fn list_accounts(state: State<'_, Arc<AppState>>) -> Vec<Account> {
    load_accounts(&state)
}

#[tauri::command]
pub fn set_active_account(state: State<'_, Arc<AppState>>, uuid: String) -> Result<()> {
    if !load_accounts(&state).iter().any(|a| a.uuid == uuid) {
        bail!("Unknown account");
    }
    state.update_settings(|s| s.active_account = Some(uuid))?;
    Ok(())
}

#[tauri::command]
pub fn remove_account(state: State<'_, Arc<AppState>>, uuid: String) -> Result<()> {
    let mut accounts = load_accounts(&state);
    accounts.retain(|a| a.uuid != uuid);
    save_accounts(&state, &accounts)?;
    let mut secrets = load_secrets(&state);
    if secrets.remove(&uuid).is_some() {
        save_secrets(&state, &secrets)?;
    }
    let next = accounts.first().map(|a| a.uuid.clone());
    state.update_settings(|s| {
        if s.active_account.as_deref() == Some(uuid.as_str()) {
            s.active_account = next;
        }
    })?;
    Ok(())
}

#[tauri::command]
pub async fn begin_sign_in(state: State<'_, Arc<AppState>>) -> Result<DeviceCodeInfo> {
    let state = state.inner().clone();
    let cid = client_id(&state)?;
    let resp = state.http.post(DEVICE_CODE_URL).form(&[("client_id", cid.as_str()), ("scope", SCOPE)]).send().await?;
    if !resp.status().is_success() {
        let err: OAuthError = resp.json().await.unwrap_or(OAuthError { error: "unknown".into(), error_description: None });
        bail!(
            "Microsoft refused the sign-in request ({}). Check the client ID in Settings → Accounts.{}",
            err.error,
            err.error_description.map(|d| format!("\n{}", d.lines().next().unwrap_or(""))).unwrap_or_default()
        );
    }
    let dc: DeviceCodeResp = resp.json().await?;
    let info = DeviceCodeInfo {
        user_code: dc.user_code.clone(),
        verification_uri: dc.verification_uri.clone(),
        expires_in: dc.expires_in,
    };

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    if let Some(old) = state.auth_cancel.lock().unwrap().replace(cancel_tx) {
        let _ = old.send(true);
    }
    let st = state.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = util::now_millis() + dc.expires_in as i64 * 1000;
        let mut interval = dc.interval.max(1);
        let result: Result<Account> = loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {}
                _ = cancel_rx.changed() => break Err(Error::Cancelled),
            }
            if util::now_millis() > deadline {
                break Err(Error::Msg("The sign-in code expired. Start again.".into()));
            }
            let resp = st
                .http
                .post(TOKEN_URL)
                .form(&[
                    ("client_id", cid.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                    ("device_code", dc.device_code.as_str()),
                ])
                .send()
                .await;
            let resp = match resp {
                Ok(r) => r,
                Err(_) => continue,
            };
            if resp.status().is_success() {
                match resp.json::<MsaTokens>().await {
                    Ok(t) => break finish_login(&st, t).await,
                    Err(e) => break Err(e.into()),
                }
            }
            let err: OAuthError = resp.json().await.unwrap_or(OAuthError { error: "unknown".into(), error_description: None });
            match err.error.as_str() {
                "authorization_pending" => continue,
                "slow_down" => interval += 5,
                "authorization_declined" => break Err(Error::Msg("Sign-in was declined.".into())),
                "expired_token" => break Err(Error::Msg("The sign-in code expired. Start again.".into())),
                other => break Err(Error::Msg(format!("Sign-in failed ({other})."))),
            }
        };
        match result {
            Ok(account) => {
                let _ = st.app.emit("auth://success", account);
            }
            Err(Error::Cancelled) => {}
            Err(e) => {
                let _ = st.app.emit("auth://error", e.to_string());
            }
        }
    });
    Ok(info)
}

#[tauri::command]
pub fn cancel_sign_in(state: State<'_, Arc<AppState>>) {
    if let Some(tx) = state.auth_cancel.lock().unwrap().take() {
        let _ = tx.send(true);
    }
}

#[tauri::command]
pub async fn check_active_account(state: State<'_, Arc<AppState>>) -> Result<Option<Account>> {
    let Some(account) = active_account(&state) else { return Ok(None) };
    refresh(&state, &account.uuid).await?;
    Ok(Some(account))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_client_id_is_a_guid() {
        let id = builtin_client_id();
        let groups: Vec<usize> = id.split('-').map(str::len).collect();
        assert_eq!(groups, vec![8, 4, 4, 4, 12]);
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit()));
    }
}
