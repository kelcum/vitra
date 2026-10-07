//! Installed content (mods, resource packs, shader packs) for an instance.
//!
//! Each instance keeps `content.json`, an index of what each file is
//! (Modrinth project/version, hashes, title, icon). Files added by hand are
//! identified by hash through Modrinth, or by reading their mod metadata.
//! Removing content moves it to the instance's `.trash` so it can be restored.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::bail;
use crate::error::{Error, Result};
use crate::instances::{self, Instance};
use crate::modrinth::{self, MrVersion};
use crate::net::{self, Download};
use crate::state::AppState;
use crate::util;

pub fn compatible_loaders(loader: &str, project_type: &str) -> Vec<&'static str> {
    match project_type {
        "mod" => match loader {
            "fabric" => vec!["fabric"],
            "quilt" => vec!["quilt", "fabric"],
            "forge" => vec!["forge"],
            "neoforge" => vec!["neoforge"],
            _ => vec![],
        },
        "resourcepack" => vec!["minecraft"],
        "shader" => vec!["iris", "optifine", "canvas", "vanilla"],
        _ => vec![],
    }
}

pub fn folder_for(project_type: &str) -> Result<&'static str> {
    Ok(match project_type {
        "mod" => "mods",
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        other => bail!("Unsupported content type '{other}'"),
    })
}

fn type_for_folder(folder: &str) -> &'static str {
    match folder {
        "mods" => "mod",
        "resourcepacks" => "resourcepack",
        _ => "shader",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ContentEntry {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub title: String,
    pub version_number: Option<String>,
    pub icon_url: Option<String>,
    pub local_icon: Option<String>,
    pub sha1: Option<String>,
    pub sha512: Option<String>,
    pub size: u64,
    pub url: Option<String>,
    pub project_type: String,
    /// "modrinth" or "local".
    pub source: String,
    pub installed_at: i64,
}

type ContentIndex = HashMap<String, ContentEntry>;

fn index_path(state: &AppState, id: &str) -> PathBuf {
    instances::instance_dir(state, id).join("content.json")
}

pub fn load_index(state: &AppState, id: &str) -> ContentIndex {
    util::read_json(&index_path(state, id)).unwrap_or_default()
}

pub fn save_index(state: &AppState, id: &str, index: &ContentIndex) -> Result<()> {
    util::write_json(&index_path(state, id), index)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentItem {
    pub key: String,
    pub file_name: String,
    pub enabled: bool,
    pub size: u64,
    pub title: String,
    pub version: Option<String>,
    pub icon_url: Option<String>,
    pub local_icon: Option<String>,
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub source: String,
    pub modified: i64,
}

struct FoundFile {
    key: String,
    file_name: String,
    path: PathBuf,
    enabled: bool,
    size: u64,
    modified: i64,
}

fn scan_folder(game_dir: &Path, folder: &str) -> Vec<FoundFile> {
    let dir = game_dir.join(folder);
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(meta) = e.metadata() else { continue };
        let enabled = !name.ends_with(".disabled");
        let base = name.trim_end_matches(".disabled").to_string();
        let lower = base.to_lowercase();
        let ok = match folder {
            "mods" => meta.is_file() && lower.ends_with(".jar"),
            _ => meta.is_dir() || lower.ends_with(".zip"),
        };
        if !ok {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(FoundFile {
            key: format!("{folder}/{base}"),
            file_name: name,
            path: e.path(),
            enabled,
            size: if meta.is_file() { meta.len() } else { 0 },
            modified,
        });
    }
    out
}

/// Reads display name, version and icon from a mod jar's metadata.
fn local_mod_metadata(state: &AppState, path: &Path, sha1: &str) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(file) = std::fs::File::open(path) else { return (None, None, None) };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return (None, None, None) };
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let mut e = zip.by_name(name).ok()?;
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    let mut name = None;
    let mut version = None;
    let mut icon_path: Option<String> = None;
    if let Some(raw) = read("fabric.mod.json") {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) {
            name = v.get("name").and_then(|x| x.as_str()).map(String::from);
            version = v.get("version").and_then(|x| x.as_str()).map(String::from);
            icon_path = match v.get("icon") {
                Some(serde_json::Value::String(s)) => Some(s.clone()),
                Some(serde_json::Value::Object(m)) => m.values().last().and_then(|x| x.as_str()).map(String::from),
                _ => None,
            };
        }
    } else if let Some(raw) = read("quilt.mod.json") {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&raw) {
            let ql = v.get("quilt_loader");
            version = ql.and_then(|q| q.get("version")).and_then(|x| x.as_str()).map(String::from);
            let meta = ql.and_then(|q| q.get("metadata"));
            name = meta.and_then(|m| m.get("name")).and_then(|x| x.as_str()).map(String::from);
            icon_path = meta.and_then(|m| m.get("icon")).and_then(|x| x.as_str()).map(String::from);
        }
    } else if let Some(raw) = read("META-INF/neoforge.mods.toml").or_else(|| read("META-INF/mods.toml")) {
        let text = String::from_utf8_lossy(&raw);
        let value = |key: &str| {
            text.lines().find_map(|l| {
                let l = l.trim();
                let rest = l.strip_prefix(key)?.trim_start().strip_prefix('=')?.trim();
                Some(rest.trim_matches('"').to_string())
            })
        };
        name = value("displayName");
        version = value("version").filter(|v| !v.contains("${"));
        icon_path = value("logoFile");
    }
    let icon = icon_path.and_then(|p| {
        let bytes = read(p.trim_start_matches('/'))?;
        util::png_dimensions(&bytes)?;
        let dest = state.cache_dir().join("icons").join(format!("{sha1}.png"));
        util::write_atomic(&dest, &bytes).ok()?;
        Some(dest.to_string_lossy().to_string())
    });
    (name, version, icon)
}

/// Brings the index in line with the folder and identifies new files.
pub async fn refresh(state: &AppState, inst: &Instance, folder: &str) -> Result<Vec<ContentItem>> {
    let game_dir = instances::game_dir(state, inst);
    let found = scan_folder(&game_dir, folder);
    let mut index = load_index(state, &inst.id);

    // Hash files the index doesn't know (or whose size changed).
    let mut unknown: Vec<(String, PathBuf, u64)> = Vec::new();
    for f in &found {
        let known = index.get(&f.key).map(|e| e.size == f.size).unwrap_or(false);
        if !known && f.path.is_file() {
            unknown.push((f.key.clone(), f.path.clone(), f.size));
        }
    }
    let hashed: Vec<(String, PathBuf, u64, String)> = tokio::task::spawn_blocking(move || {
        unknown
            .into_iter()
            .filter_map(|(k, p, s)| util::sha1_file(&p).ok().map(|h| (k, p, s, h)))
            .collect()
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;

    if !hashed.is_empty() {
        let hashes: Vec<String> = hashed.iter().map(|(_, _, _, h)| h.clone()).collect();
        let lookup = modrinth::versions_by_hash(state, &hashes).await;
        let identified = lookup.as_ref().ok();
        let project_ids: Vec<String> = identified
            .map(|m| m.values().map(|v| v.project_id.clone()).collect::<HashSet<_>>().into_iter().collect())
            .unwrap_or_default();
        let projects: HashMap<String, modrinth::MrProject> = modrinth::projects(state, &project_ids)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.id.clone(), p))
            .collect();
        for (key, path, size, sha1) in hashed {
            let ptype = type_for_folder(folder).to_string();
            if let Some(v) = identified.and_then(|m| m.get(&sha1)) {
                let file = v.files.iter().find(|f| f.hashes.get("sha1") == Some(&sha1));
                let p = projects.get(&v.project_id);
                index.insert(
                    key,
                    ContentEntry {
                        project_id: Some(v.project_id.clone()),
                        version_id: Some(v.id.clone()),
                        title: p.map(|p| p.title.clone()).unwrap_or_else(|| v.name.clone()),
                        version_number: Some(v.version_number.clone()),
                        icon_url: p.and_then(|p| p.icon_url.clone()),
                        local_icon: None,
                        sha1: Some(sha1),
                        sha512: file.and_then(|f| f.hashes.get("sha512").cloned()),
                        size,
                        url: file.map(|f| f.url.clone()),
                        project_type: ptype,
                        source: "modrinth".into(),
                        installed_at: util::now_millis(),
                    },
                );
            } else if lookup.is_ok() {
                let (name, version, icon) = if folder == "mods" {
                    local_mod_metadata(state, &path, &sha1)
                } else {
                    (None, None, None)
                };
                let fallback = key.rsplit('/').next().unwrap_or(&key).trim_end_matches(".jar").trim_end_matches(".zip").to_string();
                index.insert(
                    key,
                    ContentEntry {
                        title: name.unwrap_or(fallback),
                        version_number: version,
                        local_icon: icon,
                        sha1: Some(sha1),
                        size,
                        project_type: ptype,
                        source: "local".into(),
                        installed_at: util::now_millis(),
                        ..Default::default()
                    },
                );
            }
        }
    }

    // Forget entries whose files are gone (other folders untouched).
    let present: HashSet<&String> = found.iter().map(|f| &f.key).collect();
    index.retain(|k, _| !k.starts_with(&format!("{folder}/")) || present.contains(k));
    save_index(state, &inst.id, &index)?;

    let mut items: Vec<ContentItem> = found
        .into_iter()
        .map(|f| {
            let e = index.get(&f.key).cloned().unwrap_or_default();
            let fallback = f.key.rsplit('/').next().unwrap_or(&f.key).to_string();
            ContentItem {
                title: if e.title.is_empty() { fallback } else { e.title },
                version: e.version_number,
                icon_url: e.icon_url,
                local_icon: e.local_icon,
                project_id: e.project_id,
                version_id: e.version_id,
                source: if e.source.is_empty() { "local".into() } else { e.source },
                key: f.key,
                file_name: f.file_name,
                enabled: f.enabled,
                size: f.size,
                modified: f.modified,
            }
        })
        .collect();
    items.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(items)
}

#[tauri::command]
pub async fn list_content(state: State<'_, Arc<AppState>>, id: String, project_type: String) -> Result<Vec<ContentItem>> {
    let inst = instances::load(&state, &id)?;
    refresh(&state, &inst, folder_for(&project_type)?).await
}

fn locate(game_dir: &Path, key: &str) -> Result<(PathBuf, bool)> {
    let (folder, base) = key.split_once('/').ok_or("Invalid content key")?;
    if base.contains(['/', '\\']) || base.contains("..") || !["mods", "resourcepacks", "shaderpacks"].contains(&folder) {
        bail!("Invalid content key");
    }
    let enabled = game_dir.join(folder).join(base);
    if enabled.exists() {
        return Ok((enabled, true));
    }
    let disabled = game_dir.join(folder).join(format!("{base}.disabled"));
    if disabled.exists() {
        return Ok((disabled, false));
    }
    bail!("{base} is no longer in the instance folder.")
}

#[tauri::command]
pub fn set_content_enabled(state: State<'_, Arc<AppState>>, id: String, key: String, enabled: bool) -> Result<()> {
    let inst = instances::load(&state, &id)?;
    let game_dir = instances::game_dir(&state, &inst);
    let (path, is_enabled) = locate(&game_dir, &key)?;
    if is_enabled == enabled {
        return Ok(());
    }
    let (folder, base) = key.split_once('/').unwrap();
    let target = if enabled {
        game_dir.join(folder).join(base)
    } else {
        game_dir.join(folder).join(format!("{base}.disabled"))
    };
    std::fs::rename(path, target)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub trash_name: String,
    pub key: String,
    pub title: String,
    pub removed_at: i64,
    pub entry: Option<ContentEntry>,
    pub was_enabled: bool,
}

fn trash_dir(state: &AppState, id: &str) -> PathBuf {
    instances::instance_dir(state, id).join(".trash")
}

fn load_trash(state: &AppState, id: &str) -> Vec<TrashItem> {
    util::read_json(&trash_dir(state, id).join("trash.json")).unwrap_or_default()
}

fn save_trash(state: &AppState, id: &str, items: &[TrashItem]) -> Result<()> {
    util::write_json(&trash_dir(state, id).join("trash.json"), &items)
}

fn trash_file(state: &AppState, inst: &Instance, key: &str) -> Result<()> {
    let game_dir = instances::game_dir(state, inst);
    let (path, was_enabled) = locate(&game_dir, key)?;
    let base = key.split_once('/').map(|(_, b)| b).unwrap_or(key);
    let trash_name = format!("{}_{}", util::now_millis(), base);
    let dest = trash_dir(state, &inst.id).join(&trash_name);
    util::ensure_parent(&dest)?;
    std::fs::rename(&path, &dest)?;
    let mut index = load_index(state, &inst.id);
    let entry = index.remove(key);
    save_index(state, &inst.id, &index)?;
    let mut trash = load_trash(state, &inst.id);
    trash.insert(
        0,
        TrashItem {
            trash_name,
            key: key.to_string(),
            title: entry.as_ref().map(|e| e.title.clone()).unwrap_or_else(|| base.to_string()),
            removed_at: util::now_millis(),
            entry,
            was_enabled,
        },
    );
    save_trash(state, &inst.id, &trash)
}

#[tauri::command]
pub fn remove_content(state: State<'_, Arc<AppState>>, id: String, keys: Vec<String>) -> Result<()> {
    let inst = instances::load(&state, &id)?;
    for key in keys {
        trash_file(&state, &inst, &key)?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_trash(state: State<'_, Arc<AppState>>, id: String) -> Vec<TrashItem> {
    load_trash(&state, &id)
}

#[tauri::command]
pub fn restore_trash(state: State<'_, Arc<AppState>>, id: String, trash_name: String) -> Result<()> {
    let inst = instances::load(&state, &id)?;
    let mut trash = load_trash(&state, &id);
    let pos = trash.iter().position(|t| t.trash_name == trash_name).ok_or("Item not found in trash")?;
    let item = trash.remove(pos);
    let (folder, base) = item.key.split_once('/').ok_or("Invalid key")?;
    let name = if item.was_enabled { base.to_string() } else { format!("{base}.disabled") };
    let dest = instances::game_dir(&state, &inst).join(folder).join(name);
    if dest.exists() {
        bail!("A file named {base} already exists in {folder}.");
    }
    util::ensure_parent(&dest)?;
    std::fs::rename(trash_dir(&state, &id).join(&item.trash_name), &dest)?;
    if let Some(entry) = item.entry {
        let mut index = load_index(&state, &id);
        index.insert(item.key.clone(), entry);
        save_index(&state, &id, &index)?;
    }
    save_trash(&state, &id, &trash)
}

#[tauri::command]
pub fn empty_trash(state: State<'_, Arc<AppState>>, id: String) -> Result<()> {
    instances::load(&state, &id)?;
    let dir = trash_dir(&state, &id);
    if dir.exists() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- install plans

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedFile {
    pub project_id: String,
    pub version_id: String,
    pub title: String,
    pub icon_url: Option<String>,
    pub version_number: String,
    pub file_name: String,
    pub url: String,
    pub sha1: Option<String>,
    pub sha512: Option<String>,
    pub size: u64,
    pub project_type: String,
    /// "requested", "dependency" or "update".
    pub reason: String,
    pub required_by: Option<String>,
    pub replaces: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    pub instance_id: String,
    pub files: Vec<PlannedFile>,
    pub warnings: Vec<String>,
    /// Problems the user must acknowledge before installing.
    pub conflicts: Vec<String>,
    /// Requested items that won't be installed, with the reason.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub project_id: String,
    pub version_id: Option<String>,
    pub project_type: String,
    #[serde(default)]
    pub title: Option<String>,
}

fn pick_version(versions: Vec<MrVersion>) -> Option<(MrVersion, bool)> {
    let release = versions.iter().find(|v| v.version_type == "release").cloned();
    match release {
        Some(v) => Some((v, true)),
        None => versions.into_iter().next().map(|v| (v, false)),
    }
}

pub async fn plan(state: &AppState, inst: &Instance, requests: Vec<PlanRequest>) -> Result<InstallPlan> {
    let game = inst.game_version.clone();
    let index = load_index(state, &inst.id);
    let installed: HashMap<String, (String, ContentEntry)> = index
        .iter()
        .filter_map(|(k, e)| e.project_id.clone().map(|p| (p, (k.clone(), e.clone()))))
        .collect();

    let mut plan = InstallPlan { instance_id: inst.id.clone(), files: vec![], warnings: vec![], conflicts: vec![], skipped: vec![] };
    let mut queue: VecDeque<(PlanRequest, String, Option<String>)> =
        requests.into_iter().map(|r| (r, "requested".to_string(), None)).collect();
    let mut seen = HashSet::new();
    let mut incompatible: Vec<(String, String)> = Vec::new();

    while let Some((req, reason, required_by)) = queue.pop_front() {
        if !seen.insert(req.project_id.clone()) {
            continue;
        }
        let label = req.title.clone().unwrap_or_else(|| req.project_id.clone());
        if req.project_type == "mod" && inst.loader == "vanilla" {
            plan.skipped.push(format!(
                "{label}: mods need a mod loader. Create a Fabric or NeoForge instance, or change this instance's loader."
            ));
            continue;
        }
        if reason == "dependency" && installed.contains_key(&req.project_id) {
            continue;
        }
        let loaders = compatible_loaders(&inst.loader, &req.project_type);
        let chosen = match &req.version_id {
            Some(vid) => match modrinth::version(state, vid).await {
                Ok(v) => {
                    if req.project_type == "mod" && !v.game_versions.contains(&game) {
                        plan.warnings.push(format!("{label} {} isn't marked as compatible with Minecraft {game}.", v.version_number));
                    }
                    Some((v, true))
                }
                Err(_) => None,
            },
            None => {
                let strict = modrinth::project_versions(state, &req.project_id, Some(&loaders), Some(&game)).await?;
                if strict.is_empty() && req.project_type != "mod" {
                    // Packs often work across versions; fall back with a warning.
                    let any = modrinth::project_versions(state, &req.project_id, None, None).await?;
                    let picked = pick_version(any);
                    if picked.is_some() {
                        plan.warnings.push(format!("{label} isn't marked for Minecraft {game}; installing its latest version anyway."));
                    }
                    picked
                } else {
                    pick_version(strict)
                }
            }
        };
        let Some((version, is_release)) = chosen else {
            let msg = format!("{label} has no version for {} on Minecraft {game}.", loader_label(&inst.loader, &req.project_type));
            match required_by {
                Some(parent) => plan.conflicts.push(format!("{parent} needs {label}, but {}", msg.trim_start_matches(&format!("{label} ")))),
                None => plan.skipped.push(msg),
            }
            continue;
        };
        // Requests may use slugs while dependencies use ids: de-duplicate on the real id.
        if plan.files.iter().any(|f| f.project_id == version.project_id) {
            continue;
        }
        seen.insert(version.project_id.clone());
        if reason == "dependency" && installed.contains_key(&version.project_id) {
            continue;
        }
        if !is_release {
            plan.warnings.push(format!("{label}: only beta/alpha versions are available ({}).", version.version_number));
        }
        let mut replaces = None;
        if let Some((key, entry)) = installed.get(&version.project_id) {
            if entry.version_id.as_deref() == Some(version.id.as_str()) {
                plan.skipped.push(format!("{} is already installed and up to date.", entry.title));
                continue;
            }
            replaces = Some(key.clone());
        }
        let Some(file) = version.primary_file().cloned() else {
            plan.skipped.push(format!("{label} has no downloadable file."));
            continue;
        };
        for dep in &version.dependencies {
            match dep.dependency_type.as_str() {
                "required" => {
                    let pid = match (&dep.project_id, &dep.version_id) {
                        (Some(p), _) => Some(p.clone()),
                        (None, Some(v)) => modrinth::version(state, v).await.ok().map(|v| v.project_id),
                        _ => None,
                    };
                    match pid {
                        Some(pid) => queue.push_back((
                            PlanRequest {
                                project_id: pid,
                                version_id: dep.version_id.clone(),
                                project_type: "mod".into(),
                                title: None,
                            },
                            "dependency".into(),
                            Some(label.clone()),
                        )),
                        None => plan.warnings.push(format!(
                            "{label} needs {}, which isn't on Modrinth. Install it manually.",
                            dep.file_name.clone().unwrap_or_else(|| "an external file".into())
                        )),
                    }
                }
                "incompatible" => {
                    if let Some(p) = &dep.project_id {
                        incompatible.push((label.clone(), p.clone()));
                    }
                }
                _ => {}
            }
        }
        plan.files.push(PlannedFile {
            project_id: version.project_id.clone(),
            version_id: version.id.clone(),
            title: label,
            icon_url: None,
            version_number: version.version_number.clone(),
            file_name: file.filename.clone(),
            url: file.url.clone(),
            sha1: file.hashes.get("sha1").cloned(),
            sha512: file.hashes.get("sha512").cloned(),
            size: file.size,
            project_type: req.project_type.clone(),
            reason: if replaces.is_some() && reason == "requested" { "update".into() } else { reason },
            required_by,
            replaces,
        });
    }

    // Fill in titles/icons in one request.
    let ids: Vec<String> = plan.files.iter().map(|f| f.project_id.clone()).collect();
    let mut titles: HashMap<String, String> = HashMap::new();
    if let Ok(projects) = modrinth::projects(state, &ids).await {
        for p in projects {
            titles.insert(p.id.clone(), p.title.clone());
            for f in plan.files.iter_mut().filter(|f| f.project_id == p.id) {
                f.title = p.title.clone();
                f.icon_url = p.icon_url.clone();
            }
        }
    }
    for f in plan.files.iter_mut() {
        if let Some(parent) = &f.required_by {
            if let Some(t) = plan_title(&titles, parent) {
                f.required_by = Some(t);
            }
        }
    }

    // Incompatibilities against what's installed or being installed.
    for (who, other) in incompatible {
        let hit = installed.get(&other).map(|(_, e)| e.title.clone()).or_else(|| {
            plan.files.iter().find(|f| f.project_id == other).map(|f| f.title.clone())
        });
        if let Some(name) = hit {
            let who = plan_title(&titles, &who).unwrap_or(who);
            plan.conflicts.push(format!("{who} is marked as incompatible with {name}."));
        }
    }
    Ok(plan)
}

fn plan_title(titles: &HashMap<String, String>, id_or_title: &str) -> Option<String> {
    titles.get(id_or_title).cloned()
}

fn loader_label(loader: &str, project_type: &str) -> String {
    if project_type != "mod" {
        return "this".into();
    }
    match loader {
        "fabric" => "Fabric".into(),
        "quilt" => "Quilt".into(),
        "forge" => "Forge".into(),
        "neoforge" => "NeoForge".into(),
        other => other.into(),
    }
}

pub async fn apply(state: &AppState, plan: InstallPlan) -> Result<()> {
    let inst = instances::load(state, &plan.instance_id)?;
    let game_dir = instances::game_dir(state, &inst);
    let title = match plan.files.len() {
        1 => format!("Installing {}", plan.files[0].title),
        n => format!("Installing {n} items"),
    };
    let task = state.tasks.start("content", title, Some(inst.id.clone()));
    let result = async {
        task.stage("Downloading", true);
        let mut jobs = Vec::new();
        for f in &plan.files {
            let folder = folder_for(&f.project_type)?;
            if f.file_name.contains(['/', '\\']) || f.file_name.contains("..") {
                bail!("Refusing unsafe file name {}", f.file_name);
            }
            if !f.url.starts_with("https://") {
                bail!("Refusing non-HTTPS download for {}", f.title);
            }
            jobs.push(
                Download::new(f.url.clone(), game_dir.join(folder).join(&f.file_name))
                    .sha1(f.sha1.clone())
                    .size(Some(f.size)),
            );
        }
        net::download_all(state, &task, jobs, true).await?;

        task.stage("Finishing", false);
        for f in &plan.files {
            if let Some(old) = &f.replaces {
                let new_key = format!("{}/{}", folder_for(&f.project_type)?, f.file_name);
                if *old != new_key {
                    let _ = trash_file(state, &inst, old);
                }
            }
        }
        let mut index = load_index(state, &inst.id);
        for f in &plan.files {
            let key = format!("{}/{}", folder_for(&f.project_type)?, f.file_name);
            index.insert(
                key,
                ContentEntry {
                    project_id: Some(f.project_id.clone()),
                    version_id: Some(f.version_id.clone()),
                    title: f.title.clone(),
                    version_number: Some(f.version_number.clone()),
                    icon_url: f.icon_url.clone(),
                    local_icon: None,
                    sha1: f.sha1.clone(),
                    sha512: f.sha512.clone(),
                    size: f.size,
                    url: Some(f.url.clone()),
                    project_type: f.project_type.clone(),
                    source: "modrinth".into(),
                    installed_at: util::now_millis(),
                },
            );
        }
        save_index(state, &inst.id, &index)?;
        Ok(())
    }
    .await;
    let _ = state.app.emit("content://changed", serde_json::json!({ "instanceId": inst.id }));
    task.complete(result)
}

#[tauri::command]
pub async fn plan_install(state: State<'_, Arc<AppState>>, id: String, requests: Vec<PlanRequest>) -> Result<InstallPlan> {
    let inst = instances::load(&state, &id)?;
    plan(&state, &inst, requests).await
}

#[tauri::command]
pub async fn apply_plan(state: State<'_, Arc<AppState>>, plan: InstallPlan) -> Result<()> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let _ = apply(&state, plan).await;
    });
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub key: String,
    pub project_id: String,
    pub title: String,
    pub current_version: Option<String>,
    pub new_version: String,
    pub version_id: String,
    pub project_type: String,
}

#[tauri::command]
pub async fn check_updates(state: State<'_, Arc<AppState>>, id: String, project_type: String) -> Result<Vec<UpdateInfo>> {
    let inst = instances::load(&state, &id)?;
    let folder = folder_for(&project_type)?;
    refresh(&state, &inst, folder).await?;
    let index = load_index(&state, &id);
    let entries: Vec<(&String, &ContentEntry)> = index
        .iter()
        .filter(|(k, e)| k.starts_with(&format!("{folder}/")) && e.source == "modrinth" && e.sha1.is_some())
        .collect();
    let hashes: Vec<String> = entries.iter().filter_map(|(_, e)| e.sha1.clone()).collect();
    let loaders = compatible_loaders(&inst.loader, &project_type);
    let latest = modrinth::latest_by_hash(&state, &hashes, &loaders, &inst.game_version).await?;
    let mut out = Vec::new();
    for (key, e) in entries {
        let Some(v) = e.sha1.as_ref().and_then(|h| latest.get(h)) else { continue };
        if Some(&v.id) != e.version_id.as_ref() {
            out.push(UpdateInfo {
                key: key.clone(),
                project_id: v.project_id.clone(),
                title: e.title.clone(),
                current_version: e.version_number.clone(),
                new_version: v.version_number.clone(),
                version_id: v.id.clone(),
                project_type: project_type.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(out)
}

/// Copies local files (drag & drop / file picker) into the right folder.
#[tauri::command]
pub fn import_content_files(state: State<'_, Arc<AppState>>, id: String, project_type: String, paths: Vec<String>) -> Result<usize> {
    let inst = instances::load(&state, &id)?;
    let folder = folder_for(&project_type)?;
    let dir = instances::game_dir(&state, &inst).join(folder);
    std::fs::create_dir_all(&dir)?;
    let mut count = 0;
    for p in paths {
        let src = PathBuf::from(&p);
        let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let lower = name.to_lowercase();
        let ok = match folder {
            "mods" => lower.ends_with(".jar"),
            _ => lower.ends_with(".zip"),
        };
        if !ok {
            bail!(
                "{name} isn't a {}.",
                if folder == "mods" { "mod (.jar)" } else { "pack (.zip)" }
            );
        }
        std::fs::copy(&src, dir.join(&name))?;
        count += 1;
    }
    Ok(count)
}
