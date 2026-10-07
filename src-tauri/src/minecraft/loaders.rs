//! Mod loader metadata: available versions and Fabric/Quilt launch profiles.
//! Forge and NeoForge need their installer run, see `forge.rs`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bail;
use crate::error::Result;
use crate::minecraft::manifest::VersionJson;
use crate::net;
use crate::state::AppState;

const FABRIC_META: &str = "https://meta.fabricmc.net/v2";
const QUILT_META: &str = "https://meta.quiltmc.org/v3";
const FORGE_META: &str = "https://files.minecraftforge.net/net/minecraftforge/forge";
const NEOFORGE_VERSIONS: &str = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderVersion {
    pub version: String,
    pub stable: bool,
    pub recommended: bool,
}

#[derive(Deserialize)]
struct MetaLoaderEntry {
    loader: MetaLoader,
}
#[derive(Deserialize)]
struct MetaLoader {
    version: String,
    #[serde(default)]
    stable: Option<bool>,
}
#[derive(Deserialize)]
struct MetaGame {
    version: String,
    #[serde(default)]
    stable: bool,
}

/// NeoForge versions encode the Minecraft version: `21.1.x` → 1.21.1,
/// `21.0.x` → 1.21, and since the year-based scheme `26.3.0.x` → 26.3.
pub fn neoforge_prefix(game: &str) -> Option<String> {
    let parts: Vec<&str> = game.split('.').collect();
    if parts.first() == Some(&"1") {
        let minor = parts.get(1)?;
        let patch = parts.get(2).copied().unwrap_or("0");
        Some(format!("{minor}.{patch}."))
    } else if parts.len() >= 2 && parts[0].parse::<u32>().ok()? >= 25 {
        let patch = parts.get(2).copied().unwrap_or("0");
        Some(format!("{}.{}.{}.", parts[0], parts[1], patch))
    } else {
        None
    }
}

pub(crate) fn neoforge_game_version(v: &str) -> Option<String> {
    let parts: Vec<&str> = v.split(['.', '-']).collect();
    let major: u32 = parts.first()?.parse().ok()?;
    let minor: u32 = parts.get(1)?.parse().ok()?;
    if major >= 25 {
        let patch: u32 = parts.get(2)?.parse().ok()?;
        Some(if patch == 0 { format!("{major}.{minor}") } else { format!("{major}.{minor}.{patch}") })
    } else if major >= 20 {
        Some(if minor == 0 { format!("1.{major}") } else { format!("1.{major}.{minor}") })
    } else {
        None
    }
}

async fn forge_metadata(state: &AppState) -> Result<HashMap<String, Vec<String>>> {
    net::cached_json(
        &state.http,
        &format!("{FORGE_META}/maven-metadata.json"),
        &state.cache_dir().join("forge-metadata.json"),
    )
    .await
}

async fn forge_promotions(state: &AppState) -> HashMap<String, String> {
    #[derive(Deserialize, Serialize)]
    struct Promos {
        promos: HashMap<String, String>,
    }
    net::cached_json::<Promos>(
        &state.http,
        &format!("{FORGE_META}/promotions_slim.json"),
        &state.cache_dir().join("forge-promotions.json"),
    )
    .await
    .map(|p| p.promos)
    .unwrap_or_default()
}

async fn neoforge_versions(state: &AppState) -> Result<Vec<String>> {
    #[derive(Deserialize, Serialize)]
    struct Resp {
        versions: Vec<String>,
    }
    let r: Resp = net::cached_json(&state.http, NEOFORGE_VERSIONS, &state.cache_dir().join("neoforge-versions.json")).await?;
    Ok(r.versions)
}

/// Sort key for `1.2.3[-beta.N]`: numbers compare numerically and a final
/// release sorts above its pre-releases.
fn version_key(v: &str) -> (Vec<u64>, u8, u64) {
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let nums = core.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let pre_n = pre.and_then(|p| p.rsplit('.').next()).and_then(|n| n.parse().ok()).unwrap_or(0);
    (nums, if pre.is_none() { 1 } else { 0 }, pre_n)
}

/// Loader versions available for a Minecraft version, newest first.
pub async fn loader_versions(state: &AppState, loader: &str, game: &str) -> Result<Vec<LoaderVersion>> {
    match loader {
        "fabric" | "quilt" => {
            let base = if loader == "fabric" { FABRIC_META } else { QUILT_META };
            let url = format!("{base}/versions/loader/{game}");
            let cache = state.cache_dir().join(format!("{loader}-loader-{game}.json"));
            let list: Vec<serde_json::Value> = net::cached_json(&state.http, &url, &cache).await?;
            let mut out: Vec<LoaderVersion> = list
                .into_iter()
                .filter_map(|v| serde_json::from_value::<MetaLoaderEntry>(v).ok())
                .map(|e| {
                    let stable = e.loader.stable.unwrap_or(!e.loader.version.contains("beta"));
                    LoaderVersion { version: e.loader.version, stable, recommended: false }
                })
                .collect();
            // Quilt's meta isn't ordered; show newest first.
            out.sort_by(|a, b| version_key(&b.version).cmp(&version_key(&a.version)));
            if let Some(first) = out.iter_mut().find(|v| v.stable) {
                first.recommended = true;
            }
            Ok(out)
        }
        "forge" => {
            let meta = forge_metadata(state).await?;
            let promos = forge_promotions(state).await;
            let recommended = promos.get(&format!("{game}-recommended")).cloned();
            let mut out: Vec<LoaderVersion> = meta
                .get(game)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .rev()
                .map(|full| {
                    let v = full.strip_prefix(&format!("{game}-")).unwrap_or(&full).to_string();
                    LoaderVersion { recommended: Some(&v) == recommended.as_ref(), stable: true, version: v }
                })
                .collect();
            if !out.iter().any(|v| v.recommended) {
                if let Some(first) = out.first_mut() {
                    first.recommended = true;
                }
            }
            Ok(out)
        }
        "neoforge" => {
            let Some(prefix) = neoforge_prefix(game) else { return Ok(vec![]) };
            let mut out: Vec<LoaderVersion> = neoforge_versions(state)
                .await?
                .into_iter()
                .filter(|v| v.starts_with(&prefix))
                .map(|v| LoaderVersion { stable: !v.contains("beta"), recommended: false, version: v })
                .collect();
            out.reverse();
            let pick = out.iter().position(|v| v.stable).or(if out.is_empty() { None } else { Some(0) });
            if let Some(i) = pick {
                out[i].recommended = true;
            }
            Ok(out)
        }
        _ => Ok(vec![]),
    }
}

/// Minecraft versions a loader supports (used to filter the version picker).
pub async fn supported_game_versions(state: &AppState, loader: &str) -> Result<Vec<String>> {
    match loader {
        "fabric" | "quilt" => {
            let base = if loader == "fabric" { FABRIC_META } else { QUILT_META };
            let list: Vec<serde_json::Value> = net::cached_json(
                &state.http,
                &format!("{base}/versions/game"),
                &state.cache_dir().join(format!("{loader}-game.json")),
            )
            .await?;
            Ok(list
                .into_iter()
                .filter_map(|v| serde_json::from_value::<MetaGame>(v).ok())
                .map(|g| {
                    let _ = g.stable;
                    g.version
                })
                .collect())
        }
        "forge" => Ok(forge_metadata(state).await?.into_keys().collect()),
        "neoforge" => {
            let mut seen = HashSet::new();
            Ok(neoforge_versions(state)
                .await?
                .iter()
                .filter_map(|v| neoforge_game_version(v))
                .filter(|g| seen.insert(g.clone()))
                .collect())
        }
        _ => Ok(vec![]),
    }
}

/// Picks the recommended loader version when the instance doesn't pin one.
pub async fn resolve_loader_version(state: &AppState, loader: &str, game: &str, pinned: Option<String>) -> Result<String> {
    if let Some(v) = pinned.filter(|v| !v.is_empty()) {
        return Ok(v);
    }
    let versions = loader_versions(state, loader, game).await?;
    versions
        .iter()
        .find(|v| v.recommended)
        .or(versions.first())
        .map(|v| v.version.clone())
        .ok_or_else(|| format!("{loader} doesn't support Minecraft {game} yet.").into())
}

/// Fabric/Quilt publish a ready-made launch profile; cache it next to the
/// version so offline launches keep working.
pub async fn fabric_like_profile(state: &AppState, loader: &str, game: &str, version: &str) -> Result<VersionJson> {
    let base = match loader {
        "fabric" => FABRIC_META,
        "quilt" => QUILT_META,
        _ => bail!("{loader} has no launch profile API"),
    };
    let url = format!("{base}/versions/loader/{game}/{version}/profile/json");
    let id = format!("{loader}-loader-{version}-{game}");
    let path = state.versions_dir().join(&id).join(format!("{id}.json"));
    let profile: VersionJson = net::cached_json(&state.http, &url, &path).await?;
    Ok(profile)
}

#[tauri::command]
pub async fn list_loader_versions(state: State<'_, Arc<AppState>>, loader: String, game_version: String) -> Result<Vec<LoaderVersion>> {
    loader_versions(&state, &loader, &game_version).await
}

#[tauri::command]
pub async fn list_loader_game_versions(state: State<'_, Arc<AppState>>, loader: String) -> Result<Vec<String>> {
    supported_game_versions(&state, &loader).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quilt_version_order() {
        let mut v = vec!["0.20.0-beta.9", "0.24.0", "0.20.0-beta.10", "0.20.2-beta.1"];
        v.sort_by(|a, b| version_key(b).cmp(&version_key(a)));
        assert_eq!(v, vec!["0.24.0", "0.20.2-beta.1", "0.20.0-beta.10", "0.20.0-beta.9"]);
    }

    #[test]
    fn neoforge_mapping() {
        assert_eq!(neoforge_prefix("1.21.1").as_deref(), Some("21.1."));
        assert_eq!(neoforge_prefix("1.21").as_deref(), Some("21.0."));
        assert_eq!(neoforge_prefix("26.3").as_deref(), Some("26.3.0."));
        assert_eq!(neoforge_prefix("26.1.2").as_deref(), Some("26.1.2."));
        assert_eq!(neoforge_game_version("21.1.77").as_deref(), Some("1.21.1"));
        assert_eq!(neoforge_game_version("21.0.10-beta").as_deref(), Some("1.21"));
        assert_eq!(neoforge_game_version("26.3.0.43-beta").as_deref(), Some("26.3"));
        assert_eq!(neoforge_game_version("26.1.2.5").as_deref(), Some("26.1.2"));
    }
}
