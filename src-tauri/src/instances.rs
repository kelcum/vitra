//! Instances ("profiles"): independent game directories with their own mods,
//! config, resource packs, worlds, Java and memory settings.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bail;
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::util;

pub const LOADERS: [&str; 5] = ["vanilla", "fabric", "quilt", "forge", "neoforge"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowSettings {
    pub custom: bool,
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self { custom: false, width: 1280, height: 720, fullscreen: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModpackRef {
    pub project_id: Option<String>,
    pub version_id: Option<String>,
    pub title: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub game_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub created_at: i64,
    pub last_played: Option<i64>,
    pub play_time_secs: u64,
    /// `None` = pick the right Mojang runtime automatically.
    pub java_path: Option<String>,
    /// `None` = use the launcher default.
    pub memory_mb: Option<u32>,
    pub jvm_preset: String,
    pub jvm_args: String,
    pub game_args: String,
    pub window: WindowSettings,
    pub game_dir: Option<String>,
    /// Resolved version id (e.g. `fabric-loader-0.19.5-1.21.1`) once installed.
    pub installed_version: Option<String>,
    pub performance_preset: Option<String>,
    pub modpack: Option<ModpackRef>,
    /// Source folder when imported from another launcher.
    pub imported_from: Option<String>,
}

impl Default for Instance {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New instance".into(),
            icon: "grass".into(),
            game_version: String::new(),
            loader: "vanilla".into(),
            loader_version: None,
            created_at: util::now_millis(),
            last_played: None,
            play_time_secs: 0,
            java_path: None,
            memory_mb: None,
            jvm_preset: "balanced".into(),
            jvm_args: String::new(),
            game_args: String::new(),
            window: WindowSettings::default(),
            game_dir: None,
            installed_version: None,
            performance_preset: None,
            modpack: None,
            imported_from: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    #[serde(flatten)]
    pub instance: Instance,
    pub path: String,
    /// Where the game actually runs (custom folder or the default one).
    pub resolved_game_dir: String,
    pub running: bool,
}

pub fn instance_dir(state: &AppState, id: &str) -> PathBuf {
    state.instances_dir().join(id)
}

pub fn game_dir(state: &AppState, inst: &Instance) -> PathBuf {
    match &inst.game_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => instance_dir(state, &inst.id).join("minecraft"),
    }
}

pub fn load(state: &AppState, id: &str) -> Result<Instance> {
    if id.contains(['/', '\\']) || id.contains("..") {
        bail!("Invalid instance id");
    }
    let path = instance_dir(state, id).join("instance.json");
    util::read_json(&path).map_err(|_| Error::Msg(format!("Instance '{id}' was not found or is damaged.")))
}

pub fn save(state: &AppState, inst: &Instance) -> Result<()> {
    util::write_json(&instance_dir(state, &inst.id).join("instance.json"), inst)
}

pub fn view(state: &AppState, inst: Instance) -> InstanceView {
    let running = state.running.lock().unwrap().contains_key(&inst.id);
    InstanceView {
        path: instance_dir(state, &inst.id).to_string_lossy().to_string(),
        resolved_game_dir: game_dir(state, &inst).to_string_lossy().to_string(),
        running,
        instance: inst,
    }
}

fn new_id(name: &str) -> String {
    let slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = slug.chars().take(24).collect();
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..6];
    if slug.is_empty() { format!("instance-{suffix}") } else { format!("{slug}-{suffix}") }
}

pub fn list_all(state: &AppState) -> Vec<Instance> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(state.instances_dir()) {
        for e in entries.flatten() {
            if let Ok(mut inst) = util::read_json::<Instance>(&e.path().join("instance.json")) {
                // The folder is the instance's identity. A folder copied by hand keeps the original's id
                // inside, and deleting "the copy" would then delete the original's folder.
                let folder = e.file_name().to_string_lossy().to_string();
                if inst.id != folder {
                    inst.id = folder;
                    let _ = save(state, &inst);
                }
                out.push(inst);
            }
        }
    }
    out.sort_by(|a, b| {
        b.last_played.unwrap_or(b.created_at).cmp(&a.last_played.unwrap_or(a.created_at))
    });
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateInstance {
    pub name: String,
    pub game_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub icon: Option<String>,
}

pub fn create(state: &AppState, req: CreateInstance) -> Result<Instance> {
    let name = req.name.trim();
    if name.is_empty() {
        bail!("Give the instance a name.");
    }
    if req.game_version.trim().is_empty() {
        bail!("Choose a Minecraft version.");
    }
    if !LOADERS.contains(&req.loader.as_str()) {
        bail!("Unsupported mod loader '{}'.", req.loader);
    }
    let inst = Instance {
        id: new_id(name),
        name: name.to_string(),
        icon: req.icon.unwrap_or_else(|| "grass".into()),
        game_version: req.game_version,
        loader: req.loader.clone(),
        loader_version: if req.loader == "vanilla" { None } else { req.loader_version },
        ..Instance::default()
    };
    let dir = instance_dir(state, &inst.id);
    std::fs::create_dir_all(dir.join("minecraft"))?;
    for sub in ["mods", "resourcepacks", "shaderpacks", "saves", "config", "screenshots"] {
        let _ = std::fs::create_dir_all(dir.join("minecraft").join(sub));
    }
    save(state, &inst)?;
    Ok(inst)
}

#[tauri::command]
pub fn list_instances(state: State<'_, Arc<AppState>>) -> Vec<InstanceView> {
    list_all(&state).into_iter().map(|i| view(&state, i)).collect()
}

#[tauri::command]
pub fn get_instance(state: State<'_, Arc<AppState>>, id: String) -> Result<InstanceView> {
    Ok(view(&state, load(&state, &id)?))
}

#[tauri::command]
pub fn create_instance(state: State<'_, Arc<AppState>>, req: CreateInstance) -> Result<InstanceView> {
    let inst = create(&state, req)?;
    state.update_settings(|s| s.selected_instance = Some(inst.id.clone()))?;
    Ok(view(&state, inst))
}

#[tauri::command]
pub fn update_instance(state: State<'_, Arc<AppState>>, instance: Instance) -> Result<InstanceView> {
    let existing = load(&state, &instance.id)?;
    if instance.name.trim().is_empty() {
        bail!("The instance name can't be empty.");
    }
    if !LOADERS.contains(&instance.loader.as_str()) {
        bail!("Unsupported mod loader.");
    }
    if let Some(mem) = instance.memory_mb {
        let total = crate::settings::total_memory_mb();
        if mem < 512 || mem > total.saturating_sub(1024).max(1024) {
            bail!("Memory must be between 512 MB and {} MB on this computer.", total.saturating_sub(1024));
        }
    }
    let mut updated = instance;
    // Changing version or loader invalidates the resolved install.
    if updated.game_version != existing.game_version
        || updated.loader != existing.loader
        || updated.loader_version != existing.loader_version
    {
        updated.installed_version = None;
    } else {
        updated.installed_version = existing.installed_version.clone();
    }
    // Fields owned by the launcher, not the editor.
    updated.created_at = existing.created_at;
    updated.play_time_secs = existing.play_time_secs;
    updated.last_played = existing.last_played;
    updated.modpack = existing.modpack.clone();
    updated.imported_from = existing.imported_from.clone();
    let folder_changed = updated.game_dir != existing.game_dir;
    save(&state, &updated)?;
    if folder_changed {
        // Let the UI show world icons and screenshots from the new folder right away.
        crate::allow_asset_dirs(&state);
    }
    Ok(view(&state, updated))
}

#[tauri::command]
pub async fn duplicate_instance(state: State<'_, Arc<AppState>>, id: String, name: String) -> Result<InstanceView> {
    let state = state.inner().clone();
    let source = load(&state, &id)?;
    let task = state.tasks.start("copy", format!("Duplicating {}", source.name), Some(id.clone()));
    task.stage("Copying files", false);
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Instance> {
        let mut copy = source.clone();
        copy.id = new_id(&name);
        copy.name = if name.trim().is_empty() { format!("{} (copy)", source.name) } else { name.trim().to_string() };
        copy.created_at = util::now_millis();
        copy.last_played = None;
        copy.play_time_secs = 0;
        copy.imported_from = None;
        let from = instance_dir(&st, &source.id);
        let to = instance_dir(&st, &copy.id);
        util::copy_dir_recursive(&from, &to)?;
        // A custom game dir would be shared; the copy gets its own.
        if let Some(custom) = &source.game_dir {
            util::copy_dir_recursive(Path::new(custom), &to.join("minecraft"))?;
            copy.game_dir = None;
        }
        save(&st, &copy)?;
        Ok(copy)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    let inst = task.complete(result)?;
    Ok(view(&state, inst))
}

#[tauri::command]
pub async fn delete_instance(state: State<'_, Arc<AppState>>, id: String) -> Result<()> {
    if state.in_use(&id) {
        bail!("Close the game before deleting this instance.");
    }
    let inst = load(&state, &id)?;
    let dir = instance_dir(&state, &inst.id);
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir))
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
    state.update_settings(|s| {
        if s.selected_instance.as_deref() == Some(id.as_str()) {
            s.selected_instance = None;
        }
    })?;
    Ok(())
}

/// Adds `dir` to the zip, named relative to `base` and placed under `prefix` ("" or "folder/"),
/// leaving out `skip`.
fn zip_dir(writer: &mut zip::ZipWriter<std::fs::File>, base: &Path, dir: &Path, prefix: &str, skip: Option<&Path>) -> Result<()> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if Some(path.as_path()) == skip {
            continue;
        }
        let rel = format!("{prefix}{}", path.strip_prefix(base).unwrap_or(&path).to_string_lossy().replace('\\', "/"));
        if entry.file_type()?.is_dir() {
            writer.add_directory(format!("{rel}/"), options)?;
            zip_dir(writer, base, &path, prefix, skip)?;
        } else {
            // Skip the session lock Minecraft holds while a world is open.
            if rel.ends_with("session.lock") {
                continue;
            }
            writer.start_file(rel, options)?;
            let mut f = std::fs::File::open(&path)?;
            std::io::copy(&mut f, writer)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn backup_instance(state: State<'_, Arc<AppState>>, id: String) -> Result<String> {
    let state = state.inner().clone();
    let inst = load(&state, &id)?;
    let task = state.tasks.start("backup", format!("Backing up {}", inst.name), Some(id.clone()));
    task.stage("Compressing files", false);
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String> {
        let stamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S");
        let out = st.backups_dir().join(format!("{}_{stamp}.zip", util::sanitize_file_name(&inst.name)));
        util::ensure_parent(&out)?;
        let file = std::fs::File::create(&out)?;
        let mut writer = zip::ZipWriter::new(file);
        let dir = instance_dir(&st, &inst.id);
        // A custom game folder goes where the default one would be (instead of it), so the backup
        // restores the same way.
        let custom = inst.game_dir.as_ref().filter(|d| !d.trim().is_empty()).map(PathBuf::from).filter(|c| !c.starts_with(&dir));
        let default_game = dir.join("minecraft");
        zip_dir(&mut writer, &dir, &dir, "", custom.as_ref().map(|_| default_game.as_path()))?;
        if let Some(custom) = &custom {
            writer.add_directory("minecraft/", zip::write::SimpleFileOptions::default())?;
            zip_dir(&mut writer, custom, custom, "minecraft/", None)?;
        }
        writer.finish()?.flush()?;
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    task.complete(result)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldInfo {
    pub instance_id: String,
    pub instance_name: String,
    pub folder: String,
    pub last_played: i64,
    pub icon: Option<String>,
    pub path: String,
}

fn worlds_of(state: &AppState, inst: &Instance) -> Vec<WorldInfo> {
    let saves = game_dir(state, inst).join("saves");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&saves) {
        for e in entries.flatten() {
            let p = e.path();
            let level = p.join("level.dat");
            let Ok(meta) = std::fs::metadata(&level) else { continue };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let icon = p.join("icon.png");
            out.push(WorldInfo {
                instance_id: inst.id.clone(),
                instance_name: inst.name.clone(),
                folder: e.file_name().to_string_lossy().to_string(),
                last_played: modified,
                icon: icon.exists().then(|| icon.to_string_lossy().to_string()),
                path: p.to_string_lossy().to_string(),
            });
        }
    }
    out.sort_by(|a, b| b.last_played.cmp(&a.last_played));
    out
}

#[tauri::command]
pub fn list_worlds(state: State<'_, Arc<AppState>>, id: String) -> Result<Vec<WorldInfo>> {
    let inst = load(&state, &id)?;
    Ok(worlds_of(&state, &inst))
}

#[tauri::command]
pub fn recent_worlds(state: State<'_, Arc<AppState>>, limit: usize) -> Vec<WorldInfo> {
    let mut all: Vec<WorldInfo> = list_all(&state).iter().flat_map(|i| worlds_of(&state, i)).collect();
    all.sort_by(|a, b| b.last_played.cmp(&a.last_played));
    all.truncate(limit);
    all
}

#[tauri::command]
pub fn recent_screenshots(state: State<'_, Arc<AppState>>, limit: usize) -> Vec<String> {
    let mut shots: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for inst in list_all(&state) {
        let dir = game_dir(&state, &inst).join("screenshots");
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.extension().map(|x| x.eq_ignore_ascii_case("png")).unwrap_or(false) {
                    if let Ok(m) = e.metadata().and_then(|m| m.modified()) {
                        shots.push((m, p));
                    }
                }
            }
        }
    }
    shots.sort_by(|a, b| b.0.cmp(&a.0));
    shots.into_iter().take(limit).map(|(_, p)| p.to_string_lossy().to_string()).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cover {
    /// "screenshot" (a full picture) or "world" (a 64×64 world icon).
    pub kind: &'static str,
    pub path: String,
}

/// A picture for each instance's library card: its newest screenshot, else its latest world's icon.
#[tauri::command]
pub fn instance_covers(state: State<'_, Arc<AppState>>) -> std::collections::HashMap<String, Cover> {
    let mut out = std::collections::HashMap::new();
    for inst in list_all(&state) {
        let newest = std::fs::read_dir(game_dir(&state, &inst).join("screenshots"))
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("png")))
            .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
            .max_by_key(|(t, _)| *t);
        let cover = match newest {
            Some((_, p)) => Some(Cover { kind: "screenshot", path: p.to_string_lossy().to_string() }),
            None => worlds_of(&state, &inst).into_iter().find_map(|w| w.icon).map(|path| Cover { kind: "world", path }),
        };
        if let Some(c) = cover {
            out.insert(inst.id.clone(), c);
        }
    }
    out
}
