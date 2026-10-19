use std::sync::Arc;

use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::auth;
use crate::bail;
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::util;

const CAPES: &str = "https://optifine.net/capes";

fn valid_name(name: &str) -> bool {
    (1..=16).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[tauri::command]
pub async fn optifine_cape(state: State<'_, Arc<AppState>>) -> Result<Option<String>> {
    let Some(account) = auth::active_account(&state) else { return Ok(None) };
    if !valid_name(&account.name) {
        return Ok(None);
    }
    let resp = state.http.get(format!("{CAPES}/{}.png", account.name)).send().await?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    let bytes = resp
        .error_for_status()
        .map_err(|e| Error::Msg(format!("Couldn't reach OptiFine's cape server: {e}")))?
        .bytes()
        .await?;
    match util::png_dimensions(&bytes) {
        Some((w, h)) if (22..=2048).contains(&w) && (17..=1024).contains(&h) => Ok(Some(util::png_data_url(&bytes))),
        _ => Ok(None),
    }
}

#[tauri::command]
pub async fn open_optifine_cape_editor(state: State<'_, Arc<AppState>>) -> Result<()> {
    let (account, token) = auth::access_token(&state).await?;
    if !valid_name(&account.name) {
        bail!("This account's name can't be used with OptiFine.");
    }
    let uuid = account.uuid.replace('-', "");
    let server_id = auth::session_join(&state, &uuid, &token).await?;
    let url = format!("https://optifine.net/capeChange?u={uuid}&n={}&s={server_id}", account.name);
    state.app.opener().open_url(url, None::<&str>).map_err(|e| Error::Msg(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_name("bfwe"));
        assert!(valid_name("Some_Player_16ch"));
        assert!(!valid_name(""));
        assert!(!valid_name("../x"));
        assert!(!valid_name("seventeen_chars__"));
    }
}
