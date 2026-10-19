use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::discord::Client;
use crate::instances::Instance;
use crate::settings::Settings;
use crate::state::AppState;
use crate::util;

const DISCORD_APP_ID: &str = "1557364725438746676";
const GET_VITRA: &str = "https://xan.gripe/vitra/";
const RETRY: Duration = Duration::from_secs(20);
const SERVER_REFRESH: Duration = Duration::from_secs(60);
const MIN_GAP: Duration = Duration::from_secs(4);
const DEFAULT_PORT: u16 = 25565;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    Menu,
    World,
    Server(String),
}

#[derive(Debug, Clone)]
struct Game {
    instance_id: String,
    title: String,
    started_at: i64,
    place: Place,
}

#[derive(Default)]
pub struct Presence {
    games: Mutex<Vec<Game>>,
    changed: Notify,
    client: tokio::sync::Mutex<Option<Client>>,
}

impl Presence {
    pub fn poke(&self) {
        self.changed.notify_one();
    }

    pub fn game_started(&self, inst: &Instance, started_at: i64) {
        let title = match inst.loader.as_str() {
            "vanilla" => format!("Minecraft {}", inst.game_version),
            loader => format!("Minecraft {} with {}", inst.game_version, loader_name(loader)),
        };
        let mut games = self.games.lock().unwrap();
        games.retain(|g| g.instance_id != inst.id);
        games.push(Game { instance_id: inst.id.clone(), title, started_at, place: Place::Menu });
        drop(games);
        self.poke();
    }

    pub fn game_log(&self, instance_id: &str, line: &str) {
        let Some(place) = place_from_log(line) else { return };
        let mut games = self.games.lock().unwrap();
        let Some(game) = games.iter_mut().find(|g| g.instance_id == instance_id) else { return };
        if game.place != place {
            game.place = place;
            drop(games);
            self.poke();
        }
    }

    pub fn game_exited(&self, instance_id: &str) {
        self.games.lock().unwrap().retain(|g| g.instance_id != instance_id);
        self.poke();
    }

    async fn clear(&self) {
        if let Some(mut client) = self.client.lock().await.take() {
            let _ = client.set_activity(None).await;
        }
    }
}

fn loader_name(loader: &str) -> &str {
    match loader {
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        other => other,
    }
}

pub(crate) fn place_from_log(line: &str) -> Option<Place> {
    let line = line.trim();
    if let Some((_, what)) = line.split_once("Vitra presence: ") {
        return Some(match what.split_once(' ') {
            Some(("server", address)) => Place::Server(address.trim().to_string()),
            None if what == "world" => Place::World,
            None if what == "menu" => Place::Menu,
            _ => Place::Server(String::new()),
        });
    }
    if let Some((_, rest)) = line.split_once("Connecting to ") {
        let (host, port) = rest.rsplit_once(", ")?;
        let port = port.trim().parse::<u16>().ok()?;
        if host.is_empty() || host.contains(' ') {
            return None;
        }
        return Some(Place::Server(if port == DEFAULT_PORT { host.to_string() } else { format!("{host}:{port}") }));
    }
    if line.contains("Starting integrated minecraft server") {
        return Some(Place::World);
    }
    if line.ends_with("Stopping server") {
        return Some(Place::Menu);
    }
    None
}

pub fn start(state: Arc<AppState>) {
    tauri::async_runtime::spawn(run(state));
}

pub async fn shutdown(state: &AppState) {
    let _ = tokio::time::timeout(Duration::from_secs(1), state.presence.clear()).await;
}

#[derive(Default)]
struct ServerInfo {
    name: Option<String>,
    players: Option<(i64, i64)>,
    checked: Option<Instant>,
}

async fn run(state: Arc<AppState>) {
    let launched_at = util::now_millis();
    let version = state.app.package_info().version.to_string();
    let presence = &state.presence;
    let mut shown: Option<Value> = None;
    let mut last_change = Instant::now() - MIN_GAP;
    let mut servers: HashMap<String, ServerInfo> = HashMap::new();
    loop {
        let settings = state.settings();
        let mut wait = Duration::from_secs(600);
        if !settings.discord_presence {
            presence.clear().await;
            shown = None;
        } else {
            let (activity, on_server) = activity(&state, &settings, &version, launched_at, &mut servers).await;
            if on_server {
                wait = SERVER_REFRESH;
            }
            let mut client = presence.client.lock().await;
            if client.is_none() {
                match Client::connect(DISCORD_APP_ID).await {
                    Ok(c) => *client = Some(c),
                    Err(e) => log::debug!("Discord status: {e}"),
                }
                shown = None;
            }
            match client.as_mut() {
                None => wait = RETRY,
                Some(c) if shown.as_ref() != Some(&activity) => {
                    tokio::time::sleep(MIN_GAP.saturating_sub(last_change.elapsed())).await;
                    match c.set_activity(Some(&activity)).await {
                        Ok(()) => {
                            shown = Some(activity);
                            last_change = Instant::now();
                        }
                        Err(e) => {
                            log::debug!("Discord status: {e}");
                            *client = None;
                            wait = RETRY;
                        }
                    }
                }
                Some(_) => {}
            }
        }
        tokio::select! {
            _ = presence.changed.notified() => {}
            _ = tokio::time::sleep(wait) => {}
        }
    }
}

async fn activity(
    state: &AppState,
    settings: &Settings,
    version: &str,
    launched_at: i64,
    servers: &mut HashMap<String, ServerInfo>,
) -> (Value, bool) {
    let game = state.presence.games.lock().unwrap().last().cloned();
    let mut on_server = false;
    let (details, line, since) = match game {
        None => ("In the launcher".to_string(), format!("Vitra v{version}"), launched_at),
        Some(game) => {
            let line = match &game.place {
                Place::Menu => "In the main menu".to_string(),
                Place::World => "In singleplayer".to_string(),
                Place::Server(address) if settings.discord_show_server && !address.is_empty() => {
                    on_server = true;
                    server_line(state, address, servers).await
                }
                Place::Server(_) => "On a server".to_string(),
            };
            (format!("Playing {}", game.title), line, game.started_at)
        }
    };
    let activity = json!({
        "type": 0,
        "details": clip(&details),
        "state": clip(&line),
        "timestamps": { "start": since / 1000 },
        "assets": { "large_image": "vitra", "large_text": format!("Vitra v{version}") },
        "buttons": [{ "label": "Get Vitra", "url": GET_VITRA }],
    });
    (activity, on_server)
}

async fn server_line(state: &AppState, address: &str, servers: &mut HashMap<String, ServerInfo>) -> String {
    let info = servers.entry(address.to_string()).or_default();
    if info.checked.is_none_or(|t| t.elapsed() >= SERVER_REFRESH) {
        info.checked = Some(Instant::now());
        info.name = crate::servers::name_for(state, address);
        info.players = match tokio::time::timeout(Duration::from_secs(6), crate::servers::ping(address)).await {
            Ok(Ok(status)) => Some((status.players_online, status.players_max)),
            _ => None,
        };
    }
    let name = info.name.clone().unwrap_or_else(|| address.to_string());
    match info.players {
        Some((online, _)) if online > 0 => format!("On {name} · {} online", thousands(online)),
        _ => format!("On {name}"),
    }
}

fn thousands(n: i64) -> String {
    let digits = n.abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 { format!("-{out}") } else { out }
}

fn clip(text: &str) -> String {
    let mut s: String = text.chars().take(128).collect();
    while s.chars().count() < 2 {
        s.push(' ');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_places_from_the_log() {
        assert_eq!(place_from_log("Vitra presence: menu"), Some(Place::Menu));
        assert_eq!(place_from_log("Vitra presence: world"), Some(Place::World));
        assert_eq!(place_from_log("Vitra presence: server mc.hypixel.net"), Some(Place::Server("mc.hypixel.net".into())));
        assert_eq!(place_from_log("Vitra presence: realms"), Some(Place::Server(String::new())));
        assert_eq!(place_from_log("Connecting to mc.hypixel.net, 25565"), Some(Place::Server("mc.hypixel.net".into())));
        assert_eq!(place_from_log("Connecting to 10.0.0.2, 25570"), Some(Place::Server("10.0.0.2:25570".into())));
        assert_eq!(place_from_log("Starting integrated minecraft server version 26.3"), Some(Place::World));
        assert_eq!(place_from_log("Stopping server"), Some(Place::Menu));
        assert_eq!(place_from_log("Loaded 124 advancements"), None);
        assert_eq!(place_from_log("Connecting to the Modrinth API"), None);
        assert_eq!(place_from_log("[12:00:01] [Render thread/INFO]: Connecting to play.example.com, 25565"), Some(Place::Server("play.example.com".into())));
        assert_eq!(place_from_log("[12:00:02] [Render thread/INFO] (vitra-cosmetics) Vitra presence: menu"), Some(Place::Menu));
    }

    #[test]
    fn formats_numbers_and_lines() {
        assert_eq!(thousands(16092), "16,092");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_000_000), "1,000,000");
        assert_eq!(clip("x"), "x ");
        assert_eq!(clip(&"a".repeat(200)).chars().count(), 128);
    }
}
