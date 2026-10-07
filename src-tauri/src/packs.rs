//! Resource packs, shader packs and the game's `options.txt`.
//!
//! Resource pack order and enabled state live in `options.txt`
//! (`resourcePacks:[...]`, lowest priority first). Shader selection lives in
//! Iris' `config/iris.properties`.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::bail;
use crate::error::Result;
use crate::instances::{self, Instance};
use crate::state::AppState;
use crate::util;

// ---------------------------------------------------------------- options.txt

/// Ordered `key:value` lines; unknown lines are preserved verbatim.
pub struct Options {
    lines: Vec<(String, String)>,
}

impl Options {
    pub fn load(path: &Path) -> Self {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let lines = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| match l.split_once(':') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => (l.to_string(), String::new()),
            })
            .collect();
        Self { lines }
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.lines.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    pub fn set(&mut self, key: &str, value: String) {
        match self.lines.iter_mut().find(|(k, _)| k == key) {
            Some(line) => line.1 = value,
            None => self.lines.push((key.to_string(), value)),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let mut out = String::new();
        for (k, v) in &self.lines {
            out.push_str(k);
            out.push(':');
            out.push_str(v);
            out.push('\n');
        }
        util::write_atomic(path, out.as_bytes())
    }

    fn list(&self, key: &str) -> Vec<String> {
        self.get(key).and_then(|v| serde_json::from_str::<Vec<String>>(v).ok()).unwrap_or_default()
    }
}

fn options_path(state: &AppState, inst: &Instance) -> PathBuf {
    instances::game_dir(state, inst).join("options.txt")
}

#[tauri::command]
pub fn get_game_options(state: State<'_, Arc<AppState>>, id: String) -> Result<HashMap<String, String>> {
    let inst = instances::load(&state, &id)?;
    let opts = Options::load(&options_path(&state, &inst));
    Ok(opts.lines.into_iter().collect())
}

/// Merges values into options.txt, matching the existing value style
/// (`true/false` vs `0/1`) when a key already exists so older versions keep
/// understanding the file.
#[tauri::command]
pub fn set_game_options(state: State<'_, Arc<AppState>>, id: String, values: HashMap<String, String>) -> Result<()> {
    if state.running.lock().unwrap().contains_key(&id) {
        bail!("Close the game first — Minecraft overwrites options.txt when it exits.");
    }
    let inst = instances::load(&state, &id)?;
    let path = options_path(&state, &inst);
    let mut opts = Options::load(&path);
    for (k, v) in values {
        if k.contains([':', '\n']) || v.contains('\n') {
            bail!("Invalid option {k}");
        }
        let v = match (opts.get(&k), v.as_str()) {
            (Some("0") | Some("1"), "true") => "1".to_string(),
            (Some("0") | Some("1"), "false") => "0".to_string(),
            _ => v,
        };
        opts.set(&k, v);
    }
    opts.save(&path)
}

// ---------------------------------------------------------------- resource packs

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePack {
    pub file_name: String,
    pub title: String,
    pub description: String,
    pub pack_format: Option<i64>,
    pub icon: Option<String>,
    pub enabled: bool,
    /// Position in the enabled list, 0 = highest priority (top).
    pub order: Option<usize>,
    pub compatible: Option<bool>,
    pub size: u64,
}

fn read_pack(path: &Path) -> (Option<serde_json::Value>, Option<Vec<u8>>) {
    if path.is_dir() {
        let meta = std::fs::read(path.join("pack.mcmeta")).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let icon = std::fs::read(path.join("pack.png")).ok();
        return (meta, icon);
    }
    let Ok(file) = std::fs::File::open(path) else { return (None, None) };
    let Ok(mut zip) = zip::ZipArchive::new(file) else { return (None, None) };
    let mut read = |name: &str| -> Option<Vec<u8>> {
        let mut e = zip.by_name(name).ok()?;
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).ok()?;
        Some(buf)
    };
    let meta = read("pack.mcmeta").and_then(|b| {
        // Some packs have a UTF-8 BOM.
        let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).map(|s| s.to_vec()).unwrap_or(b);
        serde_json::from_slice(&b).ok()
    });
    (meta, read("pack.png"))
}

/// Text from a pack description, which may be a string or a chat component.
fn description_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => strip_formatting(s),
        serde_json::Value::Array(a) => a.iter().map(description_text).collect(),
        serde_json::Value::Object(o) => {
            let mut s = o.get("text").and_then(|t| t.as_str()).map(strip_formatting).unwrap_or_default();
            if let Some(extra) = o.get("extra") {
                s.push_str(&description_text(extra));
            }
            s
        }
        _ => String::new(),
    }
}

fn strip_formatting(s: &str) -> String {
    let mut out = String::new();
    let mut skip = false;
    for c in s.chars() {
        if skip {
            skip = false;
            continue;
        }
        if c == '§' {
            skip = true;
            continue;
        }
        out.push(c);
    }
    out
}

/// The resource pack format this Minecraft version expects, read from the
/// installed client jar's `version.json`.
fn expected_pack_format(state: &AppState, inst: &Instance) -> Option<i64> {
    let jar = state.versions_dir().join(&inst.game_version).join(format!("{}.jar", inst.game_version));
    let file = std::fs::File::open(jar).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut e = zip.by_name("version.json").ok()?;
    let mut buf = Vec::new();
    e.read_to_end(&mut buf).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&buf).ok()?;
    let pv = v.get("pack_version")?;
    pv.get("resource")
        .and_then(|r| r.as_i64())
        .or_else(|| pv.get("resource_major").and_then(|r| r.as_i64()))
        .or_else(|| pv.as_i64())
}

/// Whether a pack (its `pack.mcmeta`) suits the expected format; `None` when either is unknown.
fn pack_compatible(expected: Option<i64>, meta: Option<&serde_json::Value>) -> Option<bool> {
    let pack = meta.and_then(|m| m.get("pack"));
    let format = pack.and_then(|p| p.get("pack_format")).and_then(|f| f.as_i64());
    let supported_max = pack
        .and_then(|p| p.get("supported_formats"))
        .and_then(|s| s.get("max_inclusive").or_else(|| s.get(1)))
        .and_then(|m| m.as_i64());
    match (expected, format) {
        (Some(exp), Some(f)) => Some(f == exp || supported_max.map(|m| f <= exp && exp <= m).unwrap_or(false)),
        _ => None,
    }
}

#[tauri::command]
pub fn list_resource_packs(state: State<'_, Arc<AppState>>, id: String) -> Result<Vec<ResourcePack>> {
    let inst = instances::load(&state, &id)?;
    let game_dir = instances::game_dir(&state, &inst);
    let opts = Options::load(&game_dir.join("options.txt"));
    // options.txt lists lowest priority first; the UI shows highest first.
    let enabled: Vec<String> = opts.list("resourcePacks").into_iter().rev().collect();
    let expected = expected_pack_format(&state, &inst);
    let mut packs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(game_dir.join("resourcepacks")) {
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if !(path.is_dir() || name.to_lowercase().ends_with(".zip")) {
                continue;
            }
            let (meta, icon_bytes) = read_pack(&path);
            let pack = meta.as_ref().and_then(|m| m.get("pack"));
            let format = pack.and_then(|p| p.get("pack_format")).and_then(|f| f.as_i64());
            let icon = icon_bytes.filter(|b| util::png_dimensions(b).is_some()).and_then(|b| {
                let dest = state.cache_dir().join("packicons").join(format!("{}.png", util::sha1_bytes(&b)));
                util::write_atomic(&dest, &b).ok()?;
                Some(dest.to_string_lossy().to_string())
            });
            let key = format!("file/{name}");
            let order = enabled.iter().position(|p| *p == key);
            let compatible = pack_compatible(expected, meta.as_ref());
            packs.push(ResourcePack {
                title: name.trim_end_matches(".zip").to_string(),
                description: pack.and_then(|p| p.get("description")).map(description_text).unwrap_or_default(),
                pack_format: format,
                icon,
                enabled: order.is_some(),
                order,
                compatible,
                size: e.metadata().map(|m| if m.is_file() { m.len() } else { 0 }).unwrap_or(0),
                file_name: name,
            });
        }
    }
    packs.sort_by(|a, b| match (a.order, b.order) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        _ => a.title.to_lowercase().cmp(&b.title.to_lowercase()),
    });
    Ok(packs)
}

/// `enabled` is the list of pack file names, highest priority first.
#[tauri::command]
pub fn set_resource_packs(state: State<'_, Arc<AppState>>, id: String, enabled: Vec<String>) -> Result<()> {
    if state.running.lock().unwrap().contains_key(&id) {
        bail!("Close the game first — Minecraft overwrites options.txt when it exits.");
    }
    let inst = instances::load(&state, &id)?;
    let path = options_path(&state, &inst);
    let mut opts = Options::load(&path);
    // Keep built-in entries ("vanilla", mod-provided packs) at the bottom.
    let mut list: Vec<String> = opts.list("resourcePacks").into_iter().filter(|p| !p.starts_with("file/")).collect();
    if list.is_empty() {
        list.push("vanilla".into());
    }
    for name in enabled.iter().rev() {
        if name.contains(['/', '\\']) {
            bail!("Invalid pack name");
        }
        list.push(format!("file/{name}"));
    }
    // Packs the user explicitly enabled are acknowledged even if their format
    // differs, so the game doesn't silently drop them.
    let mut incompatible: Vec<String> = opts.list("incompatibleResourcePacks");
    incompatible.retain(|p| list.contains(p));
    let expected = expected_pack_format(&state, &inst);
    let packs_dir = instances::game_dir(&state, &inst).join("resourcepacks");
    for name in &enabled {
        let key = format!("file/{name}");
        if !incompatible.contains(&key) && pack_compatible(expected, read_pack(&packs_dir.join(name)).0.as_ref()) == Some(false) {
            incompatible.push(key);
        }
    }
    opts.set("resourcePacks", serde_json::to_string(&list)?);
    opts.set("incompatibleResourcePacks", serde_json::to_string(&incompatible)?);
    opts.save(&path)
}

// ---------------------------------------------------------------- shaders

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderState {
    pub packs: Vec<ShaderPack>,
    pub active: Option<String>,
    pub enabled: bool,
    /// "iris", "oculus", "optifine" or "none".
    pub support: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShaderPack {
    pub file_name: String,
    pub title: String,
    pub size: u64,
}

fn shader_support(state: &AppState, inst: &Instance) -> String {
    let index = crate::content::load_index(state, &inst.id);
    let mods_dir = instances::game_dir(state, inst).join("mods");
    let mut names: Vec<String> = std::fs::read_dir(mods_dir)
        .map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
        .unwrap_or_default();
    names.retain(|n| n.ends_with(".jar"));
    let has = |needle: &str| {
        names.iter().any(|n| n.contains(needle))
            || index.values().any(|e| e.title.to_lowercase().contains(needle) && e.project_type == "mod")
    };
    if has("iris") {
        "iris".into()
    } else if has("oculus") {
        "oculus".into()
    } else if has("optifine") {
        "optifine".into()
    } else {
        "none".into()
    }
}

fn iris_config(state: &AppState, inst: &Instance) -> PathBuf {
    instances::game_dir(state, inst).join("config").join("iris.properties")
}

fn read_properties(path: &Path) -> Vec<(String, String)> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| match l.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (l.to_string(), String::new()),
        })
        .collect()
}

#[tauri::command]
pub fn shader_state(state: State<'_, Arc<AppState>>, id: String) -> Result<ShaderState> {
    let inst = instances::load(&state, &id)?;
    let dir = instances::game_dir(&state, &inst).join("shaderpacks");
    let mut packs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let is_pack = e.path().is_dir() || name.to_lowercase().ends_with(".zip");
            if !is_pack {
                continue;
            }
            packs.push(ShaderPack {
                title: name.trim_end_matches(".zip").to_string(),
                size: e.metadata().map(|m| if m.is_file() { m.len() } else { 0 }).unwrap_or(0),
                file_name: name,
            });
        }
    }
    packs.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    let props = read_properties(&iris_config(&state, &inst));
    let get = |k: &str| props.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    Ok(ShaderState {
        packs,
        active: get("shaderPack").filter(|s| !s.is_empty()),
        enabled: get("enableShaders").map(|v| v == "true").unwrap_or(false),
        support: shader_support(&state, &inst),
    })
}

/// Activates a shader pack in Iris (or turns shaders off with `None`).
#[tauri::command]
pub fn set_active_shader(state: State<'_, Arc<AppState>>, id: String, pack: Option<String>) -> Result<()> {
    let inst = instances::load(&state, &id)?;
    if let Some(p) = &pack {
        if p.contains(['/', '\\']) {
            bail!("Invalid shader pack name");
        }
    }
    let path = iris_config(&state, &inst);
    let mut props = read_properties(&path);
    let mut set = |k: &str, v: String| match props.iter_mut().find(|(key, _)| key == k) {
        Some(e) => e.1 = v,
        None => props.push((k.to_string(), v)),
    };
    match &pack {
        Some(p) => {
            set("shaderPack", p.clone());
            set("enableShaders", "true".into());
        }
        None => set("enableShaders", "false".into()),
    }
    let text: String = props.iter().map(|(k, v)| format!("{k}={v}\n")).collect();
    util::write_atomic(&path, text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_section_codes() {
        assert_eq!(strip_formatting("§aGreen §lBold"), "Green Bold");
    }

    #[test]
    fn options_roundtrip() {
        let dir = std::env::temp_dir().join(format!("vitra-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("options.txt");
        std::fs::write(&p, "version:3953\nrenderDistance:12\nresourcePacks:[\"vanilla\",\"file/A.zip\"]\n").unwrap();
        let mut o = Options::load(&p);
        assert_eq!(o.get("renderDistance"), Some("12"));
        assert_eq!(o.list("resourcePacks"), vec!["vanilla", "file/A.zip"]);
        o.set("renderDistance", "8".into());
        o.set("maxFps", "260".into());
        o.save(&p).unwrap();
        let o2 = Options::load(&p);
        assert_eq!(o2.get("renderDistance"), Some("8"));
        assert_eq!(o2.get("maxFps"), Some("260"));
        assert_eq!(o2.get("version"), Some("3953"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
