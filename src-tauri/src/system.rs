//! System information, news, panorama extraction, logs, folders and storage.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::bail;
use crate::error::{Error, Result};
use crate::instances;
use crate::net;
use crate::settings;
use crate::state::AppState;
use crate::util;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub cpu: String,
    pub cores: usize,
    pub threads: usize,
    pub total_memory_mb: u32,
    pub available_memory_mb: u32,
    pub gpus: Vec<String>,
    pub launcher_memory_mb: u32,
    pub recommended_vanilla_mb: u32,
    pub recommended_modded_mb: u32,
}

fn gpus() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // Full path: PATH can be minimal when launched from shortcuts or tools.
                let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
                let ps = std::path::Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
                let out = std::process::Command::new(if ps.exists() { ps.as_os_str() } else { std::ffi::OsStr::new("powershell") })
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
                    ])
                    .creation_flags(0x0800_0000)
                    .output();
                if let Ok(o) = out {
                    return String::from_utf8_lossy(&o.stdout)
                        .lines()
                        .map(|l| l.trim().to_string())
                        .filter(|l| !l.is_empty())
                        .collect();
                }
            }
            Vec::new()
        })
        .clone()
}

#[tauri::command]
pub async fn system_info() -> Result<SystemInfo> {
    tokio::task::spawn_blocking(|| {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        sys.refresh_cpu_all();
        let pid = sysinfo::Pid::from_u32(std::process::id());
        sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        let launcher_mem = sys.process(pid).map(|p| p.memory()).unwrap_or(0);
        let cpu = sys.cpus().first().map(|c| c.brand().trim().to_string()).unwrap_or_default();
        SystemInfo {
            os: sysinfo::System::long_os_version().unwrap_or_else(|| std::env::consts::OS.to_string()),
            cpu,
            cores: sysinfo::System::physical_core_count().unwrap_or(0),
            threads: sys.cpus().len(),
            total_memory_mb: (sys.total_memory() / 1024 / 1024) as u32,
            available_memory_mb: (sys.available_memory() / 1024 / 1024) as u32,
            gpus: gpus(),
            launcher_memory_mb: (launcher_mem / 1024 / 1024) as u32,
            recommended_vanilla_mb: settings::recommended_memory_mb(false),
            recommended_modded_mb: settings::recommended_memory_mb(true),
        }
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))
}

// ---------------------------------------------------------------- news

const NEWS_BASE: &str = "https://launchercontent.mojang.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchNote {
    pub id: String,
    pub title: String,
    pub version: String,
    pub kind: String,
    pub date: String,
    pub short_text: String,
    pub image: Option<String>,
    pub content_path: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesFile {
    entries: Vec<serde_json::Value>,
}

#[tauri::command]
pub async fn patch_notes(state: State<'_, Arc<AppState>>, limit: usize) -> Result<Vec<PatchNote>> {
    let file: NotesFile = net::cached_json(
        &state.http,
        &format!("{NEWS_BASE}/v2/javaPatchNotes.json"),
        &state.cache_dir().join("patch-notes.json"),
    )
    .await?;
    Ok(file
        .entries
        .into_iter()
        .filter_map(|e| {
            let s = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            Some(PatchNote {
                id: s("id"),
                title: s("title"),
                version: s("version"),
                kind: s("type"),
                date: s("date"),
                short_text: s("shortText"),
                image: e.get("image").and_then(|i| i.get("url")).and_then(|u| u.as_str()).map(|u| format!("{NEWS_BASE}{u}")),
                content_path: s("contentPath"),
            })
        })
        .take(limit)
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBlock {
    pub kind: String,
    pub text: String,
}

fn decode_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&rsquo;", "\u{2019}")
        .replace("&lsquo;", "\u{2018}")
        .replace("&ldquo;", "\u{201c}")
        .replace("&rdquo;", "\u{201d}")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&amp;", "&")
}

/// Converts patch-note HTML into plain text blocks. The launcher never
/// renders remote HTML directly.
pub fn html_to_blocks(html: &str) -> Vec<TextBlock> {
    let mut blocks = Vec::new();
    let mut kind = "p".to_string();
    let mut text = String::new();
    let mut rest = html;
    let flush = |blocks: &mut Vec<TextBlock>, kind: &str, text: &mut String| {
        let t = decode_entities(text.trim());
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        if !t.is_empty() {
            blocks.push(TextBlock { kind: kind.to_string(), text: t });
        }
        text.clear();
    };
    while let Some(start) = rest.find('<') {
        text.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else { break };
        let tag = rest[start + 1..start + end].trim().to_lowercase();
        let name: String = tag.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        let closing = tag.starts_with('/');
        if !closing && (name == "script" || name == "style") {
            // Drop the element's contents entirely.
            let close = format!("</{name}");
            let after = &rest[start + end + 1..];
            rest = match after.to_lowercase().find(&close) {
                Some(i) => after[i..].find('>').map(|j| &after[i + j + 1..]).unwrap_or(""),
                None => "",
            };
            continue;
        }
        match name.as_str() {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "li" | "br" | "div" | "ul" | "ol" => {
                flush(&mut blocks, &kind, &mut text);
                kind = if closing || name == "br" || name == "div" || name == "ul" || name == "ol" {
                    "p".into()
                } else if name.starts_with('h') {
                    "h".into()
                } else {
                    name.clone()
                };
            }
            _ => {}
        }
        rest = &rest[start + end + 1..];
    }
    text.push_str(rest);
    flush(&mut blocks, &kind, &mut text);
    blocks
}

#[tauri::command]
pub async fn patch_note_body(state: State<'_, Arc<AppState>>, content_path: String) -> Result<Vec<TextBlock>> {
    if content_path.contains("..") || !content_path.starts_with("javaPatchNotes/") || !content_path.ends_with(".json") {
        bail!("Invalid patch note");
    }
    let v: serde_json::Value = net::get_json(&state.http, &format!("{NEWS_BASE}/v2/{content_path}")).await?;
    let body = v.get("body").and_then(|b| b.as_str()).unwrap_or_default();
    Ok(html_to_blocks(body))
}

// ---------------------------------------------------------------- panorama

/// Extracts the title-screen panorama from the newest installed vanilla
/// client jar (the player's own copy of the game).
#[tauri::command]
pub async fn panorama(state: State<'_, Arc<AppState>>) -> Result<Vec<String>> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<String>> {
        let mut jars: Vec<(std::time::SystemTime, String, PathBuf)> = Vec::new();
        for e in std::fs::read_dir(state.versions_dir()).map_err(|_| Error::Msg("NO_VERSION".into()))?.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            let jar = e.path().join(format!("{id}.jar"));
            if let Ok(m) = std::fs::metadata(&jar).and_then(|m| m.modified()) {
                jars.push((m, id, jar));
            }
        }
        jars.sort_by(|a, b| b.0.cmp(&a.0));
        let Some((_, id, jar)) = jars.into_iter().next() else { bail!("NO_VERSION") };
        let out_dir = state.cache_dir().join("panorama").join(&id);
        let paths: Vec<PathBuf> = (0..6).map(|i| out_dir.join(format!("panorama_{i}.png"))).collect();
        if !paths.iter().all(|p| p.exists()) {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&jar)?)?;
            for (i, p) in paths.iter().enumerate() {
                let name = format!("assets/minecraft/textures/gui/title/background/panorama_{i}.png");
                let mut e = zip.by_name(&name).map_err(|_| Error::Msg("NO_PANORAMA".into()))?;
                let mut buf = Vec::new();
                e.read_to_end(&mut buf)?;
                util::write_atomic(p, &buf)?;
            }
        }
        Ok(paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
}

#[tauri::command]
pub fn import_background(state: State<'_, Arc<AppState>>, path: String) -> Result<String> {
    let src = PathBuf::from(&path);
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !["png", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
        bail!("Choose a PNG, JPG or WebP image.");
    }
    let bytes = std::fs::read(&src)?;
    if bytes.len() > 25 * 1024 * 1024 {
        bail!("That image is larger than 25 MB.");
    }
    let dest = state.root.join("backgrounds").join(format!("{}.{ext}", util::sha1_bytes(&bytes)));
    util::write_atomic(&dest, &bytes)?;
    Ok(dest.to_string_lossy().to_string())
}

// ---------------------------------------------------------------- folders & links

fn is_managed_path(state: &AppState, path: &Path) -> bool {
    let candidates = [state.root.clone(), state.data_dir()];
    let custom: Vec<PathBuf> = instances::list_all(state)
        .into_iter()
        .filter_map(|i| i.game_dir.map(PathBuf::from))
        .collect();
    let Ok(canon) = path.canonicalize() else { return false };
    candidates.iter().chain(custom.iter()).any(|base| base.canonicalize().map(|b| canon.starts_with(b)).unwrap_or(false))
}

/// Opens a folder or file that belongs to the launcher in the system file manager.
#[tauri::command]
pub fn open_path(state: State<'_, Arc<AppState>>, path: String) -> Result<()> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        bail!("That folder doesn't exist anymore.");
    }
    if !is_managed_path(&state, &p) {
        bail!("Vitra only opens its own folders.");
    }
    state
        .app
        .opener()
        .open_path(p.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| Error::Msg(e.to_string()))
}

#[tauri::command]
pub fn open_instance_folder(state: State<'_, Arc<AppState>>, id: String, sub: Option<String>) -> Result<()> {
    let inst = instances::load(&state, &id)?;
    let mut dir = instances::game_dir(&state, &inst);
    if let Some(s) = sub.filter(|s| !s.is_empty()) {
        dir = util::safe_join(&dir, &s)?;
    }
    std::fs::create_dir_all(&dir)?;
    state
        .app
        .opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| Error::Msg(e.to_string()))
}

#[tauri::command]
pub fn open_url(state: State<'_, Arc<AppState>>, url: String) -> Result<()> {
    if !url.starts_with("https://") {
        bail!("Only secure (https) links can be opened.");
    }
    state.app.opener().open_url(url, None::<&str>).map_err(|e| Error::Msg(e.to_string()))
}

// ---------------------------------------------------------------- logs

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    /// "log" or "crash".
    pub kind: String,
    pub modified: i64,
    pub size: u64,
}

#[tauri::command]
pub fn list_logs(state: State<'_, Arc<AppState>>, id: String) -> Result<Vec<LogFile>> {
    let inst = instances::load(&state, &id)?;
    let game_dir = instances::game_dir(&state, &inst);
    let mut out = Vec::new();
    for (folder, kind) in [("crash-reports", "crash"), ("logs", "log")] {
        if let Ok(entries) = std::fs::read_dir(game_dir.join(folder)) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let ok = name.ends_with(".txt") || name.ends_with(".log") || name.ends_with(".log.gz");
                let Ok(meta) = e.metadata() else { continue };
                if !ok || !meta.is_file() {
                    continue;
                }
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                out.push(LogFile { name, kind: kind.into(), modified, size: meta.len() });
            }
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn read_log(state: State<'_, Arc<AppState>>, id: String, name: String, kind: String) -> Result<String> {
    let inst = instances::load(&state, &id)?;
    let folder = if kind == "crash" { "crash-reports" } else { "logs" };
    if name.contains(['/', '\\']) || name.contains("..") {
        bail!("Invalid log name");
    }
    let path = instances::game_dir(&state, &inst).join(folder).join(&name);
    let raw = std::fs::read(&path)?;
    let bytes = if name.ends_with(".gz") {
        let mut d = flate2::read::GzDecoder::new(&raw[..]);
        let mut out = Vec::new();
        d.read_to_end(&mut out)?;
        out
    } else {
        raw
    };
    const MAX: usize = 1_500_000;
    let slice = if bytes.len() > MAX { &bytes[bytes.len() - MAX..] } else { &bytes[..] };
    Ok(String::from_utf8_lossy(slice).to_string())
}

/// Reads a crash report by absolute path (as reported by `game://exited`).
#[tauri::command]
pub fn read_crash_report(state: State<'_, Arc<AppState>>, path: String) -> Result<String> {
    let p = PathBuf::from(&path);
    if !is_managed_path(&state, &p) || !path.ends_with(".txt") {
        bail!("Invalid crash report path");
    }
    Ok(std::fs::read_to_string(p)?)
}

// ---------------------------------------------------------------- storage

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub data_dir: String,
    pub launcher_dir: String,
    pub instances_mb: u64,
    pub libraries_mb: u64,
    pub assets_mb: u64,
    pub versions_mb: u64,
    pub runtimes_mb: u64,
    pub cache_mb: u64,
    pub backups_mb: u64,
}

#[tauri::command]
pub async fn storage_info(state: State<'_, Arc<AppState>>) -> Result<StorageInfo> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let mb = |p: PathBuf| util::dir_size(&p) / 1024 / 1024;
        StorageInfo {
            data_dir: state.data_dir().to_string_lossy().to_string(),
            launcher_dir: state.root.to_string_lossy().to_string(),
            instances_mb: mb(state.instances_dir()),
            libraries_mb: mb(state.libraries_dir()),
            assets_mb: mb(state.assets_dir()),
            versions_mb: mb(state.versions_dir()),
            runtimes_mb: mb(state.runtimes_dir()),
            cache_mb: mb(state.cache_dir()),
            backups_mb: mb(state.backups_dir()),
        }
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))
}

#[tauri::command]
pub fn clear_cache(state: State<'_, Arc<AppState>>) -> Result<()> {
    let dir = state.cache_dir();
    for sub in ["textures", "icons", "packicons", "installers", "modpacks", "panorama"] {
        let _ = std::fs::remove_dir_all(dir.join(sub));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_blocks() {
        let b = html_to_blocks("<h1>Title</h1><p>Hello &amp; <b>bold</b></p><ul><li>One</li><li>Two</li></ul><script>x</script>");
        assert_eq!(b[0].kind, "h");
        assert_eq!(b[0].text, "Title");
        assert_eq!(b[1].text, "Hello & bold");
        assert_eq!(b[2].kind, "li");
        assert_eq!(b[3].text, "Two");
        assert_eq!(b.len(), 4);
    }
}
