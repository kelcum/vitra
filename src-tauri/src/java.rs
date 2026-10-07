//! Java runtime management.
//!
//! Vitra prefers Mojang's own runtimes (the same ones the official launcher
//! uses), downloaded per component (`java-runtime-delta` = Java 21, etc.) and
//! verified file-by-file. Java installations already on the system are
//! detected and can be selected per instance.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bail;
use crate::error::Result;
use crate::net::{self, Download};
use crate::state::AppState;
use crate::tasks::TaskHandle;
use crate::util;

const RUNTIME_INDEX: &str =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstall {
    pub path: String,
    pub version: String,
    pub major: u32,
    pub arch: String,
    pub vendor: String,
    /// "managed" (downloaded by Vitra) or "system".
    pub source: String,
    pub component: Option<String>,
}

fn platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "aarch64") => "windows-arm64",
        ("windows", "x86") => "windows-x86",
        ("windows", _) => "windows-x64",
        ("macos", "aarch64") => "mac-os-arm64",
        ("macos", _) => "mac-os",
        ("linux", "x86") => "linux-i386",
        _ => "linux",
    }
}

pub fn java_binary(home: &Path) -> PathBuf {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    let mac_bundle = home.join("jre.bundle/Contents/Home/bin").join(exe);
    if mac_bundle.exists() {
        return mac_bundle;
    }
    home.join("bin").join(exe)
}

pub fn parse_major(version: &str) -> u32 {
    let mut parts = version.split(|c: char| c == '.' || c == '_' || c == '-' || c == '+');
    let first: u32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    if first == 1 {
        parts.next().and_then(|p| p.parse().ok()).unwrap_or(0)
    } else {
        first
    }
}

/// Reads the `release` file every JDK/JRE ships with — no process spawn needed.
fn read_release(home: &Path) -> Option<(String, String, String)> {
    let text = std::fs::read_to_string(home.join("release")).ok()?;
    let mut map = HashMap::new();
    for line in text.lines() {
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().trim_matches('"').to_string());
        }
    }
    let version = map.get("JAVA_VERSION")?.clone();
    let vendor = map.get("IMPLEMENTOR").cloned().unwrap_or_else(|| "Unknown".into());
    let arch = map.get("OS_ARCH").cloned().unwrap_or_default();
    Some((version, vendor, arch))
}

/// Last-resort probe for a Java binary without a `release` file.
fn probe_binary(bin: &Path) -> Option<(String, String, String)> {
    let mut cmd = std::process::Command::new(bin);
    cmd.args(["-XshowSettings:properties", "-version"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
    let prop = |name: &str| {
        text.lines()
            .find_map(|l| l.trim().strip_prefix(name).and_then(|r| r.trim().strip_prefix('=')).map(|v| v.trim().to_string()))
    };
    Some((prop("java.version")?, prop("java.vendor").unwrap_or_default(), prop("os.arch").unwrap_or_default()))
}

fn describe(home: &Path, source: &str, component: Option<String>) -> Option<JavaInstall> {
    let bin = java_binary(home);
    if !bin.exists() {
        return None;
    }
    let (version, vendor, arch) = read_release(home)
        .or_else(|| read_release(&home.join("jre.bundle/Contents/Home")))
        .or_else(|| probe_binary(&bin))?;
    Some(JavaInstall {
        path: bin.to_string_lossy().to_string(),
        major: parse_major(&version),
        version,
        arch,
        vendor,
        source: source.into(),
        component,
    })
}

fn system_candidates() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    if let Ok(home) = std::env::var("JAVA_HOME") {
        homes.push(PathBuf::from(home));
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for pf in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Ok(base) = std::env::var(pf) {
                for vendor in [
                    "Java",
                    "Eclipse Adoptium",
                    "Eclipse Foundation",
                    "Zulu",
                    "Microsoft",
                    "BellSoft",
                    "Amazon Corretto",
                    "Semeru",
                    "Temurin",
                ] {
                    roots.push(PathBuf::from(&base).join(vendor));
                }
            }
        }
    } else if cfg!(target_os = "macos") {
        roots.push(PathBuf::from("/Library/Java/JavaVirtualMachines"));
    } else {
        roots.push(PathBuf::from("/usr/lib/jvm"));
        roots.push(PathBuf::from("/usr/lib64/jvm"));
    }
    for root in roots {
        if let Ok(entries) = std::fs::read_dir(&root) {
            for e in entries.flatten() {
                let p = e.path();
                let mac_home = p.join("Contents/Home");
                homes.push(if mac_home.exists() { mac_home } else { p });
            }
        }
    }
    // Java on PATH (resolve bin/java -> home).
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if java_binary(dir.parent().unwrap_or(&dir)).exists() && dir.ends_with("bin") {
                if let Some(home) = dir.parent() {
                    homes.push(home.to_path_buf());
                }
            }
        }
    }
    homes
}

pub fn detect_all(state: &AppState) -> Vec<JavaInstall> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(entries) = std::fs::read_dir(state.runtimes_dir()) {
        for e in entries.flatten() {
            let component = e.file_name().to_string_lossy().to_string();
            if e.path().join(".vitra-complete").exists() {
                if let Some(j) = describe(&e.path(), "managed", Some(component)) {
                    if seen.insert(j.path.to_lowercase()) {
                        found.push(j);
                    }
                }
            }
        }
    }
    for home in system_candidates() {
        if let Some(j) = describe(&home, "system", None) {
            if seen.insert(j.path.to_lowercase()) {
                found.push(j);
            }
        }
    }
    found.sort_by(|a, b| b.major.cmp(&a.major).then(a.source.cmp(&b.source)));
    found
}

#[derive(Deserialize)]
struct RuntimeEntry {
    manifest: RuntimeManifestRef,
    version: RuntimeVersion,
}
#[derive(Deserialize)]
struct RuntimeManifestRef {
    sha1: String,
    url: String,
}
#[derive(Deserialize)]
struct RuntimeVersion {
    name: String,
}
#[derive(Deserialize)]
struct RuntimeManifest {
    files: HashMap<String, RuntimeFile>,
}
#[derive(Deserialize)]
struct RuntimeFile {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    executable: bool,
    #[serde(default)]
    downloads: Option<RuntimeDownloads>,
    #[serde(default)]
    target: Option<String>,
}
#[derive(Deserialize)]
struct RuntimeDownloads {
    raw: RuntimeRaw,
}
#[derive(Deserialize)]
struct RuntimeRaw {
    sha1: String,
    size: u64,
    url: String,
}

/// Makes sure the Mojang runtime `component` is installed and returns the
/// path to its `java` binary. Falls back to a compatible system Java when
/// Mojang doesn't publish that runtime for this platform.
pub async fn ensure_runtime(state: &AppState, task: &TaskHandle, component: &str, major: u32) -> Result<PathBuf> {
    let dir = state.runtimes_dir().join(component);
    let marker = dir.join(".vitra-complete");

    let index_cache = state.cache_dir().join("java-runtimes.json");
    let index: serde_json::Value = match net::cached_json(&state.http, RUNTIME_INDEX, &index_cache).await {
        Ok(v) => v,
        Err(e) => {
            // Offline: accept an already-installed runtime.
            if marker.exists() && java_binary(&dir).exists() {
                return Ok(java_binary(&dir));
            }
            return Err(e);
        }
    };
    let entry = index
        .get(platform_key())
        .and_then(|p| p.get(component))
        .and_then(|c| c.get(0))
        .cloned()
        .and_then(|v| serde_json::from_value::<RuntimeEntry>(v).ok());

    let Some(entry) = entry else {
        // No official runtime for this platform/component: look for a system Java.
        if let Some(j) = detect_all(state).into_iter().find(|j| j.major == major) {
            return Ok(PathBuf::from(j.path));
        }
        bail!(
            "Mojang doesn't provide Java {major} for this platform. Install Java {major} and select it in the instance's Java settings."
        );
    };

    if std::fs::read_to_string(&marker).map(|v| v.trim() == entry.version.name).unwrap_or(false)
        && java_binary(&dir).exists()
    {
        return Ok(java_binary(&dir));
    }

    task.stage(format!("Downloading Java {major} runtime"), true);
    let manifest_path = state.cache_dir().join(format!("runtime-{component}.json"));
    net::fetch_file(&state.http, &entry.manifest.url, &manifest_path, Some(&entry.manifest.sha1)).await?;
    let manifest: RuntimeManifest = util::read_json(&manifest_path)?;

    let mut jobs = Vec::new();
    let mut executables = Vec::new();
    let mut links = Vec::new();
    for (rel, file) in &manifest.files {
        let target = util::safe_join(&dir, rel)?;
        match file.kind.as_str() {
            "directory" => std::fs::create_dir_all(&target)?,
            "file" => {
                if let Some(dl) = &file.downloads {
                    jobs.push(
                        Download::new(dl.raw.url.clone(), target.clone())
                            .sha1(Some(dl.raw.sha1.clone()))
                            .size(Some(dl.raw.size)),
                    );
                    if file.executable {
                        executables.push(target);
                    }
                }
            }
            "link" => {
                if let Some(t) = &file.target {
                    links.push((target, t.clone()));
                }
            }
            _ => {}
        }
    }
    net::download_all(state, task, jobs, false).await?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for exe in executables {
            let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
        }
        for (link, target) in links {
            let _ = std::fs::remove_file(&link);
            let _ = std::os::unix::fs::symlink(target, &link);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (executables, links);
    }

    std::fs::write(&marker, &entry.version.name)?;
    Ok(java_binary(&dir))
}

#[tauri::command]
pub async fn list_java(state: State<'_, Arc<AppState>>) -> Result<Vec<JavaInstall>> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || detect_all(&state))
        .await
        .map_err(|e| crate::error::Error::Msg(e.to_string()))
}

/// Validates a user-chosen Java binary and reports its version.
#[tauri::command]
pub async fn inspect_java(path: String) -> Result<JavaInstall> {
    tokio::task::spawn_blocking(move || {
        let bin = PathBuf::from(&path);
        let Some((version, vendor, arch)) = probe_binary(&bin) else {
            bail!("That file doesn't look like a working Java executable.");
        };
        Ok(JavaInstall {
            path,
            major: parse_major(&version),
            version,
            vendor,
            arch,
            source: "system".into(),
            component: None,
        })
    })
    .await
    .map_err(|e| crate::error::Error::Msg(e.to_string()))?
}

#[tauri::command]
pub async fn install_java_runtime(state: State<'_, Arc<AppState>>, component: String, major: u32) -> Result<String> {
    let state = state.inner().clone();
    let task = state.tasks.start("java", format!("Java {major}"), None);
    let result = ensure_runtime(&state, &task, &component, major).await;
    task.complete(result).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_major;

    #[test]
    fn majors() {
        assert_eq!(parse_major("1.8.0_503"), 8);
        assert_eq!(parse_major("17.0.15"), 17);
        assert_eq!(parse_major("21"), 21);
        assert_eq!(parse_major("25.0.1+8"), 25);
    }
}
