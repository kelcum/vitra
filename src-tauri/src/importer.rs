use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::bail;
use crate::error::{Error, Result};
use crate::instances::{self, Instance, InstanceView, WindowSettings};
use crate::state::AppState;
use crate::tasks::TaskHandle;
use crate::util;

#[derive(Debug, Clone, PartialEq)]
enum GameRef {
    Exact(String),
    LatestRelease,
    LatestSnapshot,
}

#[derive(Debug, Clone)]
enum CopyRule {
    AllExcept(Vec<&'static str>),
    Only(Vec<&'static str>),
}

const NEVER_COPY: [&str; 12] = [
    "logs",
    "crash-reports",
    "natives",
    "launcher_profiles.json",
    "launcher_accounts.json",
    "launcher_accounts_microsoft_store.json",
    "launcher_msa_credentials.bin",
    "launcher_msa_credentials_microsoft_store.bin",
    "launcher_settings.json",
    "launcher_ui_state.json",
    "launcher_log.txt",
    "launcher_cef_log.txt",
];

const SHARED_VANILLA: [&str; 9] = [
    "saves",
    "resourcepacks",
    "shaderpacks",
    "screenshots",
    "schematics",
    "options.txt",
    "optionsof.txt",
    "optionsshaders.txt",
    "servers.dat",
];

#[derive(Debug, Clone)]
struct Candidate {
    source: &'static str,
    key: String,
    name: String,
    game: Option<GameRef>,
    loader: String,
    loader_version: Option<String>,
    game_dir: Option<PathBuf>,
    copy: CopyRule,
    play_time_secs: u64,
    last_played: Option<i64>,
    memory_mb: Option<u32>,
    jvm_args: Option<String>,
    window: Option<WindowSettings>,
    note: Option<String>,
    problem: Option<String>,
}

impl Candidate {
    fn new(source: &'static str, key: String, name: String) -> Self {
        Self {
            source,
            key,
            name,
            game: None,
            loader: "vanilla".into(),
            loader_version: None,
            game_dir: None,
            copy: CopyRule::AllExcept(vec![]),
            play_time_secs: 0,
            last_played: None,
            memory_mb: None,
            jvm_args: None,
            window: None,
            note: None,
            problem: None,
        }
    }

    fn finish(mut self) -> Self {
        if self.problem.is_none() {
            if self.game.is_none() {
                self.problem = Some("Couldn't tell which Minecraft version this uses.".into());
            } else if !instances::LOADERS.contains(&self.loader.as_str()) {
                self.problem = Some(format!("{} instances aren't supported yet.", self.loader));
            } else if self.game_dir.as_ref().is_none_or(|d| !d.is_dir()) {
                self.problem = Some("This instance has no game folder yet. Launch it once in its own launcher, then import it.".into());
            }
        }
        self
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalInstance {
    pub source: String,
    pub path: String,
    pub name: String,
    pub game_version: String,
    pub loader: String,
    pub loader_version: Option<String>,
    pub mod_count: usize,
    pub world_count: usize,
    pub size_bytes: u64,
    pub play_time_secs: u64,
    pub imported_as: Option<String>,
    pub note: Option<String>,
    pub problem: Option<String>,
}

fn top_level_allowed(rule: &CopyRule, name: &str) -> bool {
    if NEVER_COPY.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        return false;
    }
    match rule {
        CopyRule::AllExcept(skip) => !skip.iter().any(|n| n.eq_ignore_ascii_case(name)),
        CopyRule::Only(keep) => keep.iter().any(|n| n.eq_ignore_ascii_case(name)),
    }
}

fn view(c: &Candidate, existing: &[Instance]) -> ExternalInstance {
    let dir = c.game_dir.as_deref();
    let mods = dir.filter(|_| top_level_allowed(&c.copy, "mods")).map(|d| d.join("mods"));
    let size = dir
        .and_then(|d| std::fs::read_dir(d).ok())
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| top_level_allowed(&c.copy, &e.file_name().to_string_lossy()))
                .map(|e| if e.path().is_dir() { util::dir_size(&e.path()) } else { e.metadata().map(|m| m.len()).unwrap_or(0) })
                .sum()
        })
        .unwrap_or(0);
    ExternalInstance {
        source: c.source.into(),
        path: c.key.clone(),
        name: c.name.clone(),
        game_version: match &c.game {
            Some(GameRef::Exact(v)) => v.clone(),
            _ => String::new(),
        },
        loader: c.loader.clone(),
        loader_version: c.loader_version.clone(),
        mod_count: mods.map(|m| count_files(&m, &[".jar", ".jar.disabled"])).unwrap_or(0),
        world_count: dir.filter(|_| top_level_allowed(&c.copy, "saves")).map(|d| count_worlds(&d.join("saves"))).unwrap_or(0),
        size_bytes: size,
        play_time_secs: c.play_time_secs,
        imported_as: existing.iter().find(|i| i.imported_from.as_deref() == Some(c.key.as_str())).map(|i| i.id.clone()),
        note: c.note.clone().or_else(|| match c.game {
            Some(GameRef::LatestRelease) => Some("Follows the latest release".into()),
            Some(GameRef::LatestSnapshot) => Some("Follows the latest snapshot".into()),
            _ => None,
        }),
        problem: c.problem.clone(),
    }
}

fn count_files(dir: &Path, exts: &[&str]) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    exts.iter().any(|x| name.ends_with(x))
                })
                .count()
        })
        .unwrap_or(0)
}

fn count_worlds(saves: &Path) -> usize {
    std::fs::read_dir(saves)
        .map(|entries| entries.flatten().filter(|e| e.path().join("level.dat").exists()).count())
        .unwrap_or(0)
}

fn read_json_value(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    serde_json::from_slice(bytes).ok()
}

fn folder_name(dir: &Path) -> String {
    dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
}

fn iso_millis(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .filter(|t| *t > 0)
}

fn sane_memory(mb: u64) -> Option<u32> {
    let total = crate::settings::total_memory_mb();
    u32::try_from(mb).ok().filter(|m| *m >= 512 && *m <= total.saturating_sub(1024).max(1024))
}

fn xmx_mb(args: &str) -> Option<u64> {
    let v = args.split_whitespace().find_map(|a| a.strip_prefix("-Xmx"))?;
    let (num, unit) = v.split_at(v.find(|c: char| !c.is_ascii_digit()).unwrap_or(v.len()));
    let n: u64 = num.parse().ok()?;
    Some(match unit.to_ascii_lowercase().as_str() {
        "g" => n * 1024,
        "m" | "" => n,
        "k" => n / 1024,
        _ => return None,
    })
}

fn normalize_loader(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "fabric" => "fabric",
        "quilt" => "quilt",
        "forge" => "forge",
        "neoforge" | "neoforged" => "neoforge",
        "vanilla" | "none" | "" => "vanilla",
        other => return other.to_string(),
    }
    .to_string()
}

fn read_cfg(path: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else { return out };
    let mut section = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].to_string();
            continue;
        }
        if !(section.is_empty() || section == "General") {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_string(), unquote(v.trim()));
        }
    }
    out
}

fn unquote(v: &str) -> String {
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        let mut out = String::new();
        let mut chars = v[1..v.len() - 1].chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some(other) => out.push(other),
                    None => {}
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        v.to_string()
    }
}

#[derive(Deserialize)]
struct Pack {
    #[serde(default)]
    components: Vec<Component>,
}
#[derive(Deserialize)]
struct Component {
    uid: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default, rename = "cachedVersion")]
    cached_version: Option<String>,
}

fn multimc(dir: &Path, source: &'static str) -> Option<Candidate> {
    let cfg = read_cfg(&dir.join("instance.cfg"));
    if cfg.is_empty() && !dir.join("mmc-pack.json").exists() {
        return None;
    }
    let name = cfg.get("name").filter(|n| !n.trim().is_empty()).cloned().unwrap_or_else(|| folder_name(dir));
    let mut c = Candidate::new(source, dir.to_string_lossy().to_string(), name);
    if let Ok(pack) = util::read_json::<Pack>(&dir.join("mmc-pack.json")) {
        for comp in pack.components {
            let version = comp.version.or(comp.cached_version);
            let loader = match comp.uid.as_str() {
                "net.minecraft" => {
                    c.game = version.map(GameRef::Exact);
                    continue;
                }
                "net.fabricmc.fabric-loader" => "fabric",
                "org.quiltmc.quilt-loader" => "quilt",
                "net.minecraftforge" => "forge",
                "net.neoforged" => "neoforge",
                _ => continue,
            };
            c.loader = loader.into();
            c.loader_version = version;
        }
    }
    if cfg.get("InstanceType").is_some_and(|t| t != "OneSix") {
        c.problem = Some("This instance type isn't supported.".into());
    }
    c.game_dir = [".minecraft", "minecraft"].iter().map(|n| dir.join(n)).find(|p| p.is_dir());
    let flag = |k: &str| cfg.get(k).is_some_and(|v| v == "true");
    c.play_time_secs = cfg.get("totalTimePlayed").and_then(|v| v.parse().ok()).unwrap_or(0);
    c.last_played = cfg.get("lastLaunchTime").and_then(|v| v.parse::<i64>().ok()).filter(|t| *t > 0);
    if flag("OverrideMemory") {
        c.memory_mb = cfg.get("MaxMemAlloc").and_then(|v| v.parse().ok()).and_then(sane_memory);
    }
    if flag("OverrideJavaArgs") {
        c.jvm_args = cfg.get("JvmArgs").cloned();
    }
    if flag("OverrideWindow") {
        c.window = Some(WindowSettings {
            custom: true,
            width: cfg.get("MinecraftWinWidth").and_then(|v| v.parse().ok()).unwrap_or(854),
            height: cfg.get("MinecraftWinHeight").and_then(|v| v.parse().ok()).unwrap_or(480),
            fullscreen: flag("LaunchMaximized"),
        });
    }
    Some(c.finish())
}

fn multimc_instances_dir(root: &Path) -> PathBuf {
    let cfg = ["prismlauncher.cfg", "polymc.cfg", "multimc.cfg"]
        .iter()
        .map(|n| read_cfg(&root.join(n)))
        .find(|c| !c.is_empty())
        .unwrap_or_default();
    match cfg.get("InstanceDir").filter(|d| !d.trim().is_empty()) {
        Some(d) if Path::new(d).is_absolute() => PathBuf::from(d),
        Some(d) => root.join(d),
        None => root.join("instances"),
    }
}

fn split_loader_name(name: &str, game: &str) -> (String, Option<String>) {
    let Some((loader, rest)) = name.split_once('-') else { return (normalize_loader(name), None) };
    let version = rest.strip_suffix(&format!("-{game}")).unwrap_or(rest);
    (normalize_loader(loader), Some(version.to_string()).filter(|v| !v.is_empty()))
}

fn curseforge(dir: &Path) -> Option<Candidate> {
    let j = read_json_value(&dir.join("minecraftinstance.json"))?;
    let name = j["name"].as_str().filter(|n| !n.trim().is_empty()).map(str::to_string).unwrap_or_else(|| folder_name(dir));
    let mut c = Candidate::new("CurseForge", dir.to_string_lossy().to_string(), name);
    let game = j["gameVersion"].as_str().or(j["baseModLoader"]["minecraftVersion"].as_str()).unwrap_or("").to_string();
    if !game.is_empty() {
        c.game = Some(GameRef::Exact(game.clone()));
    }
    if let Some(loader) = j["baseModLoader"]["name"].as_str() {
        let (l, v) = split_loader_name(loader, &game);
        c.loader = l;
        c.loader_version = v;
    }
    c.game_dir = Some(dir.to_path_buf());
    c.copy = CopyRule::AllExcept(vec!["minecraftinstance.json", "profileImage", ".curseclient"]);
    c.last_played = iso_millis(&j["lastPlayed"]);
    if j["isMemoryOverride"].as_bool() == Some(true) {
        c.memory_mb = j["allocatedMemory"].as_u64().and_then(sane_memory);
    }
    Some(c.finish())
}

fn modrinth_profiles(root: &Path) -> Vec<Candidate> {
    let profiles = root.join("profiles");
    let mut out = Vec::new();
    let db = root.join("app.db");
    if db.is_file() {
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        if let Ok(conn) = rusqlite::Connection::open_with_flags(&db, flags) {
            if let Ok(mut stmt) = conn.prepare("SELECT path, name, game_version, mod_loader, mod_loader_version FROM profiles") {
                let rows = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                    ))
                });
                if let Ok(rows) = rows {
                    for (path, name, game, loader, loader_version) in rows.flatten() {
                        let dir = profiles.join(&path);
                        let mut c = Candidate::new("Modrinth App", dir.to_string_lossy().to_string(), name);
                        c.game = game.filter(|g| !g.is_empty()).map(GameRef::Exact);
                        c.loader = normalize_loader(loader.as_deref().unwrap_or("vanilla"));
                        c.loader_version = loader_version.filter(|v| !v.is_empty() && v != "stable" && v != "latest");
                        c.game_dir = Some(dir);
                        c.copy = CopyRule::AllExcept(vec!["profile.json"]);
                        out.push(c.finish());
                    }
                }
            }
        }
    }
    if out.is_empty() {
        if let Ok(entries) = std::fs::read_dir(&profiles) {
            for e in entries.flatten() {
                if let Some(c) = modrinth_profile_json(&e.path()) {
                    out.push(c);
                }
            }
        }
    }
    out
}

fn modrinth_profile_json(dir: &Path) -> Option<Candidate> {
    let j = read_json_value(&dir.join("profile.json"))?;
    let m = &j["metadata"];
    let name = m["name"].as_str().map(str::to_string).unwrap_or_else(|| folder_name(dir));
    let mut c = Candidate::new("Modrinth App", dir.to_string_lossy().to_string(), name);
    c.game = m["game_version"].as_str().filter(|g| !g.is_empty()).map(|g| GameRef::Exact(g.into()));
    c.loader = normalize_loader(m["loader"].as_str().unwrap_or("vanilla"));
    c.loader_version = m["loader_version"]["id"].as_str().map(str::to_string);
    c.game_dir = Some(dir.to_path_buf());
    c.copy = CopyRule::AllExcept(vec!["profile.json"]);
    Some(c.finish())
}

fn atlauncher(dir: &Path) -> Option<Candidate> {
    let j = read_json_value(&dir.join("instance.json"))?;
    let l = j.get("launcher")?;
    let name = l["name"].as_str().filter(|n| !n.trim().is_empty()).map(str::to_string).unwrap_or_else(|| folder_name(dir));
    let mut c = Candidate::new("ATLauncher", dir.to_string_lossy().to_string(), name);
    c.game = j["id"].as_str().or(j["minecraftVersion"].as_str()).filter(|g| !g.is_empty()).map(|g| GameRef::Exact(g.into()));
    if let Some(lv) = l.get("loaderVersion").filter(|v| v.is_object()) {
        c.loader = normalize_loader(lv["type"].as_str().unwrap_or("vanilla"));
        c.loader_version = lv["version"].as_str().map(str::to_string);
    }
    c.game_dir = Some(dir.to_path_buf());
    c.copy = CopyRule::AllExcept(vec!["instance.json", "bin", "libraries", "versions", "assets", "disabledmods"]);
    c.last_played = iso_millis(&l["lastPlayed"]);
    c.play_time_secs = l["totalPlayTime"].as_u64().unwrap_or(0);
    c.memory_mb = l["maximumMemory"].as_u64().and_then(sane_memory);
    Some(c.finish())
}

fn gdlauncher_carbon(dir: &Path) -> Option<Candidate> {
    let j = read_json_value(&dir.join("instance.json"))?;
    let cfg = j.get("game_configuration")?;
    let name = j["name"].as_str().filter(|n| !n.trim().is_empty()).map(str::to_string).unwrap_or_else(|| folder_name(dir));
    let mut c = Candidate::new("GDLauncher", dir.to_string_lossy().to_string(), name);
    let standard = &cfg["version"]["Standard"];
    c.game = standard["release"].as_str().filter(|g| !g.is_empty()).map(|g| GameRef::Exact(g.into()));
    if let Some(ml) = standard["modloaders"].as_array().and_then(|a| a.first()) {
        c.loader = normalize_loader(ml["type_"].as_str().or(ml["type"].as_str()).unwrap_or("vanilla"));
        c.loader_version = ml["version"].as_str().map(str::to_string);
    }
    c.game_dir = Some(dir.join("instance"));
    c.play_time_secs = j["seconds_played"].as_u64().unwrap_or(0);
    Some(c.finish())
}

fn gdlauncher_legacy(dir: &Path) -> Option<Candidate> {
    let j = read_json_value(&dir.join("config.json"))?;
    let loader = j.get("loader")?;
    let mut c = Candidate::new("GDLauncher", dir.to_string_lossy().to_string(), folder_name(dir));
    c.game = loader["mcVersion"].as_str().filter(|g| !g.is_empty()).map(|g| GameRef::Exact(g.into()));
    c.loader = normalize_loader(loader["loaderType"].as_str().unwrap_or("vanilla"));
    c.loader_version = loader["loaderVersion"].as_str().map(str::to_string);
    c.game_dir = Some(dir.to_path_buf());
    c.copy = CopyRule::AllExcept(vec!["config.json"]);
    c.play_time_secs = j["timePlayed"].as_u64().unwrap_or(0);
    c.memory_mb = j["javaMemory"].as_u64().and_then(sane_memory);
    Some(c.finish())
}

fn parse_version_id(id: &str) -> (Option<String>, String, Option<String>, Option<String>) {
    let id = id.trim();
    for (prefix, loader) in [("fabric-loader-", "fabric"), ("quilt-loader-", "quilt")] {
        if let Some(rest) = id.strip_prefix(prefix) {
            if let Some((lv, game)) = rest.split_once('-') {
                return (Some(game.into()), loader.into(), Some(lv.into()), None);
            }
        }
    }
    if let Some(v) = id.strip_prefix("neoforge-") {
        return (crate::minecraft::loaders::neoforge_game_version(v), "neoforge".into(), Some(v.into()), None);
    }
    if let Some((game, rest)) = id.split_once("-forge") {
        let v = rest.trim_start_matches('-');
        let v = v.strip_prefix(&format!("{game}-")).unwrap_or(v);
        return (Some(game.into()), "forge".into(), Some(v.into()), None);
    }
    if let Some((game, _)) = id.split_once("-OptiFine") {
        return (Some(game.into()), "vanilla".into(), None, Some("OptiFine itself isn't carried over".into()));
    }
    (Some(id.into()), "vanilla".into(), None, None)
}

fn official_profiles(minecraft: &Path) -> Vec<Candidate> {
    let file = minecraft.join("launcher_profiles.json");
    let Some(j) = read_json_value(&file) else { return vec![] };
    let Some(profiles) = j["profiles"].as_object() else { return vec![] };
    let mut out = Vec::new();
    for (key, p) in profiles {
        let kind = p["type"].as_str().unwrap_or("custom");
        let name = p["name"].as_str().filter(|n| !n.trim().is_empty()).map(str::to_string).unwrap_or_else(|| match kind {
            "latest-release" => "Latest release".into(),
            "latest-snapshot" => "Latest snapshot".into(),
            _ => key.clone(),
        });
        let mut c = Candidate::new("Minecraft Launcher", format!("{}#{key}", file.to_string_lossy()), name);
        let version_id = p["lastVersionId"].as_str().unwrap_or("");
        match (kind, version_id) {
            ("latest-release", _) | (_, "latest-release") => c.game = Some(GameRef::LatestRelease),
            ("latest-snapshot", _) | (_, "latest-snapshot") => c.game = Some(GameRef::LatestSnapshot),
            _ => {
                let (game, loader, lv, note) = parse_version_id(version_id);
                c.game = game.map(GameRef::Exact);
                c.loader = loader;
                c.loader_version = lv;
                c.note = note;
            }
        }
        let custom_dir = p["gameDir"].as_str().filter(|d| !d.trim().is_empty()).map(PathBuf::from);
        let shared = custom_dir.as_ref().is_none_or(|d| d == minecraft);
        c.game_dir = Some(custom_dir.unwrap_or_else(|| minecraft.to_path_buf()));
        c.copy = if shared {
            let mut keep = SHARED_VANILLA.to_vec();
            if c.loader != "vanilla" {
                keep.extend(["mods", "config", "defaultconfigs"]);
            }
            CopyRule::Only(keep)
        } else {
            CopyRule::AllExcept(vec!["versions", "libraries", "assets", "bin", "runtime", "webcache2", "cachedImages"])
        };
        c.last_played = iso_millis(&p["lastUsed"]);
        c.memory_mb = p["javaArgs"].as_str().and_then(xmx_mb).and_then(sane_memory);
        out.push(c.finish());
    }
    out
}

fn minecraft_folder(minecraft: &Path) -> Option<Candidate> {
    if minecraft.join("launcher_profiles.json").exists() || !minecraft.join("saves").is_dir() {
        return None;
    }
    let mut c = Candidate::new("Minecraft folder", format!("{}#folder", minecraft.to_string_lossy()), "Your .minecraft worlds & packs".into());
    c.game = Some(GameRef::LatestRelease);
    c.game_dir = Some(minecraft.to_path_buf());
    c.copy = CopyRule::Only(SHARED_VANILLA.to_vec());
    c.note = Some("Worlds, packs and settings used by Lunar, Badlion and Feather".into());
    Some(c.finish())
}

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var(var).ok().map(PathBuf::from)
}

fn scan_known() -> Vec<Candidate> {
    let mut out = Vec::new();
    let appdata = env_path("APPDATA");
    let home = env_path("USERPROFILE").or_else(|| env_path("HOME"));

    let mut mmc_roots: Vec<(&'static str, PathBuf)> = Vec::new();
    if let Some(a) = &appdata {
        mmc_roots.push(("Prism Launcher", a.join("PrismLauncher")));
        mmc_roots.push(("PolyMC", a.join("PolyMC")));
    }
    if let Some(h) = &home {
        mmc_roots.push(("Prism Launcher", h.join("Library/Application Support/PrismLauncher")));
        mmc_roots.push(("Prism Launcher", h.join(".local/share/PrismLauncher")));
        mmc_roots.push(("Prism Launcher", h.join(".var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher")));
    }
    for (source, root) in mmc_roots.into_iter().filter(|(_, p)| p.is_dir()) {
        for dir in subdirs(&multimc_instances_dir(&root)) {
            out.extend(multimc(&dir, source));
        }
    }

    if let Some(h) = &home {
        for dir in subdirs(&h.join("curseforge").join("minecraft").join("Instances")) {
            out.extend(curseforge(&dir));
        }
    }

    if let Some(a) = &appdata {
        for root in [a.join("ModrinthApp"), a.join("com.modrinth.theseus")] {
            if root.is_dir() {
                out.extend(modrinth_profiles(&root));
            }
        }
        for dir in subdirs(&a.join("ATLauncher").join("instances")) {
            out.extend(atlauncher(&dir));
        }
        for dir in subdirs(&a.join("gdlauncher_carbon").join("data").join("instances")) {
            out.extend(gdlauncher_carbon(&dir));
        }
        for dir in subdirs(&a.join("gdlauncher_next").join("instances")) {
            out.extend(gdlauncher_legacy(&dir));
        }
        let minecraft = a.join(".minecraft");
        if minecraft.is_dir() {
            out.extend(official_profiles(&minecraft));
            out.extend(minecraft_folder(&minecraft));
        }
    }
    out
}

fn subdirs(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
        .unwrap_or_default()
}

fn detect_dir(dir: &Path) -> Vec<Candidate> {
    if dir.join("instance.cfg").exists() || dir.join("mmc-pack.json").exists() {
        return multimc(dir, "MultiMC / Prism").into_iter().collect();
    }
    if dir.join("minecraftinstance.json").exists() {
        return curseforge(dir).into_iter().collect();
    }
    if dir.join("instance.json").exists() {
        if let Some(c) = atlauncher(dir).or_else(|| gdlauncher_carbon(dir)) {
            return vec![c];
        }
    }
    if dir.join("config.json").exists() {
        if let Some(c) = gdlauncher_legacy(dir) {
            return vec![c];
        }
    }
    if dir.join("profile.json").exists() {
        if let Some(c) = modrinth_profile_json(dir) {
            return vec![c];
        }
    }
    if dir.parent().is_some_and(|p| p.file_name().is_some_and(|n| n == "profiles")) {
        if let Some(root) = dir.parent().and_then(Path::parent) {
            let key = dir.to_string_lossy().to_string();
            let found: Vec<Candidate> = modrinth_profiles(root).into_iter().filter(|c| c.key == key).collect();
            if !found.is_empty() {
                return found;
            }
        }
    }
    if dir.join("launcher_profiles.json").exists() {
        return official_profiles(dir);
    }
    minecraft_folder(dir).into_iter().collect()
}

fn scan_folder(dir: &Path) -> Vec<Candidate> {
    let direct = detect_dir(dir);
    if !direct.is_empty() {
        return direct;
    }
    if ["prismlauncher.cfg", "polymc.cfg", "multimc.cfg"].iter().any(|f| dir.join(f).exists()) {
        return subdirs(&multimc_instances_dir(dir)).iter().flat_map(|d| detect_dir(d)).collect();
    }
    if dir.join("app.db").exists() {
        return modrinth_profiles(dir);
    }
    for sub in ["instances", "Instances", "profiles"] {
        let found: Vec<Candidate> = subdirs(&dir.join(sub)).iter().flat_map(|d| detect_dir(d)).collect();
        if !found.is_empty() {
            return found;
        }
    }
    subdirs(dir).iter().flat_map(|d| detect_dir(d)).collect()
}

fn candidate_for(key: &str) -> Option<Candidate> {
    if let Some((left, right)) = key.rsplit_once('#') {
        let left = Path::new(left);
        if right == "folder" {
            return minecraft_folder(left);
        }
        if left.file_name().is_some_and(|n| n == "launcher_profiles.json") {
            return official_profiles(left.parent()?).into_iter().find(|c| c.key == key);
        }
    }
    detect_dir(Path::new(key)).into_iter().find(|c| c.key == key)
}

#[tauri::command]
pub async fn find_external_instances(state: State<'_, Arc<AppState>>, folder: Option<String>) -> Result<Vec<ExternalInstance>> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let existing = instances::list_all(&state);
        let found = match &folder {
            Some(f) => {
                let found = scan_folder(Path::new(f));
                if found.is_empty() {
                    bail!("No instances from a supported launcher were found there. Pick an instance folder, a launcher's instances folder or a .minecraft folder.");
                }
                found
            }
            None => scan_known(),
        };
        let mut out: Vec<ExternalInstance> = found.iter().map(|c| view(c, &existing)).collect();
        out.sort_by(|a, b| a.source.cmp(&b.source).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?
}

fn collect_files(root: &Path, dir: &Path, rule: &CopyRule, out: &mut Vec<(PathBuf, u64)>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if dir == root && !top_level_allowed(rule, &name) {
            continue;
        }
        let ft = entry.file_type()?;
        if ft.is_dir() {
            collect_files(root, &path, rule, out)?;
        } else if ft.is_file() {
            if name == "session.lock" {
                continue;
            }
            out.push((path, entry.metadata()?.len()));
        }
    }
    Ok(())
}

fn copy_game_dir(task: &TaskHandle, from: &Path, to: &Path, rule: &CopyRule) -> Result<()> {
    task.stage("Scanning files", false);
    let mut files = Vec::new();
    collect_files(from, from, rule, &mut files)?;
    let total: u64 = files.iter().map(|(_, n)| n).sum();
    task.stage("Copying mods, settings and worlds", true);
    task.set_totals(files.len() as u64, total);
    std::fs::create_dir_all(to)?;
    for (path, size) in files {
        task.check_cancelled()?;
        let rel = path.strip_prefix(from).map_err(|e| Error::Msg(e.to_string()))?;
        let target = to.join(rel);
        util::ensure_parent(&target)?;
        std::fs::copy(&path, &target).map_err(|e| Error::Msg(format!("Couldn't copy {}: {e}", rel.display())))?;
        task.add_bytes(size);
        task.file_done();
    }
    Ok(())
}

#[tauri::command]
pub async fn import_external_instance(state: State<'_, Arc<AppState>>, path: String) -> Result<InstanceView> {
    let state = state.inner().clone();
    let key = path.clone();
    let candidate = tokio::task::spawn_blocking(move || candidate_for(&key))
        .await
        .map_err(|e| Error::Msg(e.to_string()))?;
    let Some(c) = candidate else {
        bail!("That instance can't be found any more. Refresh the list and try again.");
    };
    if let Some(p) = &c.problem {
        bail!("{p}");
    }
    let game_version = match &c.game {
        Some(GameRef::Exact(v)) => v.clone(),
        Some(GameRef::LatestRelease) => crate::minecraft::install::manifest(&state).await?.latest.release,
        Some(GameRef::LatestSnapshot) => crate::minecraft::install::manifest(&state).await?.latest.snapshot,
        None => bail!("Couldn't tell which Minecraft version this uses."),
    };
    let from = c.game_dir.clone().ok_or("This instance has no game folder.")?;

    let mut inst = instances::create(
        &state,
        instances::CreateInstance {
            name: c.name.clone(),
            game_version,
            loader: c.loader.clone(),
            loader_version: c.loader_version.clone(),
            icon: Some(if c.loader == "vanilla" { "grass" } else { "diamond" }.into()),
        },
    )?;
    inst.imported_from = Some(c.key.clone());
    inst.play_time_secs = c.play_time_secs;
    inst.last_played = c.last_played;
    inst.memory_mb = c.memory_mb;
    if let Some(args) = &c.jvm_args {
        inst.jvm_args = args.clone();
    }
    if let Some(w) = &c.window {
        inst.window = w.clone();
    }
    instances::save(&state, &inst)?;

    let task = state.tasks.start("copy", format!("Importing {}", inst.name), Some(inst.id.clone()));
    let dest = instances::game_dir(&state, &inst);
    let t = task.clone();
    let rule = c.copy.clone();
    let result = tokio::task::spawn_blocking(move || copy_game_dir(&t, &from, &dest, &rule))
        .await
        .map_err(|e| Error::Msg(e.to_string()))
        .and_then(|r| r);
    if result.is_err() {
        let dir = instances::instance_dir(&state, &inst.id);
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(dir)).await;
    }
    task.complete(result)?;
    state.update_settings(|s| s.selected_instance = Some(inst.id.clone()))?;
    Ok(instances::view(&state, inst))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vitra-import-{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unquotes_qt_values() {
        assert_eq!(unquote(r#""My \"modded\" world""#), r#"My "modded" world"#);
        assert_eq!(unquote("plain"), "plain");
    }

    #[test]
    fn reads_general_section_only() {
        let dir = temp_dir("cfg");
        let p = dir.join("instance.cfg");
        std::fs::write(&p, "[General]\nname=mc\nMaxMemAlloc=8192\n[UI]\nname=wrong\n").unwrap();
        let cfg = read_cfg(&p);
        assert_eq!(cfg.get("name").map(String::as_str), Some("mc"));
        assert_eq!(cfg.get("MaxMemAlloc").map(String::as_str), Some("8192"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn official_version_ids() {
        let p = |id: &str| {
            let (g, l, v, _) = parse_version_id(id);
            (g, l, v)
        };
        assert_eq!(p("1.21.1"), (Some("1.21.1".into()), "vanilla".into(), None));
        assert_eq!(p("fabric-loader-0.16.5-1.21.1"), (Some("1.21.1".into()), "fabric".into(), Some("0.16.5".into())));
        assert_eq!(p("quilt-loader-0.26.4-1.21.1"), (Some("1.21.1".into()), "quilt".into(), Some("0.26.4".into())));
        assert_eq!(p("1.20.1-forge-47.3.0"), (Some("1.20.1".into()), "forge".into(), Some("47.3.0".into())));
        assert_eq!(p("1.12.2-forge1.12.2-14.23.5.2847"), (Some("1.12.2".into()), "forge".into(), Some("14.23.5.2847".into())));
        assert_eq!(p("neoforge-21.1.77"), (Some("1.21.1".into()), "neoforge".into(), Some("21.1.77".into())));
        assert_eq!(p("1.20.1-OptiFine_HD_U_I6"), (Some("1.20.1".into()), "vanilla".into(), None));
    }

    #[test]
    fn curseforge_loader_names() {
        assert_eq!(split_loader_name("forge-14.23.5.2859", "1.12.2"), ("forge".into(), Some("14.23.5.2859".into())));
        assert_eq!(split_loader_name("fabric-0.15.11-1.20.1", "1.20.1"), ("fabric".into(), Some("0.15.11".into())));
        assert_eq!(split_loader_name("neoforge-21.1.65", "1.21.1"), ("neoforge".into(), Some("21.1.65".into())));
    }

    #[test]
    fn memory_args() {
        assert_eq!(xmx_mb("-Xmx2G -XX:+UseG1GC"), Some(2048));
        assert_eq!(xmx_mb("-Xms512m -Xmx4096M"), Some(4096));
        assert_eq!(xmx_mb("-XX:+UseG1GC"), None);
    }

    #[test]
    fn reads_curseforge_instance() {
        let dir = temp_dir("cf");
        std::fs::create_dir_all(dir.join("mods")).unwrap();
        std::fs::write(dir.join("mods/a.jar"), b"x").unwrap();
        std::fs::write(
            dir.join("minecraftinstance.json"),
            "\u{FEFF}{\"name\":\"Pack\",\"gameVersion\":\"1.20.1\",\"baseModLoader\":{\"name\":\"fabric-0.15.11-1.20.1\"}}",
        )
        .unwrap();
        let c = detect_dir(&dir).pop().unwrap();
        assert_eq!((c.source, c.name.as_str(), c.loader.as_str()), ("CurseForge", "Pack", "fabric"));
        assert_eq!(c.game, Some(GameRef::Exact("1.20.1".into())));
        assert_eq!(c.loader_version.as_deref(), Some("0.15.11"));
        assert!(c.problem.is_none());
        assert!(!top_level_allowed(&c.copy, "minecraftinstance.json"));
        assert_eq!(view(&c, &[]).mod_count, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_atlauncher_and_gdlauncher() {
        let at = temp_dir("atl");
        std::fs::write(
            at.join("instance.json"),
            r#"{"id":"1.20.1","launcher":{"name":"Skies","loaderVersion":{"type":"Forge","version":"47.2.0"},"maximumMemory":4096}}"#,
        )
        .unwrap();
        let c = detect_dir(&at).pop().unwrap();
        assert_eq!((c.source, c.loader.as_str(), c.loader_version.as_deref()), ("ATLauncher", "forge", Some("47.2.0")));

        let gd = temp_dir("gdl");
        std::fs::create_dir_all(gd.join("instance")).unwrap();
        std::fs::write(
            gd.join("instance.json"),
            r#"{"name":"Fab","game_configuration":{"version":{"Standard":{"release":"1.21","modloaders":[{"type_":"Fabric","version":"0.16.0"}]}}}}"#,
        )
        .unwrap();
        let c = detect_dir(&gd).pop().unwrap();
        assert_eq!((c.source, c.loader.as_str()), ("GDLauncher", "fabric"));
        assert_eq!(c.game_dir.as_deref(), Some(gd.join("instance").as_path()));
        assert!(c.problem.is_none());
        let _ = std::fs::remove_dir_all(at);
        let _ = std::fs::remove_dir_all(gd);
    }

    #[test]
    fn official_launcher_never_copies_credentials() {
        let mc = temp_dir("mcl");
        std::fs::create_dir_all(mc.join("saves/World")).unwrap();
        std::fs::write(mc.join("saves/World/level.dat"), b"x").unwrap();
        std::fs::write(
            mc.join("launcher_profiles.json"),
            r#"{"profiles":{"a":{"name":"Fab","type":"custom","lastVersionId":"fabric-loader-0.16.5-1.21.1","javaArgs":"-Xmx3G"},"b":{"type":"latest-release","lastVersionId":"latest-release"}}}"#,
        )
        .unwrap();
        let found = detect_dir(&mc);
        assert_eq!(found.len(), 2);
        let fab = found.iter().find(|c| c.name == "Fab").unwrap();
        assert!(top_level_allowed(&fab.copy, "mods") && top_level_allowed(&fab.copy, "saves"));
        assert!(!top_level_allowed(&fab.copy, "versions"));
        assert!(!top_level_allowed(&fab.copy, "launcher_accounts.json"));
        let latest = found.iter().find(|c| c.name == "Latest release").unwrap();
        assert_eq!(latest.game, Some(GameRef::LatestRelease));
        assert!(!top_level_allowed(&latest.copy, "mods"));
        assert_eq!(candidate_for(&fab.key).map(|c| c.name), Some("Fab".into()));
        assert_eq!(view(fab, &[]).world_count, 1);
        let _ = std::fs::remove_dir_all(mc);
    }
}

#[cfg(test)]
mod live {
    #[test]
    #[ignore]
    fn live_scan() {
        for c in super::scan_known() {
            let v = super::view(&c, &[]);
            println!("{:<20} {:<28} {:<10} {:<9} {:<16} mods={:<3} worlds={:<2} {:>7.1} MB problem={:?} note={:?}", v.source, v.name.chars().take(28).collect::<String>(), v.game_version, v.loader, v.loader_version.unwrap_or_default(), v.mod_count, v.world_count, v.size_bytes as f64 / 1048576.0, v.problem, v.note);
        }
    }
}
