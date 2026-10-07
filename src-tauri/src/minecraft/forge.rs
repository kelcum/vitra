//! Forge / NeoForge installation.
//!
//! Modern installers (Forge 1.13+, all NeoForge) ship an `install_profile.json`
//! describing libraries plus a list of "processors" — small Java programs that
//! deobfuscate and patch the vanilla client. We reproduce what the official
//! installer does in client mode: download libraries, extract embedded files,
//! run each client-side processor, and verify declared output hashes.
//!
//! Legacy installers (Forge ≤ 1.12) embed the version JSON and universal jar
//! directly; those are extracted without processors.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::bail;
use crate::error::{Error, Result};
use crate::minecraft::manifest::{Library, VersionJson};
use crate::net::{self, Download};
use crate::state::AppState;
use crate::tasks::TaskHandle;
use crate::util;

#[derive(Deserialize)]
struct InstallProfile {
    #[serde(default)]
    data: HashMap<String, SidedValue>,
    #[serde(default)]
    processors: Vec<Processor>,
    #[serde(default)]
    libraries: Vec<Library>,
    #[serde(default)]
    json: Option<String>,
    // Legacy (≤1.12) layout
    #[serde(default)]
    install: Option<LegacyInstall>,
    #[serde(default, rename = "versionInfo")]
    version_info: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct SidedValue {
    client: String,
}

#[derive(Deserialize)]
struct Processor {
    jar: String,
    #[serde(default)]
    classpath: Vec<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    outputs: HashMap<String, String>,
    #[serde(default)]
    sides: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyInstall {
    path: String,
    file_path: String,
}

fn installer_url(loader: &str, game: &str, version: &str) -> String {
    match loader {
        "neoforge" => format!(
            "https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/neoforge-{version}-installer.jar"
        ),
        _ => format!(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/{game}-{version}/forge-{game}-{version}-installer.jar"
        ),
    }
}

fn read_zip_entry(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<Vec<u8>> {
    let name = name.trim_start_matches('/');
    let mut entry = zip.by_name(name).ok()?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn jar_main_class(jar: &Path) -> Result<String> {
    let file = std::fs::File::open(jar)?;
    let mut zip = zip::ZipArchive::new(file)?;
    let manifest = read_zip_entry(&mut zip, "META-INF/MANIFEST.MF")
        .ok_or_else(|| Error::Msg(format!("{} has no manifest", jar.display())))?;
    let text = String::from_utf8_lossy(&manifest);
    text.lines()
        .find_map(|l| l.strip_prefix("Main-Class:").map(|v| v.trim().to_string()))
        .ok_or_else(|| Error::Msg(format!("{} has no Main-Class", jar.display())))
}

fn lib_path(libs: &Path, coord: &str) -> Result<PathBuf> {
    let rel = util::maven_path(coord).ok_or_else(|| Error::Msg(format!("Bad library coordinate {coord}")))?;
    Ok(libs.join(rel))
}

/// Replaces `{KEY}` tokens; `[maven:coords]` resolves to a library path.
fn resolve_arg(arg: &str, data: &HashMap<String, String>, libs: &Path) -> Result<String> {
    if arg.starts_with('[') && arg.ends_with(']') {
        return Ok(lib_path(libs, &arg[1..arg.len() - 1])?.to_string_lossy().to_string());
    }
    let mut out = String::new();
    let mut rest = arg;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else {
            out.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let key = &rest[start + 1..start + end];
        match data.get(key) {
            Some(v) => out.push_str(v),
            None => bail!("Installer references unknown value {{{key}}}"),
        }
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Downloads libraries, extracting ones that only exist inside the installer.
async fn fetch_libraries(
    state: &AppState,
    task: &TaskHandle,
    installer: &Path,
    libraries: &[Library],
) -> Result<()> {
    let libs_dir = state.libraries_dir();
    let mut jobs = Vec::new();
    let mut embedded = Vec::new();
    for lib in libraries {
        let Some((rel, url, sha1, size)) = lib.artifact() else { continue };
        let dest = libs_dir.join(&rel);
        if url.is_empty() {
            embedded.push((format!("maven/{rel}"), dest));
        } else {
            jobs.push(Download::new(url, dest).sha1(sha1).size(size));
        }
    }
    let installer = installer.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<()> {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&installer)?)?;
        for (entry, dest) in embedded {
            if dest.exists() {
                continue;
            }
            // Absent entries are produced later by processors.
            if let Some(bytes) = read_zip_entry(&mut zip, &entry) {
                util::write_atomic(&dest, &bytes)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;
    net::download_all(state, task, jobs, false).await
}

pub fn version_id(loader: &str, game: &str, version: &str) -> String {
    match loader {
        "neoforge" => format!("neoforge-{version}"),
        _ => format!("{game}-forge-{version}"),
    }
}

pub async fn install(
    state: &AppState,
    task: &TaskHandle,
    loader: &str,
    game: &str,
    version: &str,
    java: &Path,
    client_jar: &Path,
) -> Result<VersionJson> {
    let expected_id = version_id(loader, game, version);
    let marker = state.versions_dir().join(&expected_id).join(".vitra-installed");
    let json_path = state.versions_dir().join(&expected_id).join(format!("{expected_id}.json"));
    if marker.exists() && json_path.exists() {
        return util::read_json(&json_path);
    }

    let name = if loader == "neoforge" { "NeoForge" } else { "Forge" };
    task.stage(format!("Downloading {name} installer"), true);
    let installer = state.cache_dir().join("installers").join(format!("{loader}-{game}-{version}-installer.jar"));
    if !installer.exists() {
        let url = installer_url(loader, game, version);
        net::download_all(state, task, vec![Download::new(url, installer.clone())], false).await?;
    }

    let inst_path = installer.clone();
    let (profile, version_bytes) = tokio::task::spawn_blocking(move || -> Result<(InstallProfile, Option<Vec<u8>>)> {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&inst_path)?)?;
        let raw = read_zip_entry(&mut zip, "install_profile.json")
            .ok_or_else(|| Error::Msg("The installer is missing install_profile.json".into()))?;
        let profile: InstallProfile = serde_json::from_slice(&raw)?;
        let version = profile.json.as_ref().and_then(|j| read_zip_entry(&mut zip, j));
        Ok((profile, version))
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;

    // Legacy installer: version JSON + universal jar are embedded directly.
    if let (Some(info), Some(legacy)) = (&profile.version_info, &profile.install) {
        task.stage(format!("Installing {name}"), true);
        let mut vj: VersionJson = serde_json::from_value(info.clone())?;
        let dest = lib_path(&state.libraries_dir(), &legacy.path)?;
        let inst_path = installer.clone();
        let file_path = legacy.file_path.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&inst_path)?)?;
            let bytes = read_zip_entry(&mut zip, &file_path)
                .ok_or_else(|| Error::Msg("The installer is missing the universal jar".into()))?;
            util::write_atomic(&dest, &bytes)
        })
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;
        // Legacy libraries lack download info; the universal jar is local.
        for lib in &mut vj.libraries {
            if lib.name == legacy.path {
                lib.url = None;
                lib.downloads = Some(crate::minecraft::manifest::LibraryDownloads {
                    artifact: Some(crate::minecraft::manifest::Artifact {
                        path: util::maven_path(&legacy.path),
                        sha1: None,
                        size: None,
                        url: String::new(),
                    }),
                    classifiers: None,
                });
            }
        }
        vj.id = expected_id.clone();
        util::write_json(&json_path, &vj)?;
        std::fs::write(&marker, "ok")?;
        return Ok(vj);
    }

    let version_bytes = version_bytes.ok_or_else(|| Error::Msg("The installer is missing version.json".into()))?;
    let mut vj: VersionJson = serde_json::from_slice(&version_bytes)?;

    task.stage(format!("Downloading {name} libraries"), true);
    let mut all_libs = profile.libraries.clone();
    all_libs.extend(vj.libraries.iter().cloned());
    fetch_libraries(state, task, &installer, &all_libs).await?;

    // Build the data map exactly like the official installer.
    let libs_dir = state.libraries_dir();
    let extract_dir = state.cache_dir().join("installers").join(format!("{loader}-{version}-data"));
    let mut data: HashMap<String, String> = HashMap::new();
    {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&installer)?)?;
        for (key, value) in &profile.data {
            let v = &value.client;
            let resolved = if v.starts_with('[') && v.ends_with(']') {
                lib_path(&libs_dir, &v[1..v.len() - 1])?.to_string_lossy().to_string()
            } else if v.starts_with('\'') && v.ends_with('\'') && v.len() >= 2 {
                v[1..v.len() - 1].to_string()
            } else if v.starts_with('/') {
                let dest = util::safe_join(&extract_dir, v.trim_start_matches('/'))?;
                let bytes = read_zip_entry(&mut zip, v)
                    .ok_or_else(|| Error::Msg(format!("The installer is missing {v}")))?;
                util::write_atomic(&dest, &bytes)?;
                dest.to_string_lossy().to_string()
            } else {
                v.clone()
            };
            data.insert(key.clone(), resolved);
        }
    }
    data.insert("SIDE".into(), "client".into());
    data.insert("MINECRAFT_JAR".into(), client_jar.to_string_lossy().to_string());
    data.insert("MINECRAFT_VERSION".into(), game.into());
    data.insert("ROOT".into(), state.data_dir().to_string_lossy().to_string());
    data.insert("INSTALLER".into(), installer.to_string_lossy().to_string());
    data.insert("LIBRARY_DIR".into(), libs_dir.to_string_lossy().to_string());

    let processors: Vec<&Processor> = profile
        .processors
        .iter()
        .filter(|p| p.sides.as_ref().map(|s| s.iter().any(|x| x == "client")).unwrap_or(true))
        .collect();

    task.stage(format!("Patching Minecraft for {name}"), true);
    task.set_totals(processors.len() as u64, 0);
    for proc in processors {
        task.check_cancelled()?;
        // Skip processors whose outputs already exist with the right hashes.
        let mut outputs = Vec::new();
        for (k, v) in &proc.outputs {
            let path = resolve_arg(k, &data, &libs_dir)?;
            let sha = resolve_arg(v, &data, &libs_dir)?.trim_matches('\'').to_string();
            outputs.push((PathBuf::from(path), sha));
        }
        let up_to_date = !outputs.is_empty()
            && outputs.iter().all(|(p, sha)| util::sha1_file(p).map(|h| h.eq_ignore_ascii_case(sha)).unwrap_or(false));
        if up_to_date {
            task.file_done();
            continue;
        }

        let jar = lib_path(&libs_dir, &proc.jar)?;
        let main_class = jar_main_class(&jar)?;
        let mut cp = vec![jar.to_string_lossy().to_string()];
        for c in &proc.classpath {
            cp.push(lib_path(&libs_dir, c)?.to_string_lossy().to_string());
        }
        let args: Vec<String> = proc.args.iter().map(|a| resolve_arg(a, &data, &libs_dir)).collect::<Result<_>>()?;

        let mut cmd = tokio::process::Command::new(java);
        cmd.arg("-cp").arg(cp.join(util::classpath_separator())).arg(&main_class).args(&args);
        cmd.current_dir(state.data_dir());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        let out = cmd.output().await?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let tail: Vec<&str> = stderr.lines().chain(stdout.lines()).rev().take(12).collect();
            bail!(
                "{name} installer step {} failed:\n{}",
                main_class,
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            );
        }
        for (p, sha) in &outputs {
            match util::sha1_file(p) {
                Ok(h) if h.eq_ignore_ascii_case(sha) => {}
                _ => bail!("{name} installer produced an unexpected file: {}", p.display()),
            }
        }
        task.file_done();
    }

    vj.id = expected_id.clone();
    util::write_json(&json_path, &vj)?;
    std::fs::write(&marker, "ok")?;
    let _ = std::fs::remove_dir_all(&extract_dir);
    Ok(vj)
}
