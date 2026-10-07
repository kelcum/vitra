//! Local skin library plus the official Minecraft profile API for applying
//! skins and choosing capes. Capes are whatever Mojang has granted the
//! account; Vitra can't create new ones.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::auth::{self, MC_API, McProfile};
use crate::bail;
use crate::error::Result;
use crate::net;
use crate::state::AppState;
use crate::util;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSkin {
    pub id: String,
    pub name: String,
    /// "classic" (4px arms) or "slim" (3px arms).
    pub model: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSkinView {
    #[serde(flatten)]
    pub skin: SavedSkin,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapeView {
    pub id: String,
    pub alias: String,
    pub active: bool,
    pub data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub uuid: String,
    pub name: String,
    pub skin_data_url: Option<String>,
    pub skin_model: String,
    pub capes: Vec<CapeView>,
}

fn index_path(state: &AppState) -> std::path::PathBuf {
    state.skins_dir().join("index.json")
}

fn load_index(state: &AppState) -> Vec<SavedSkin> {
    util::read_json(&index_path(state)).unwrap_or_default()
}

fn save_index(state: &AppState, skins: &[SavedSkin]) -> Result<()> {
    util::write_json(&index_path(state), &skins)
}

fn validate_skin(bytes: &[u8]) -> Result<()> {
    match util::png_dimensions(bytes) {
        Some((64, 64)) | Some((64, 32)) => Ok(()),
        Some((w, h)) => bail!("Minecraft skins must be 64×64 or 64×32 pixels; this image is {w}×{h}."),
        None => bail!("That file isn't a PNG image."),
    }
}

/// Mojang texture URLs are cached locally and handed to the 3D viewer as data
/// URLs (textures.minecraft.net doesn't allow cross-origin requests).
async fn texture_data_url(state: &AppState, url: &str) -> Option<String> {
    let url = url.replace("http://", "https://");
    let cache = state.cache_dir().join("textures").join(format!("{}.png", util::sha1_bytes(url.as_bytes())));
    if let Ok(bytes) = std::fs::read(&cache) {
        return Some(util::png_data_url(&bytes));
    }
    let bytes = net::get_bytes(&state.http, &url).await.ok()?;
    let _ = util::write_atomic(&cache, &bytes);
    Some(util::png_data_url(&bytes))
}

#[tauri::command]
pub fn list_skins(state: State<'_, Arc<AppState>>) -> Vec<SavedSkinView> {
    load_index(&state)
        .into_iter()
        .filter_map(|skin| {
            let bytes = std::fs::read(state.skins_dir().join(format!("{}.png", skin.id))).ok()?;
            Some(SavedSkinView { data_url: util::png_data_url(&bytes), skin })
        })
        .collect()
}

/// Validates a skin PNG and adds it to the front of the library.
fn add_to_library(state: &AppState, bytes: &[u8], name: &str, model: &str) -> Result<SavedSkinView> {
    validate_skin(bytes)?;
    let skin = SavedSkin {
        id: uuid::Uuid::new_v4().simple().to_string(),
        name: if name.trim().is_empty() { "Untitled skin".into() } else { name.trim().chars().take(48).collect() },
        model: if model == "slim" { "slim" } else { "classic" }.to_string(),
        added_at: util::now_millis(),
    };
    util::write_atomic(&state.skins_dir().join(format!("{}.png", skin.id)), bytes)?;
    let mut index = load_index(state);
    index.insert(0, skin.clone());
    save_index(state, &index)?;
    Ok(SavedSkinView { data_url: util::png_data_url(bytes), skin })
}

#[tauri::command]
pub fn import_skin(state: State<'_, Arc<AppState>>, path: String, name: String, model: String) -> Result<SavedSkinView> {
    let bytes = std::fs::read(&path)?;
    add_to_library(&state, &bytes, &name, &model)
}

#[tauri::command]
pub fn update_skin(state: State<'_, Arc<AppState>>, id: String, name: String, model: String) -> Result<()> {
    let mut index = load_index(&state);
    let Some(skin) = index.iter_mut().find(|s| s.id == id) else { bail!("Skin not found") };
    if !name.trim().is_empty() {
        skin.name = name.trim().to_string();
    }
    skin.model = if model == "slim" { "slim".into() } else { "classic".into() };
    save_index(&state, &index)
}

#[tauri::command]
pub fn delete_skin(state: State<'_, Arc<AppState>>, id: String) -> Result<()> {
    let mut index = load_index(&state);
    index.retain(|s| s.id != id);
    save_index(&state, &index)?;
    let _ = std::fs::remove_file(state.skins_dir().join(format!("{id}.png")));
    Ok(())
}

async fn profile_view(state: &AppState, profile: McProfile) -> ProfileView {
    let active = profile.skins.iter().find(|s| s.state == "ACTIVE");
    let skin_data_url = match active {
        Some(s) => texture_data_url(state, &s.url).await,
        None => None,
    };
    let mut capes = Vec::new();
    for c in &profile.capes {
        capes.push(CapeView {
            id: c.id.clone(),
            alias: c.alias.clone().unwrap_or_else(|| "Cape".into()),
            active: c.state == "ACTIVE",
            data_url: texture_data_url(state, &c.url).await,
        });
    }
    ProfileView {
        uuid: profile.id,
        name: profile.name,
        skin_data_url,
        skin_model: active
            .and_then(|s| s.variant.clone())
            .map(|v| if v.eq_ignore_ascii_case("slim") { "slim".into() } else { "classic".into() })
            .unwrap_or_else(|| "classic".into()),
        capes,
    }
}

/// The signed-in account's live skin and capes.
#[tauri::command]
pub async fn get_profile(state: State<'_, Arc<AppState>>) -> Result<ProfileView> {
    let (_, token) = auth::access_token(&state).await?;
    let Some(profile) = auth::fetch_profile(&state.http, &token).await? else {
        bail!("This account has no Minecraft profile (it doesn't own Java Edition).");
    };
    Ok(profile_view(&state, profile).await)
}

/// Uploads a saved skin to the account. It shows up in-game everywhere.
#[tauri::command]
pub async fn apply_skin(state: State<'_, Arc<AppState>>, id: String) -> Result<ProfileView> {
    let skin = load_index(&state).into_iter().find(|s| s.id == id).ok_or("Skin not found")?;
    let bytes = std::fs::read(state.skins_dir().join(format!("{id}.png")))?;
    validate_skin(&bytes)?;
    let (_, token) = auth::access_token(&state).await?;
    let part = reqwest::multipart::Part::bytes(bytes).file_name("skin.png").mime_str("image/png")?;
    let form = reqwest::multipart::Form::new().text("variant", skin.model.clone()).part("file", part);
    let resp = state
        .http
        .post(format!("{MC_API}/minecraft/profile/skins"))
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await?;
    if resp.status().as_u16() == 429 {
        bail!("Mojang is rate-limiting skin changes. Wait a minute and try again.");
    }
    if !resp.status().is_success() {
        bail!("Mojang rejected the skin ({}).", resp.status());
    }
    let profile: McProfile = resp.json().await?;
    Ok(profile_view(&state, profile).await)
}

/// Shows the given cape, or hides capes entirely when `cape_id` is `None`.
#[tauri::command]
pub async fn set_cape(state: State<'_, Arc<AppState>>, cape_id: Option<String>) -> Result<ProfileView> {
    let (_, token) = auth::access_token(&state).await?;
    let url = format!("{MC_API}/minecraft/profile/capes/active");
    let resp = match &cape_id {
        Some(id) => state.http.put(&url).bearer_auth(&token).json(&json!({ "capeId": id })).send().await?,
        None => state.http.delete(&url).bearer_auth(&token).send().await?,
    };
    if !resp.status().is_success() {
        bail!("Mojang rejected the cape change ({}).", resp.status());
    }
    let profile: McProfile = resp.json().await?;
    Ok(profile_view(&state, profile).await)
}

/// Saves the account's current skin into the local library.
#[tauri::command]
pub async fn save_current_skin(state: State<'_, Arc<AppState>>) -> Result<SavedSkinView> {
    let (account, token) = auth::access_token(&state).await?;
    let profile = auth::fetch_profile(&state.http, &token).await?.ok_or("No Minecraft profile")?;
    let active = profile.skins.iter().find(|s| s.state == "ACTIVE").ok_or("This account has no skin set")?;
    let bytes = net::get_bytes(&state.http, &active.url.replace("http://", "https://")).await?;
    let slim = active.variant.as_deref().map(|v| v.eq_ignore_ascii_case("slim")).unwrap_or(false);
    add_to_library(&state, &bytes, &format!("{}'s skin", account.name), if slim { "slim" } else { "classic" })
}

// ------------------------------------------------------------------ find skins

/// A skin found by player name or link, not yet in the library.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundSkin {
    /// Player name, or a name taken from the link.
    pub name: String,
    /// "player" or "link".
    pub source: String,
    pub data_url: String,
    /// "classic" or "slim"; links can't tell, so they default to classic.
    pub model: String,
}

const SESSION_PROFILE: &str = "https://sessionserver.mojang.com/session/minecraft/profile";
/// Skins are a few KB; anything bigger isn't one.
const MAX_SKIN_BYTES: usize = 1024 * 1024;

fn valid_player_name(name: &str) -> bool {
    (1..=16).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Looks up any player's current skin by name through Mojang's public API.
#[tauri::command]
pub async fn find_player_skin(state: State<'_, Arc<AppState>>, name: String) -> Result<FoundSkin> {
    let name = name.trim();
    if !valid_player_name(name) {
        bail!("Player names are 1 to 16 letters, numbers or underscores.");
    }
    let resp = state.http.get(format!("{MC_API}/minecraft/profile/lookup/name/{name}")).send().await?;
    match resp.status().as_u16() {
        200 => {}
        204 | 404 => bail!("No Minecraft player is called {name}."),
        429 => bail!("Too many lookups in a row. Wait a few seconds and try again."),
        s => bail!("Mojang's player lookup isn't answering right now ({s})."),
    }
    #[derive(Deserialize)]
    struct Lookup {
        id: String,
        name: String,
    }
    let player: Lookup = resp.json().await?;

    #[derive(Deserialize)]
    struct Property {
        name: String,
        value: String,
    }
    #[derive(Deserialize)]
    struct Profile {
        #[serde(default)]
        properties: Vec<Property>,
    }
    let profile: Profile = state
        .http
        .get(format!("{SESSION_PROFILE}/{}", player.id))
        .send()
        .await?
        .error_for_status()
        .map_err(|e| crate::error::Error::Msg(format!("Couldn't read {}'s profile: {e}", player.name)))?
        .json()
        .await?;
    let textures = profile
        .properties
        .iter()
        .find(|p| p.name == "textures")
        .and_then(|p| base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &p.value).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let skin = textures.as_ref().map(|t| &t["textures"]["SKIN"]);
    let Some(url) = skin.and_then(|s| s["url"].as_str()) else {
        bail!("{} uses one of Minecraft's default skins.", player.name);
    };
    let slim = skin.and_then(|s| s["metadata"]["model"].as_str()) == Some("slim");
    let data_url = texture_data_url(&state, url).await.ok_or("Couldn't download that skin. Try again in a moment.")?;
    Ok(FoundSkin {
        name: player.name,
        source: "player".into(),
        data_url,
        model: if slim { "slim" } else { "classic" }.into(),
    })
}

/// Fetches a skin PNG from a link, such as a skin site's download link or a
/// textures.minecraft.net address.
#[tauri::command]
pub async fn fetch_skin_link(state: State<'_, Arc<AppState>>, url: String) -> Result<FoundSkin> {
    let url = url.trim();
    let parsed = reqwest::Url::parse(url).map_err(|_| crate::error::Error::Msg("That isn't a valid link.".into()))?;
    let url = match (parsed.scheme(), parsed.host_str()) {
        ("https", Some(_)) => parsed.to_string(),
        // Mojang's own texture links are published as http; the same file is served over https.
        ("http", Some("textures.minecraft.net")) => parsed.to_string().replacen("http://", "https://", 1),
        _ => bail!("Only secure (https) links are supported."),
    };
    let resp = state
        .http
        .get(&url)
        .send()
        .await?
        .error_for_status()
        .map_err(|e| crate::error::Error::Msg(format!("Couldn't download that link: {e}")))?;
    if resp.content_length().is_some_and(|n| n as usize > MAX_SKIN_BYTES) {
        bail!("That file is too big to be a Minecraft skin.");
    }
    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_SKIN_BYTES {
        bail!("That file is too big to be a Minecraft skin.");
    }
    if util::png_dimensions(&bytes).is_none() {
        bail!("That link isn't a PNG image. On skin sites, copy the link of the Download button.");
    }
    validate_skin(&bytes)?;
    let name = reqwest::Url::parse(&url)
        .ok()
        .and_then(|u| u.path_segments().and_then(|mut s| s.next_back().map(str::to_string)))
        .map(|f| f.trim_end_matches(".png").replace(['-', '_'], " "))
        .filter(|n| !n.is_empty() && n.len() <= 40 && !n.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or_else(|| "Skin from link".into());
    Ok(FoundSkin { name, source: "link".into(), data_url: util::png_data_url(&bytes), model: "classic".into() })
}

/// Saves a found skin (a PNG data URL) into the library.
#[tauri::command]
pub fn save_found_skin(state: State<'_, Arc<AppState>>, name: String, model: String, data_url: String) -> Result<SavedSkinView> {
    let Some(b64) = data_url.strip_prefix("data:image/png;base64,") else {
        bail!("That skin couldn't be read.");
    };
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
        .map_err(|_| crate::error::Error::Msg("That skin couldn't be read.".into()))?;
    if bytes.len() > MAX_SKIN_BYTES {
        bail!("That file is too big to be a Minecraft skin.");
    }
    add_to_library(&state, &bytes, &name, &model)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_names() {
        assert!(valid_player_name("Notch"));
        assert!(valid_player_name("jeb_"));
        assert!(!valid_player_name(""));
        assert!(!valid_player_name("has space"));
        assert!(!valid_player_name("../../etc"));
        assert!(!valid_player_name("waytoolongname_17"));
    }
}
