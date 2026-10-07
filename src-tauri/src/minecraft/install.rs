//! Installs everything an instance needs to launch: version JSONs, loader
//! profile, Java runtime, client jar, libraries, natives and assets.
//! Re-running an install is cheap — present files are skipped — so launching
//! always goes through here to self-heal missing files.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bail;
use crate::error::{Error, Result};
use crate::instances::{self, Instance};
use crate::java;
use crate::minecraft::forge;
use crate::minecraft::loaders;
use crate::minecraft::manifest::{MANIFEST_URL, ManifestEntry, VersionJson, VersionManifest};
use crate::net::{self, Download};
use crate::state::AppState;
use crate::tasks::TaskHandle;
use crate::util;

pub struct Installed {
    pub version: VersionJson,
    pub java: PathBuf,
    pub client_jar: PathBuf,
    pub natives_dir: PathBuf,
    /// Directory passed as `${game_assets}` for pre-1.7 versions.
    pub legacy_assets: Option<PathBuf>,
}

/// The version manifest, cached in memory for 10 minutes and on disk for
/// offline use.
pub async fn manifest(state: &AppState) -> Result<VersionManifest> {
    let mut guard = state.manifest.lock().await;
    if let Some((at, m)) = guard.as_ref() {
        if util::now_millis() - at < 10 * 60 * 1000 {
            return Ok(m.clone());
        }
    }
    let m: VersionManifest =
        net::cached_json(&state.http, MANIFEST_URL, &state.cache_dir().join("version_manifest_v2.json")).await?;
    *guard = Some((util::now_millis(), m.clone()));
    Ok(m)
}

pub async fn vanilla_json(state: &AppState, id: &str) -> Result<VersionJson> {
    let path = state.versions_dir().join(id).join(format!("{id}.json"));
    match manifest(state).await {
        Ok(m) => {
            let entry = m
                .versions
                .iter()
                .find(|v| v.id == id)
                .ok_or_else(|| Error::Msg(format!("Minecraft {id} doesn't exist in Mojang's version list.")))?;
            net::fetch_file(&state.http, &entry.url, &path, entry.sha1.as_deref()).await?;
        }
        Err(e) if !path.exists() => return Err(e),
        Err(_) => {}
    }
    util::read_json(&path)
}

fn library_jobs(state: &AppState, version: &VersionJson) -> Vec<Download> {
    let libs = state.libraries_dir();
    let mut jobs = Vec::new();
    for lib in &version.libraries {
        if !lib.is_allowed() {
            continue;
        }
        if let Some((rel, url, sha1, size)) = lib.artifact() {
            if !url.is_empty() {
                jobs.push(Download::new(url, libs.join(rel)).sha1(sha1).size(size));
            }
        }
        if let Some(native) = lib.native_artifact() {
            if let Some(rel) = native.path {
                jobs.push(Download::new(native.url, libs.join(rel)).sha1(native.sha1).size(native.size));
            }
        }
    }
    jobs
}

#[derive(Deserialize)]
struct AssetIndex {
    objects: HashMap<String, AssetObject>,
    #[serde(default, rename = "virtual")]
    is_virtual: bool,
    #[serde(default)]
    map_to_resources: bool,
}
#[derive(Deserialize)]
struct AssetObject {
    hash: String,
    size: u64,
}

async fn asset_index(state: &AppState, version: &VersionJson) -> Result<Option<(String, AssetIndex)>> {
    let Some(idx) = &version.asset_index else { return Ok(None) };
    let path = state.assets_dir().join("indexes").join(format!("{}.json", idx.id));
    net::fetch_file(&state.http, &idx.url, &path, Some(&idx.sha1)).await?;
    Ok(Some((idx.id.clone(), util::read_json(&path)?)))
}

fn asset_jobs(state: &AppState, index: &AssetIndex) -> Vec<Download> {
    let objects = state.assets_dir().join("objects");
    index
        .objects
        .values()
        .map(|o| {
            let prefix = &o.hash[..2];
            Download::new(
                format!("https://resources.download.minecraft.net/{prefix}/{}", o.hash),
                objects.join(prefix).join(&o.hash),
            )
            .sha1(Some(o.hash.clone()))
            .size(Some(o.size))
        })
        .collect()
}

/// Pre-1.7 versions read assets by name from a "virtual" folder or the game
/// directory's `resources` folder.
fn place_legacy_assets(state: &AppState, id: &str, index: &AssetIndex, game_dir: &Path) -> Result<Option<PathBuf>> {
    if !index.is_virtual && !index.map_to_resources {
        return Ok(None);
    }
    let target = if index.map_to_resources {
        game_dir.join("resources")
    } else {
        state.assets_dir().join("virtual").join(id)
    };
    let objects = state.assets_dir().join("objects");
    for (name, o) in &index.objects {
        let dest = util::safe_join(&target, name)?;
        if dest.exists() {
            continue;
        }
        util::ensure_parent(&dest)?;
        std::fs::copy(objects.join(&o.hash[..2]).join(&o.hash), &dest)?;
    }
    Ok(Some(target))
}

/// Extracts old-style native libraries (pre-1.19) into the natives folder.
fn extract_natives(state: &AppState, version: &VersionJson, dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    for lib in &version.libraries {
        if !lib.is_allowed() {
            continue;
        }
        let Some(native) = lib.native_artifact() else { continue };
        let Some(rel) = native.path else { continue };
        let jar = state.libraries_dir().join(rel);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&jar)?)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let name = entry.name().to_string();
            if entry.is_dir() || name.starts_with("META-INF") {
                continue;
            }
            let dest = util::safe_join(dir, &name)?;
            if dest.exists() {
                continue;
            }
            util::ensure_parent(&dest)?;
            let mut buf = Vec::new();
            entry.read_to_end(&mut buf)?;
            std::fs::write(&dest, buf)?;
        }
    }
    Ok(())
}

async fn resolve_java(state: &AppState, task: &TaskHandle, inst: &Instance, vanilla: &VersionJson) -> Result<PathBuf> {
    if let Some(custom) = inst.java_path.as_ref().filter(|p| !p.trim().is_empty()) {
        let p = PathBuf::from(custom);
        if !p.exists() {
            bail!("The Java path set for this instance no longer exists: {custom}. Pick another in the instance's Java settings, or switch back to Automatic.");
        }
        return Ok(p);
    }
    java::ensure_runtime(state, task, &vanilla.java_component(), vanilla.java_major()).await
}

/// Newest Java version each ASM release can read. Loaders that bundle an
/// older ASM than the game's class files need crash at startup with
/// "Unsupported class file major version" — catch that before launching.
fn asm_max_java(version: &str) -> Option<u32> {
    let mut parts = version.split(|c: char| c == '.' || c == '-').map(|p| p.parse::<u32>().ok());
    let major = parts.next()??;
    let minor = parts.next().flatten().unwrap_or(0);
    let patch = parts.next().flatten().unwrap_or(0);
    if major != 9 {
        return if major > 9 { Some(u32::MAX) } else { Some(15) };
    }
    Some(match (minor, patch) {
        (0..=4, _) => 16 + minor,
        (5, _) => 21,
        (6, _) => 22,
        (7, 0) => 23,
        (7, _) => 24,
        (8, _) => 25,
        (m, _) => 17 + m, // 9.9 → 26, 9.10 → 27, …
    })
}

fn check_asm_support(version: &VersionJson, loader: &str, loader_version: &str, game: &str) -> Result<()> {
    let needed = version.java_major();
    for lib in &version.libraries {
        if let Some(v) = lib.name.strip_prefix("org.ow2.asm:asm:") {
            if let Some(max) = asm_max_java(v) {
                if max < needed {
                    let name = match loader {
                        "quilt" => "Quilt Loader",
                        "fabric" => "Fabric Loader",
                        _ => "This mod loader",
                    };
                    bail!(
                        "{name} {loader_version} can't run Minecraft {game} yet: it bundles ASM {v}, which can't read Java {needed} classes. Pick a newer loader version, use Fabric for this Minecraft version, or choose an older Minecraft version."
                    );
                }
            }
        }
    }
    Ok(())
}

/// Installs (or repairs, when `verify` is set) an instance. Persists the
/// resolved loader version so it never changes silently.
pub async fn install_instance(state: &AppState, task: &TaskHandle, mut inst: Instance, verify: bool) -> Result<Installed> {
    task.stage("Reading version information", false);
    let vanilla = vanilla_json(state, &inst.game_version).await?;
    let vanilla_id = vanilla.id.clone();

    // Java first: Forge's installer processors need it.
    let java = resolve_java(state, task, &inst, &vanilla).await?;
    task.check_cancelled()?;

    // Client jar is needed by Forge processors too.
    let client_jar = state.versions_dir().join(&vanilla_id).join(format!("{vanilla_id}.jar"));
    let client = vanilla
        .downloads
        .as_ref()
        .and_then(|d| d.get("client"))
        .ok_or_else(|| Error::Msg(format!("Minecraft {vanilla_id} has no client download.")))?;

    let loader = inst.loader.clone();
    let loader_profile = if loader == "vanilla" {
        None
    } else {
        task.stage(format!("Resolving {loader} version"), false);
        let lv = loaders::resolve_loader_version(state, &loader, &inst.game_version, inst.loader_version.clone()).await?;
        if inst.loader_version.as_deref() != Some(lv.as_str()) {
            inst.loader_version = Some(lv.clone());
            instances::save(state, &inst)?;
        }
        Some(match loader.as_str() {
            "fabric" | "quilt" => loaders::fabric_like_profile(state, &loader, &inst.game_version, &lv).await?,
            "forge" | "neoforge" => {
                task.stage("Downloading Minecraft", true);
                net::download_all(
                    state,
                    task,
                    vec![Download::new(client.url.clone(), client_jar.clone()).sha1(client.sha1.clone()).size(client.size)],
                    verify,
                )
                .await?;
                forge::install(state, task, &loader, &inst.game_version, &lv, &java, &client_jar).await?
            }
            other => bail!("Unsupported loader {other}"),
        })
    };
    let version = match loader_profile {
        Some(profile) => profile.merge_onto(vanilla.clone()),
        None => vanilla.clone(),
    };
    check_asm_support(&version, &loader, inst.loader_version.as_deref().unwrap_or(""), &inst.game_version)?;

    task.stage("Checking game files", false);
    let index = asset_index(state, &version).await?;
    let mut jobs = vec![Download::new(client.url.clone(), client_jar.clone()).sha1(client.sha1.clone()).size(client.size)];
    jobs.extend(library_jobs(state, &version));
    if let Some((_, idx)) = &index {
        jobs.extend(asset_jobs(state, idx));
    }
    if let Some(log) = version.logging.as_ref().and_then(|l| l.client.as_ref()) {
        jobs.push(
            Download::new(log.file.url.clone(), state.assets_dir().join("log_configs").join(&log.file.id))
                .sha1(Some(log.file.sha1.clone()))
                .size(Some(log.file.size)),
        );
    }
    task.stage("Downloading game files", true);
    net::download_all(state, task, jobs, verify).await?;
    task.check_cancelled()?;

    task.stage("Preparing libraries", false);
    let natives_dir = state.versions_dir().join(&version.id).join("natives");
    let game_dir = instances::game_dir(state, &inst);
    std::fs::create_dir_all(&game_dir)?;
    let legacy_assets = match &index {
        Some((id, idx)) => place_legacy_assets(state, id, idx, &game_dir)?,
        None => None,
    };
    extract_natives(state, &version, &natives_dir)?;

    if inst.installed_version.as_deref() != Some(version.id.as_str()) {
        inst.installed_version = Some(version.id.clone());
        instances::save(state, &inst)?;
    }

    Ok(Installed { version, java, client_jar, natives_dir, legacy_assets })
}

#[cfg(test)]
mod tests {
    use super::asm_max_java;

    #[test]
    fn asm_support_table() {
        assert_eq!(asm_max_java("9.6"), Some(22));
        assert_eq!(asm_max_java("9.7.1"), Some(24));
        assert_eq!(asm_max_java("9.8"), Some(25));
        assert_eq!(asm_max_java("9.10.1"), Some(27));
        assert_eq!(asm_max_java("9.2"), Some(18));
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersion {
    pub id: String,
    pub kind: String,
    pub release_time: String,
}

#[tauri::command]
pub async fn list_game_versions(state: State<'_, Arc<AppState>>) -> Result<Vec<GameVersion>> {
    let m = manifest(&state).await?;
    Ok(m.versions
        .into_iter()
        .map(|ManifestEntry { id, kind, release_time, .. }| GameVersion { id, kind, release_time })
        .collect())
}

#[tauri::command]
pub async fn latest_release(state: State<'_, Arc<AppState>>) -> Result<String> {
    Ok(manifest(&state).await?.latest.release)
}

/// Installs or repairs an instance in the background. Returns the task id.
#[tauri::command]
pub async fn install_instance_cmd(state: State<'_, Arc<AppState>>, id: String, verify: bool) -> Result<String> {
    let state = state.inner().clone();
    let inst = instances::load(&state, &id)?;
    let title = if verify { format!("Repairing {}", inst.name) } else { format!("Installing {}", inst.name) };
    let task = state.tasks.start("install", title, Some(id));
    let task_id = task.id().to_string();
    tauri::async_runtime::spawn(async move {
        let result = install_instance(&state, &task, inst, verify).await;
        let _ = task.complete(result.map(|_| ()));
    });
    Ok(task_id)
}
