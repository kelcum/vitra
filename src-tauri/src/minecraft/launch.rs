use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc;

use crate::auth::{self, Identity};
use crate::bail;
use crate::error::Result;
use crate::instances::{self, Instance};
use crate::minecraft::install::{self, Installed};
use crate::minecraft::manifest::{self, Features};
use crate::settings;
use crate::state::{AppState, RunningGame, USER_AGENT};
use crate::util;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchOptions {
    pub world: Option<String>,
    pub server: Option<String>,
    pub demo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub level: String,
    pub thread: Option<String>,
    pub text: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogBatch {
    instance_id: String,
    lines: Vec<LogLine>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameExit {
    pub instance_id: String,
    pub code: Option<i32>,
    pub crashed: bool,
    pub killed: bool,
    pub crash_report: Option<String>,
    pub tail: Vec<String>,
    pub played_secs: u64,
}

pub fn preset_flags(preset: &str, java_major: u32) -> Vec<String> {
    let g1 = "-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M";
    let flags = match preset {
        "low-latency" if java_major >= 21 && java_major < 23 => "-XX:+UseZGC -XX:+ZGenerational -XX:+AlwaysPreTouch".to_string(),
        "low-latency" if java_major >= 23 => "-XX:+UseZGC -XX:+AlwaysPreTouch".to_string(),
        "low-latency" if java_major >= 17 => "-XX:+UseZGC".to_string(),
        "custom" | "none" => String::new(),
        _ => g1.to_string(),
    };
    flags.split_whitespace().map(String::from).collect()
}

pub fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

fn asset_index_id(v: &manifest::VersionJson) -> String {
    v.asset_index.as_ref().map(|a| a.id.clone()).or_else(|| v.assets.clone()).unwrap_or_default()
}

fn build_classpath(state: &AppState, installed: &Installed) -> String {
    let libs = state.libraries_dir();
    let mut entries: Vec<String> = Vec::new();
    for lib in &installed.version.libraries {
        if !lib.is_allowed() {
            continue;
        }
        if let Some((rel, _, _, _)) = lib.artifact() {
            let p = libs.join(rel);
            let s = p.to_string_lossy().to_string();
            if !entries.contains(&s) {
                entries.push(s);
            }
        }
    }
    entries.push(installed.client_jar.to_string_lossy().to_string());
    entries.join(util::classpath_separator())
}

fn ignore_client_jar(args: &mut [String], client_jar: &Path) {
    let Some(name) = client_jar.file_name().map(|n| n.to_string_lossy().to_string()) else {
        return;
    };
    for arg in args.iter_mut() {
        if let Some(list) = arg.strip_prefix("-DignoreList=")
            && !list.split(',').any(|e| !e.is_empty() && name.starts_with(e))
        {
            arg.push(',');
            arg.push_str(&name);
        }
    }
}

pub fn build_command(
    state: &AppState,
    inst: &Instance,
    installed: &Installed,
    identity: &Identity,
    opts: &LaunchOptions,
) -> Result<Vec<String>> {
    let v = &installed.version;
    let game_dir = instances::game_dir(state, inst);
    let settings = state.settings();
    let memory = inst.memory_mb.unwrap_or(settings.default_memory_mb);
    let total = settings::total_memory_mb();
    if memory > total.saturating_sub(512) {
        bail!("This instance is set to use {memory} MB of memory but the computer only has {total} MB. Lower it in the instance settings.");
    }
    let java_major = crate::java::parse_major(
        &std::fs::read_to_string(installed.java.parent().and_then(Path::parent).unwrap_or(Path::new("")).join("release"))
            .ok()
            .and_then(|r| r.lines().find_map(|l| l.strip_prefix("JAVA_VERSION=").map(|v| v.trim_matches('"').to_string())))
            .unwrap_or_else(|| v.java_major().to_string()),
    );

    let server = opts.server.as_deref().map(str::trim).filter(|s| !s.is_empty() && !identity.demo);
    let world = if server.is_some() { None } else { opts.world.as_deref() };
    let quick_play = (world.is_some() || server.is_some()) && v.supports_quick_play();
    let features = Features {
        is_demo_user: identity.demo,
        has_custom_resolution: inst.window.custom && !inst.window.fullscreen,
        has_quick_plays_support: quick_play,
        is_quick_play_singleplayer: quick_play && world.is_some(),
        is_quick_play_multiplayer: quick_play && server.is_some(),
    };

    let mut vars: HashMap<&str, String> = HashMap::new();
    let classpath = build_classpath(state, installed);
    let assets_root = state.assets_dir();
    let asset_index = asset_index_id(v);
    vars.insert("auth_player_name", identity.name.clone());
    vars.insert("version_name", v.id.clone());
    vars.insert("game_directory", game_dir.to_string_lossy().to_string());
    vars.insert("assets_root", assets_root.to_string_lossy().to_string());
    vars.insert("assets_index_name", asset_index);
    vars.insert("auth_uuid", identity.uuid.clone());
    vars.insert("auth_access_token", identity.token.clone());
    vars.insert("auth_session", format!("token:{}:{}", identity.token, identity.uuid));
    vars.insert("clientid", String::new());
    vars.insert("auth_xuid", identity.xuid.clone());
    vars.insert("user_type", identity.user_type.clone());
    vars.insert("user_properties", "{}".into());
    vars.insert("version_type", v.kind.clone().unwrap_or_else(|| "release".into()));
    vars.insert("natives_directory", installed.natives_dir.to_string_lossy().to_string());
    vars.insert("launcher_name", "vitra".into());
    vars.insert("launcher_version", env!("CARGO_PKG_VERSION").into());
    vars.insert("classpath", classpath.clone());
    vars.insert("classpath_separator", util::classpath_separator().into());
    vars.insert("library_directory", state.libraries_dir().to_string_lossy().to_string());
    vars.insert("resolution_width", inst.window.width.to_string());
    vars.insert("resolution_height", inst.window.height.to_string());
    vars.insert(
        "game_assets",
        installed.legacy_assets.clone().unwrap_or_else(|| assets_root.clone()).to_string_lossy().to_string(),
    );
    vars.insert("quickPlayPath", game_dir.join("quickPlay").join("vitra.json").to_string_lossy().to_string());
    vars.insert("quickPlaySingleplayer", world.unwrap_or_default().to_string());
    vars.insert("quickPlayMultiplayer", server.unwrap_or_default().to_string());
    vars.insert("quickPlayRealms", String::new());

    let mut args: Vec<String> = Vec::new();
    args.push(format!("-Xmx{memory}M"));
    args.push(format!("-Xms{}M", memory.min(1024)));
    args.extend(preset_flags(&inst.jvm_preset, java_major));
    args.extend(split_args(&settings.default_jvm_args));
    args.extend(split_args(&inst.jvm_args));
    args.push("-Dlog4j2.formatMsgNoLookups=true".into());

    match &v.arguments {
        Some(a) if !a.jvm.is_empty() => {
            let mut jvm = manifest::expand_args(&a.jvm, &features, &vars);
            ignore_client_jar(&mut jvm, &installed.client_jar);
            args.extend(jvm);
        }
        _ => {
            args.push(format!("-Djava.library.path={}", installed.natives_dir.display()));
            args.push("-cp".into());
            args.push(classpath);
        }
    }
    if let Some(log) = v.logging.as_ref().and_then(|l| l.client.as_ref()) {
        let path = state.assets_dir().join("log_configs").join(&log.file.id);
        let mut lv = HashMap::new();
        lv.insert("path", path.to_string_lossy().to_string());
        args.push(manifest::substitute(&log.argument, &lv));
    }

    let main_class = v.main_class.clone().ok_or_else(|| crate::error::Error::Msg("Version has no main class".into()))?;
    args.push(main_class);

    match (&v.arguments, &v.minecraft_arguments) {
        (_, Some(legacy)) if v.arguments.as_ref().map(|a| a.game.is_empty()).unwrap_or(true) => {
            args.extend(legacy.split_whitespace().map(|a| manifest::substitute(a, &vars)));
            if features.has_custom_resolution {
                args.extend(["--width".into(), inst.window.width.to_string(), "--height".into(), inst.window.height.to_string()]);
            }
            if identity.demo {
                args.push("--demo".into());
            }
        }
        (Some(a), _) => args.extend(manifest::expand_args(&a.game, &features, &vars)),
        _ => {}
    }
    if inst.window.fullscreen {
        args.push("--fullscreen".into());
    }
    if let (Some(addr), false) = (server, quick_play) {
        let (host, port) = match addr.rsplit_once(':') {
            Some((h, p)) if p.parse::<u16>().is_ok() => (h.to_string(), p.to_string()),
            _ => (addr.to_string(), "25565".to_string()),
        };
        args.extend(["--server".into(), host, "--port".into(), port]);
    }
    args.extend(split_args(&inst.game_args));
    Ok(args)
}

struct LogParser {
    buf: Option<String>,
}

fn attr(s: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = s.find(&key)? + key.len();
    let end = s[start..].find('"')?;
    Some(s[start..start + end].to_string())
}

fn cdata(s: &str, tag: &str) -> Option<String> {
    let open = format!("<log4j:{tag}>");
    let start = s.find(&open)? + open.len();
    let end = s[start..].find(&format!("</log4j:{tag}>"))?;
    let inner = &s[start..start + end];
    let inner = inner.trim();
    let inner = inner.strip_prefix("<![CDATA[").and_then(|x| x.strip_suffix("]]>")).unwrap_or(inner);
    Some(inner.to_string())
}

fn plain_level(line: &str) -> String {
    for lvl in ["FATAL", "ERROR", "WARN", "INFO", "DEBUG"] {
        if line.contains(&format!("/{lvl}]")) || line.contains(&format!("[{lvl}]")) {
            return lvl.into();
        }
    }
    if line.contains("Exception") || line.trim_start().starts_with("at ") {
        return "ERROR".into();
    }
    "INFO".into()
}

impl LogParser {
    fn feed(&mut self, line: &str) -> Option<LogLine> {
        if let Some(buf) = &mut self.buf {
            buf.push('\n');
            buf.push_str(line);
            if line.contains("</log4j:Event>") {
                let event = self.buf.take().unwrap();
                return Some(Self::parse_event(&event));
            }
            return None;
        }
        if line.trim_start().starts_with("<log4j:Event") {
            if line.contains("</log4j:Event>") {
                return Some(Self::parse_event(line));
            }
            self.buf = Some(line.to_string());
            return None;
        }
        Some(LogLine { level: plain_level(line), thread: None, text: line.to_string(), time: util::now_millis() })
    }

    fn parse_event(event: &str) -> LogLine {
        let mut text = cdata(event, "Message").unwrap_or_default();
        if let Some(t) = cdata(event, "Throwable") {
            text.push('\n');
            text.push_str(&t);
        }
        LogLine {
            level: attr(event, "level").unwrap_or_else(|| "INFO".into()),
            thread: attr(event, "thread"),
            text,
            time: attr(event, "timestamp").and_then(|t| t.parse().ok()).unwrap_or_else(util::now_millis),
        }
    }
}

fn write_launch_record(state: &AppState, inst: &Instance, java: &Path, args: &[String], token: &str) {
    let redact = |s: &str| {
        if s.starts_with("-Dvitra.cosmetics.token=") {
            "-Dvitra.cosmetics.token=<hidden>".to_string()
        } else if token.len() > 8 {
            s.replace(token, "<access token hidden>")
        } else {
            s.to_string()
        }
    };
    let mut out = format!(
        "Vitra {} — launch of \"{}\" at {}\nJava: {}\n\n",
        env!("CARGO_PKG_VERSION"),
        inst.name,
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        java.display()
    );
    for a in args {
        out.push_str(&redact(a));
        out.push('\n');
    }
    let path = instances::game_dir(state, inst).join("logs").join("vitra-launch.txt");
    let _ = util::write_atomic(&path, out.as_bytes());
}

fn newest_crash_report(game_dir: &Path, since_ms: i64) -> Option<PathBuf> {
    let dir = game_dir.join("crash-reports");
    let mut best: Option<(i64, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let modified = e
            .metadata()
            .ok()?
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64;
        if modified >= since_ms && best.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            best = Some((modified, e.path()));
        }
    }
    best.map(|(_, p)| p)
}

fn set_window_for_game(state: &AppState, running: bool) {
    let settings = state.settings();
    let Some(win) = state.app.get_webview_window("main") else { return };
    if running {
        match settings.on_game_launch.as_str() {
            "minimize" => {
                let _ = win.minimize();
            }
            "hide" => {
                let _ = win.hide();
            }
            _ => {}
        }
    } else if settings.reopen_on_exit && settings.on_game_launch != "keep" {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

struct LaunchSlot<'a> {
    state: &'a AppState,
    id: String,
}

impl Drop for LaunchSlot<'_> {
    fn drop(&mut self) {
        self.state.launching.lock().unwrap().remove(&self.id);
    }
}

fn reserve<'a>(state: &'a AppState, id: &str) -> Result<LaunchSlot<'a>> {
    let mut launching = state.launching.lock().unwrap();
    if state.running.lock().unwrap().contains_key(id) {
        bail!("This instance is already running.");
    }
    if !launching.insert(id.to_string()) {
        bail!("This instance is already starting.");
    }
    Ok(LaunchSlot { state, id: id.to_string() })
}

async fn read_lines(stream: impl AsyncRead + Unpin, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                on_line(String::from_utf8_lossy(&buf).into_owned());
            }
        }
    }
}

pub async fn launch(state: Arc<AppState>, id: String, opts: LaunchOptions) -> Result<()> {
    let _slot = reserve(&state, &id)?;
    let inst = instances::load(&state, &id)?;
    let task = state.tasks.start("launch", format!("Launching {}", inst.name), Some(id.clone()));

    let prepared = async {
        task.stage("Checking account", false);
        let identity = auth::launch_identity(&state, opts.demo).await?;
        let installed = install::install_instance(&state, &task, inst.clone(), false).await?;
        let inst = instances::load(&state, &id)?;
        task.stage("Starting Minecraft", false);
        let mut args = build_command(&state, &inst, &installed, &identity, &opts)?;
        let cosmetics = crate::cosmetics::launch_args(&state, &inst, &identity).await;
        if let Some(at) = installed.version.main_class.as_ref().and_then(|m| args.iter().position(|a| a == m)) {
            args.splice(at..at, cosmetics);
        }
        write_launch_record(&state, &inst, &installed.java, &args, &identity.token);
        Ok::<_, crate::error::Error>((inst, installed, args, identity.name))
    }
    .await;
    let (inst, installed, args, player) = task.complete(prepared)?;

    let game_dir = instances::game_dir(&state, &inst);
    let mut cmd = tokio::process::Command::new(&installed.java);
    cmd.args(&args)
        .current_dir(&game_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("VITRA_LAUNCHER", USER_AGENT)
        .kill_on_drop(false);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let mut child = cmd.spawn().map_err(|e| crate::error::Error::Msg(format!("Couldn't start Java: {e}")))?;
    let pid = child.id().unwrap_or(0);
    let started_at = util::now_millis();
    let (kill_tx, mut kill_rx) = tokio::sync::watch::channel(false);
    let (tx, mut rx) = mpsc::unbounded_channel::<LogLine>();
    state.running.lock().unwrap().insert(id.clone(), RunningGame { pid, started_at, kill: kill_tx, log: tx.downgrade() });
    state.presence.game_started(&inst, started_at);
    let _ = state.app.emit("game://started", serde_json::json!({ "instanceId": id, "pid": pid }));
    set_window_for_game(&state, true);

    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut parser = LogParser { buf: None };
            read_lines(out, |line| {
                if let Some(l) = parser.feed(&line) {
                    let _ = tx.send(l);
                }
            })
            .await;
        });
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            read_lines(err, |line| {
                let level = if line.contains("WARN") { "WARN" } else { "ERROR" };
                let _ = tx.send(LogLine { level: level.into(), thread: None, text: line, time: util::now_millis() });
            })
            .await;
        });
    }
    drop(tx);

    let app = state.app.clone();
    let log_id = id.clone();
    let log_state = state.clone();
    let settings = state.settings();
    let recorder = (settings.memories && settings.clips)
        .then(|| {
            crate::clips::Recorder::start(
                pid,
                state.cache_dir().join("clips").join(format!("{id}-{pid}")),
                crate::clips::ClipSettings::from(&settings),
            )
        })
        .flatten()
        .map(Arc::new);
    let mut memories = crate::memories::Watcher::new(
        state.clone(),
        crate::memories::GameInfo {
            instance: inst.clone(),
            game_dir: game_dir.clone(),
            client_jar: installed.client_jar.clone(),
            asset_index: asset_index_id(&installed.version),
            player,
            pid,
            started_at,
        },
        recorder,
    );
    let tail_handle = tauri::async_runtime::spawn(async move {
        let mut tail: Vec<String> = Vec::new();
        let mut batch: Vec<LogLine> = Vec::new();
        let mut tick = tokio::time::interval(Duration::from_millis(120));
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(l) => {
                        log_state.presence.game_log(&log_id, &l.text);
                        memories.line(&l.text);
                        tail.push(l.text.clone());
                        if tail.len() > 40 { tail.remove(0); }
                        batch.push(l);
                        if batch.len() >= 400 {
                            let _ = app.emit("game://log", LogBatch { instance_id: log_id.clone(), lines: std::mem::take(&mut batch) });
                        }
                    }
                    None => break,
                },
                _ = tick.tick() => {
                    if !batch.is_empty() {
                        let _ = app.emit("game://log", LogBatch { instance_id: log_id.clone(), lines: std::mem::take(&mut batch) });
                    }
                }
            }
        }
        if !batch.is_empty() {
            let _ = app.emit("game://log", LogBatch { instance_id: log_id.clone(), lines: batch });
        }
        tail
    });

    let st = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut killed = false;
        let mut can_stop = true;
        let status = loop {
            tokio::select! {
                status = child.wait() => break status.ok(),
                changed = kill_rx.changed(), if can_stop => match changed {
                    Ok(()) => {
                        if *kill_rx.borrow() {
                            killed = true;
                            let _ = child.kill().await;
                        }
                    }
                    Err(_) => can_stop = false,
                },
            }
        };
        let tail = tail_handle.await.unwrap_or_default();
        let played_secs = ((util::now_millis() - started_at) / 1000).max(0) as u64;
        st.running.lock().unwrap().remove(&id);
        st.presence.game_exited(&id);

        if let Ok(mut inst) = instances::load(&st, &id) {
            inst.last_played = Some(util::now_millis());
            inst.play_time_secs += played_secs;
            let _ = instances::save(&st, &inst);
        }
        let code = status.and_then(|s| s.code());
        let report = newest_crash_report(&game_dir, started_at);
        let crashed = !killed && (report.is_some() || code.map(|c| c != 0).unwrap_or(true));
        let exit = GameExit {
            instance_id: id.clone(),
            code,
            crashed,
            killed,
            crash_report: report.map(|p| p.to_string_lossy().to_string()),
            tail: if crashed { tail } else { vec![] },
            played_secs,
        };
        set_window_for_game(&st, false);
        let _ = st.app.emit("game://exited", exit);
    });
    Ok(())
}

#[tauri::command]
pub async fn launch_instance(state: State<'_, Arc<AppState>>, id: String, options: Option<LaunchOptions>) -> Result<()> {
    launch(state.inner().clone(), id, options.unwrap_or_default()).await
}

#[tauri::command]
pub fn stop_instance(state: State<'_, Arc<AppState>>, id: String) -> Result<()> {
    let running = state.running.lock().unwrap();
    match running.get(&id) {
        Some(game) => {
            let _ = game.kill.send(true);
            Ok(())
        }
        None => bail!("The game isn't running."),
    }
}

#[tauri::command]
pub fn inject_game_log(state: State<'_, Arc<AppState>>, id: String, text: String) -> Result<()> {
    if !cfg!(debug_assertions) {
        bail!("Only available in development builds.");
    }
    let running = state.running.lock().unwrap();
    let Some(tx) = running.get(&id).and_then(|g| g.log.upgrade()) else { bail!("The game isn't running.") };
    let _ = tx.send(LogLine { level: "INFO".into(), thread: Some("Render thread".into()), text, time: util::now_millis() });
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningInfo {
    pub instance_id: String,
    pub pid: u32,
    pub started_at: i64,
}

#[tauri::command]
pub fn running_instances(state: State<'_, Arc<AppState>>) -> Vec<RunningInfo> {
    state
        .running
        .lock()
        .unwrap()
        .iter()
        .map(|(id, g)| RunningInfo { instance_id: id.clone(), pid: g.pid, started_at: g.started_at })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_quoted_args() {
        assert_eq!(split_args(r#"-Da=1  -Db="x y" -Dc"#), vec!["-Da=1", "-Db=x y", "-Dc"]);
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn parses_log4j_events() {
        let mut p = LogParser { buf: None };
        assert!(p.feed(r#"<log4j:Event logger="a" timestamp="5" level="WARN" thread="Render thread">"#).is_none());
        assert!(p.feed("  <log4j:Message><![CDATA[Hello world]]></log4j:Message>").is_none());
        let line = p.feed("</log4j:Event>").unwrap();
        assert_eq!(line.level, "WARN");
        assert_eq!(line.text, "Hello world");
        assert_eq!(line.thread.as_deref(), Some("Render thread"));
        assert_eq!(line.time, 5);
        let plain = p.feed("[12:00:00] [main/ERROR]: boom").unwrap();
        assert_eq!(plain.level, "ERROR");
    }

    #[test]
    fn presets() {
        assert!(preset_flags("balanced", 21).contains(&"-XX:+UseG1GC".to_string()));
        assert!(preset_flags("low-latency", 21).contains(&"-XX:+ZGenerational".to_string()));
        assert!(!preset_flags("low-latency", 25).contains(&"-XX:+ZGenerational".to_string()));
        assert!(preset_flags("low-latency", 8).contains(&"-XX:+UseG1GC".to_string()));
    }

    #[test]
    fn bootstrap_skips_vanilla_jar() {
        let jar = Path::new("versions").join("1.20.1").join("1.20.1.jar");
        let mut args = vec![
            "-DignoreList=bootstraplauncher,asm,forge-,1.20.1-forge-47.4.10.jar".to_string(),
            "-DlibraryDirectory=libs".to_string(),
        ];
        ignore_client_jar(&mut args, &jar);
        assert_eq!(args[0], "-DignoreList=bootstraplauncher,asm,forge-,1.20.1-forge-47.4.10.jar,1.20.1.jar");
        assert_eq!(args[1], "-DlibraryDirectory=libs");
        ignore_client_jar(&mut args, &jar);
        assert!(args[0].ends_with(",1.20.1-forge-47.4.10.jar,1.20.1.jar"));
    }
}
