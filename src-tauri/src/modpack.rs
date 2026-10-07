//! Modrinth modpacks (`.mrpack`): install from Modrinth, import from a file,
//! and export an instance. Format: https://support.modrinth.com/en/articles/8802351

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::bail;
use crate::error::{Error, Result};
use crate::instances::{self, CreateInstance, InstanceView, ModpackRef};
use crate::minecraft::install;
use crate::modrinth;
use crate::net::{self, Download};
use crate::state::AppState;
use crate::tasks::TaskHandle;
use crate::util;

/// Hosts the .mrpack spec allows downloads from.
const ALLOWED_HOSTS: [&str; 4] = ["cdn.modrinth.com", "github.com", "raw.githubusercontent.com", "gitlab.com"];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MrpackIndex {
    format_version: u32,
    game: String,
    version_id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    files: Vec<MrpackFile>,
    dependencies: HashMap<String, String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MrpackFile {
    path: String,
    hashes: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env: Option<HashMap<String, String>>,
    downloads: Vec<String>,
    file_size: u64,
}

fn host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split('/').next().unwrap_or("");
    ALLOWED_HOSTS.contains(&host)
}

fn loader_from_deps(deps: &HashMap<String, String>) -> (String, Option<String>) {
    for (key, loader) in [("fabric-loader", "fabric"), ("quilt-loader", "quilt"), ("neoforge", "neoforge"), ("forge", "forge")] {
        if let Some(v) = deps.get(key) {
            return (loader.into(), Some(v.clone()));
        }
    }
    ("vanilla".into(), None)
}

async fn import_mrpack(
    state: &AppState,
    task: &TaskHandle,
    path: &Path,
    modpack: Option<ModpackRef>,
) -> Result<InstanceView> {
    task.stage("Reading modpack", false);
    let p = path.to_path_buf();
    let index: MrpackIndex = tokio::task::spawn_blocking(move || -> Result<MrpackIndex> {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&p)?)?;
        let mut e = zip
            .by_name("modrinth.index.json")
            .map_err(|_| Error::Msg("This isn't a Modrinth modpack (modrinth.index.json is missing).".into()))?;
        let mut buf = Vec::new();
        e.read_to_end(&mut buf)?;
        Ok(serde_json::from_slice(&buf)?)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))??;

    if index.game != "minecraft" {
        bail!("This modpack is for '{}', not Minecraft.", index.game);
    }
    let game = index.dependencies.get("minecraft").cloned().ok_or("The modpack doesn't say which Minecraft version it needs.")?;
    let (loader, loader_version) = loader_from_deps(&index.dependencies);

    let inst = instances::create(
        state,
        CreateInstance {
            name: index.name.clone(),
            game_version: game,
            loader,
            loader_version,
            icon: Some("pack".into()),
        },
    )?;
    let mut inst = inst;
    inst.modpack = Some(modpack.unwrap_or(ModpackRef { title: index.name.clone(), ..Default::default() }));
    inst.memory_mb = Some(crate::settings::recommended_memory_mb(true));
    instances::save(state, &inst)?;
    let game_dir = instances::game_dir(state, &inst);

    let result = async {
        task.stage("Downloading modpack files", true);
        let mut jobs = Vec::new();
        for f in &index.files {
            if f.env.as_ref().and_then(|e| e.get("client")).map(|c| c == "unsupported").unwrap_or(false) {
                continue;
            }
            let url = f
                .downloads
                .iter()
                .find(|u| host_allowed(u))
                .ok_or_else(|| Error::Msg(format!("{} comes from a download source that isn't allowed.", f.path)))?;
            let dest = util::safe_join(&game_dir, &f.path)?;
            jobs.push(Download::new(url.clone(), dest).sha1(f.hashes.get("sha1").cloned()).size(Some(f.file_size)));
        }
        net::download_all(state, task, jobs, true).await?;

        task.stage("Applying modpack configuration", false);
        let p = path.to_path_buf();
        let gd = game_dir.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut zip = zip::ZipArchive::new(std::fs::File::open(&p)?)?;
            for prefix in ["overrides/", "client-overrides/"] {
                for i in 0..zip.len() {
                    let mut e = zip.by_index(i)?;
                    let name = e.name().to_string();
                    let Some(rel) = name.strip_prefix(prefix) else { continue };
                    if rel.is_empty() || e.is_dir() {
                        continue;
                    }
                    let dest = util::safe_join(&gd, rel)?;
                    util::ensure_parent(&dest)?;
                    let mut buf = Vec::new();
                    e.read_to_end(&mut buf)?;
                    std::fs::write(dest, buf)?;
                }
            }
            Ok(())
        })
        .await
        .map_err(|e| Error::Msg(e.to_string()))??;

        install::install_instance(state, task, inst.clone(), false).await?;
        Ok::<(), Error>(())
    }
    .await;

    if let Err(e) = result {
        // Leave nothing half-installed behind.
        let _ = std::fs::remove_dir_all(instances::instance_dir(state, &inst.id));
        return Err(e);
    }
    state.update_settings(|s| s.selected_instance = Some(inst.id.clone()))?;
    let _ = state.app.emit("instances://changed", ());
    Ok(instances::view(state, instances::load(state, &inst.id)?))
}

#[tauri::command]
pub async fn import_modpack_file(state: State<'_, Arc<AppState>>, path: String) -> Result<InstanceView> {
    let state = state.inner().clone();
    let lower = path.to_lowercase();
    if lower.ends_with(".zip") {
        let is_curseforge = {
            let f = std::fs::File::open(&path)?;
            let mut zip = zip::ZipArchive::new(f)?;
            zip.by_name("manifest.json").is_ok() && zip.by_name("modrinth.index.json").is_err()
        };
        if is_curseforge {
            bail!("This is a CurseForge modpack. CurseForge packs need the CurseForge API, which Vitra doesn't support yet — look for the same pack on Modrinth.");
        }
    }
    let name = PathBuf::from(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let task = state.tasks.start("modpack", format!("Importing {name}"), None);
    let result = import_mrpack(&state, &task, Path::new(&path), None).await;
    task.complete(result)
}

#[tauri::command]
pub async fn install_modpack(
    state: State<'_, Arc<AppState>>,
    project_id: String,
    version_id: Option<String>,
    title: String,
    icon_url: Option<String>,
) -> Result<InstanceView> {
    let state = state.inner().clone();
    let task = state.tasks.start("modpack", format!("Installing {title}"), None);
    let result = async {
        task.stage("Finding the right version", false);
        let version = match &version_id {
            Some(v) => modrinth::version(&state, v).await?,
            None => {
                let versions = modrinth::project_versions(&state, &project_id, None, None).await?;
                versions
                    .iter()
                    .find(|v| v.version_type == "release")
                    .or(versions.first())
                    .cloned()
                    .ok_or("This modpack has no versions to install.")?
            }
        };
        let file = version
            .files
            .iter()
            .find(|f| f.filename.ends_with(".mrpack"))
            .cloned()
            .ok_or("This modpack version has no .mrpack file.")?;
        let dest = state.cache_dir().join("modpacks").join(&file.filename);
        task.stage("Downloading modpack", true);
        net::download_all(
            &state,
            &task,
            vec![Download::new(file.url.clone(), dest.clone()).sha1(file.hashes.get("sha1").cloned()).size(Some(file.size))],
            true,
        )
        .await?;
        let r = import_mrpack(
            &state,
            &task,
            &dest,
            Some(ModpackRef { project_id: Some(project_id.clone()), version_id: Some(version.id.clone()), title: title.clone(), icon_url }),
        )
        .await;
        let _ = std::fs::remove_file(&dest);
        r
    }
    .await;
    task.complete(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub name: String,
    pub version: String,
    pub summary: Option<String>,
    /// Top-level entries of the game folder to include (e.g. "config", "options.txt").
    pub include: Vec<String>,
    pub out_path: String,
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    root: &Path,
    dir: &Path,
    prefix: &str,
    skip: &dyn Fn(&str) -> bool,
) -> Result<()> {
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for e in std::fs::read_dir(dir)?.flatten() {
        let path = e.path();
        let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
        if skip(&rel) {
            continue;
        }
        if path.is_dir() {
            add_dir_to_zip(zip, root, &path, prefix, skip)?;
        } else {
            zip.start_file(format!("{prefix}{rel}"), opts)?;
            let mut f = std::fs::File::open(&path)?;
            std::io::copy(&mut f, zip)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn export_modpack(state: State<'_, Arc<AppState>>, id: String, options: ExportOptions) -> Result<String> {
    let state = state.inner().clone();
    let inst = instances::load(&state, &id)?;
    // Make sure every mod is identified so Modrinth files are referenced, not copied.
    crate::content::refresh(&state, &inst, "mods").await?;
    crate::content::refresh(&state, &inst, "resourcepacks").await?;
    crate::content::refresh(&state, &inst, "shaderpacks").await?;
    let index = crate::content::load_index(&state, &id);
    let task = state.tasks.start("export", format!("Exporting {}", options.name), Some(id.clone()));
    task.stage("Packing files", false);
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<String> {
        let game_dir = instances::game_dir(&st, &inst);
        let mut files = Vec::new();
        let mut referenced: Vec<String> = Vec::new();
        for (key, e) in &index {
            let folder = key.split('/').next().unwrap_or("");
            if !options.include.iter().any(|i| i == folder) {
                continue;
            }
            // Disabled files aren't part of the pack.
            if !game_dir.join(key).exists() {
                continue;
            }
            if let (Some(url), Some(sha1), Some(sha512)) = (&e.url, &e.sha1, &e.sha512) {
                if host_allowed(url) {
                    files.push(MrpackFile {
                        path: key.clone(),
                        hashes: HashMap::from([("sha1".into(), sha1.clone()), ("sha512".into(), sha512.clone())]),
                        env: None,
                        downloads: vec![url.clone()],
                        file_size: e.size,
                    });
                    referenced.push(key.clone());
                }
            }
        }
        let mut deps = HashMap::from([("minecraft".to_string(), inst.game_version.clone())]);
        if let Some(lv) = &inst.loader_version {
            let key = match inst.loader.as_str() {
                "fabric" => Some("fabric-loader"),
                "quilt" => Some("quilt-loader"),
                "forge" => Some("forge"),
                "neoforge" => Some("neoforge"),
                _ => None,
            };
            if let Some(k) = key {
                deps.insert(k.into(), lv.clone());
            }
        }
        let mr_index = MrpackIndex {
            format_version: 1,
            game: "minecraft".into(),
            version_id: options.version.clone(),
            name: options.name.clone(),
            summary: options.summary.clone().filter(|s| !s.is_empty()),
            files,
            dependencies: deps,
        };
        let out = PathBuf::from(&options.out_path);
        util::ensure_parent(&out)?;
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&out)?);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("modrinth.index.json", opts)?;
        zip.write_all(&serde_json::to_vec_pretty(&mr_index)?)?;
        for entry in &options.include {
            if entry.contains(['/', '\\']) || entry.contains("..") {
                continue;
            }
            let path = game_dir.join(entry);
            let skip = |rel: &str| referenced.iter().any(|r| r == rel) || rel.ends_with(".disabled");
            if path.is_dir() {
                add_dir_to_zip(&mut zip, &game_dir, &path, "overrides/", &skip)?;
            } else if path.is_file() {
                zip.start_file(format!("overrides/{entry}"), opts)?;
                let mut f = std::fs::File::open(&path)?;
                std::io::copy(&mut f, &mut zip)?;
            }
        }
        zip.finish()?;
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;
    task.complete(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_hosts() {
        assert!(host_allowed("https://cdn.modrinth.com/data/x/y.jar"));
        assert!(host_allowed("https://github.com/a/b/releases/download/c.jar"));
        assert!(!host_allowed("http://cdn.modrinth.com/x"));
        assert!(!host_allowed("https://evil.example.com/cdn.modrinth.com/x"));
    }
}
