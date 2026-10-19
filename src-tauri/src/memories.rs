//! Memories: Vitra keeps a picture of the big first-time moments of a playthrough (the first
//! diamonds, the first trip to the Nether, beating the Ender Dragon…) and shows them as a timeline.
//!
//! It needs no mod, so it works with every Minecraft version and loader since advancements exist
//! (1.12). When the player earns an advancement the game writes the chat announcement to its log,
//! "k3 has made the advancement [Diamonds!]", in the player's language. Vitra reads the
//! announcement formats and advancement titles from the game's own translations, so it recognises
//! them in any language, then takes a picture of the game window (see `capture`) a moment later,
//! with the advancement toast on screen. Nothing runs inside the game.
//!
//! Only meaningful moments are kept: a hand-picked list of milestones, every challenge, and
//! optionally every other advancement. Memories live in the game data folder as `<id>.json` with
//! `<id>.jpg` and a small `<id>.thumb.jpg`.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::bail;
use crate::capture;
use crate::error::{Error, Result};
use crate::instances::Instance;
use crate::presence::{place_from_log, Place};
use crate::state::AppState;
use crate::util;

/// Wait this long after the announcement before taking the picture, so the advancement toast has
/// slid in.
const CAPTURE_DELAY: Duration = Duration::from_millis(900);
/// Longest side of the saved picture and of its thumbnail.
const FULL_SIDE: u32 = 2560;
const THUMB_SIDE: u32 = 640;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    Task,
    Goal,
    Challenge,
}

/// Milestones that are always kept: (advancement id, category, title, description).
const MOMENTS: &[(&str, &str, &str, &str)] = &[
    ("story.mine_diamond", "treasure", "First diamonds", "You found your first diamonds."),
    ("story.shiny_gear", "treasure", "Diamond armor", "You suited up in diamond armor for the first time."),
    ("nether.obtain_ancient_debris", "treasure", "Ancient debris", "You dug up your first ancient debris."),
    ("nether.netherite_armor", "treasure", "Full netherite", "You're wearing a full set of netherite armor."),
    ("story.enter_the_nether", "nether", "Into the Nether", "Your first steps in the Nether."),
    ("nether.find_fortress", "nether", "A Nether fortress", "You found your way into a Nether fortress."),
    ("nether.find_bastion", "nether", "A bastion", "You stepped into a bastion remnant."),
    ("story.follow_ender_eye", "end", "The stronghold", "You followed an Eye of Ender to a stronghold."),
    ("story.enter_the_end", "end", "Into the End", "You jumped through the End portal."),
    ("end.find_end_city", "end", "An End city", "You reached an End city."),
    ("end.elytra", "end", "Wings", "You found a pair of elytra."),
    ("end.dragon_egg", "end", "The dragon egg", "You took the dragon egg."),
    ("end.kill_dragon", "boss", "The Ender Dragon falls", "You defeated the Ender Dragon and freed the End."),
    ("end.respawn_dragon", "boss", "The dragon returns", "You brought the Ender Dragon back."),
    ("nether.summon_wither", "boss", "The Wither", "You summoned the Wither."),
    ("adventure.sleep_in_bed", "milestone", "First night's sleep", "You slept through your first night."),
    ("nether.create_beacon", "milestone", "First beacon", "You built and lit a beacon."),
    ("nether.create_full_beacon", "milestone", "Full-power beacon", "Your beacon runs at full power."),
    ("husbandry.tame_an_animal", "adventure", "A new friend", "You tamed your first animal."),
    ("adventure.trade", "adventure", "First trade", "You traded with a villager."),
    ("story.cure_zombie_villager", "adventure", "Zombie doctor", "You cured a zombie villager."),
    ("adventure.hero_of_the_village", "adventure", "Hero of the Village", "You defended a village from a raid."),
    ("adventure.totem_of_undying", "adventure", "Cheated death", "A totem of undying saved your life."),
    ("adventure.minecraft_trials_edition", "adventure", "Trial chambers", "You stepped into the trial chambers."),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    /// When it happened (ms since the epoch).
    pub at: i64,
    pub instance_id: String,
    pub instance_name: String,
    pub game_version: String,
    pub loader: String,
    /// The singleplayer world's folder name.
    pub world: Option<String>,
    /// The server's name from the server list, else its address.
    pub server: Option<String>,
    /// "treasure", "nether", "end", "boss", "milestone", "adventure", "challenge" or "advancement".
    pub category: String,
    pub title: String,
    pub description: String,
    /// The advancement as the game showed it ("Diamonds!") and its id, when known ("story.mine_diamond").
    pub advancement: String,
    pub advancement_id: Option<String>,
    pub favorite: bool,
    /// Filled in when listing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
}

// ---------------------------------------------------------------- the game's translations

/// "%s has made the advancement %s" split around its two arguments.
#[derive(Debug, Clone)]
struct Template {
    before: String,
    between: String,
    after: String,
    /// The advancement comes first in a few languages ("%2$s … %1$s").
    title_first: bool,
}

impl Template {
    fn parse(format: &str) -> Option<Self> {
        let mut parts = vec![String::new()];
        let mut args = Vec::new();
        let mut rest = format;
        let mut next = 1;
        while let Some(i) = rest.find('%') {
            parts.last_mut()?.push_str(&rest[..i]);
            let tail = &rest[i + 1..];
            if let Some(t) = tail.strip_prefix('%') {
                parts.last_mut()?.push('%');
                rest = t;
            } else if let Some(t) = tail.strip_prefix('s') {
                args.push(next);
                next += 1;
                parts.push(String::new());
                rest = t;
            } else {
                // "%1$s"
                let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
                let t = tail[digits.len()..].strip_prefix("$s")?;
                args.push(digits.parse::<u32>().ok()?);
                parts.push(String::new());
                rest = t;
            }
        }
        parts.last_mut()?.push_str(rest);
        if args.len() != 2 || parts.len() != 3 {
            return None;
        }
        Some(Self {
            before: parts[0].clone(),
            between: parts[1].clone(),
            after: parts[2].clone(),
            title_first: args[0] == 2,
        })
    }

    /// The player and the advancement title (without its brackets) when `text` is this announcement.
    fn read<'a>(&self, text: &'a str) -> Option<(&'a str, &'a str)> {
        let rest = text.strip_prefix(self.before.as_str())?.strip_suffix(self.after.as_str())?;
        for (i, _) in rest.match_indices(self.between.as_str()) {
            let (first, second) = (&rest[..i], &rest[i + self.between.len()..]);
            let (player, title) = if self.title_first { (second, first) } else { (first, second) };
            if let Some(title) = title.strip_prefix('[').and_then(|t| t.strip_suffix(']'))
                && !player.trim().is_empty()
                && !title.is_empty()
            {
                return Some((player.trim(), title));
            }
        }
        None
    }
}

/// What a game's announcements look like, and the advancements it knows by title.
#[derive(Debug, Default)]
struct Patterns {
    templates: Vec<(Template, Frame)>,
    /// Shown title → advancement id ("Diamonds!" → "story.mine_diamond").
    ids: HashMap<String, String>,
    /// Advancement id → description, in the game's language.
    descriptions: HashMap<String, String>,
}

impl Patterns {
    fn add(&mut self, lang: &HashMap<String, String>) {
        for (key, frame) in [
            ("chat.type.advancement.task", Frame::Task),
            ("chat.type.advancement.goal", Frame::Goal),
            ("chat.type.advancement.challenge", Frame::Challenge),
        ] {
            if let Some(t) = lang.get(key).and_then(|f| Template::parse(f)) {
                self.templates.push((t, frame));
            }
        }
        for (key, value) in lang {
            let Some(rest) = key.strip_prefix("advancements.") else { continue };
            if let Some(id) = rest.strip_suffix(".title") {
                self.ids.entry(value.clone()).or_insert_with(|| id.to_string());
            } else if let Some(id) = rest.strip_suffix(".description") {
                self.descriptions.entry(id.to_string()).or_insert_with(|| value.clone());
            }
        }
    }

    /// Minecraft's English announcements, for when the game's own files can't be read.
    fn english() -> Self {
        let lang: HashMap<String, String> = [
            ("chat.type.advancement.task", "%s has made the advancement %s"),
            ("chat.type.advancement.goal", "%s has reached the goal %s"),
            ("chat.type.advancement.challenge", "%s has completed the challenge %s"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let mut p = Self::default();
        p.add(&lang);
        p
    }

    /// The announcement in a chat line: (player, shown title, frame).
    fn read<'a>(&self, text: &'a str) -> Option<(&'a str, &'a str, Frame)> {
        self.templates.iter().find_map(|(t, frame)| t.read(text).map(|(p, a)| (p, a, *frame)))
    }
}

fn parse_lang(bytes: &[u8], json: bool) -> HashMap<String, String> {
    if json {
        return serde_json::from_slice(bytes).unwrap_or_default();
    }
    // 1.12: "key=value" lines.
    String::from_utf8_lossy(bytes)
        .lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| l.split_once('=').map(|(k, v)| (k.trim().to_string(), v.to_string())))
        .collect()
}

/// English comes with the game jar, other languages from the asset index.
fn read_lang(client_jar: &Path, assets: &Path, index_id: &str, code: &str) -> Option<HashMap<String, String>> {
    if code == "en_us" {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(client_jar).ok()?).ok()?;
        for (name, json) in [("assets/minecraft/lang/en_us.json", true), ("assets/minecraft/lang/en_us.lang", false)] {
            if let Ok(mut f) = zip.by_name(name) {
                let mut bytes = Vec::new();
                f.read_to_end(&mut bytes).ok()?;
                return Some(parse_lang(&bytes, json));
            }
        }
        return None;
    }
    let index: serde_json::Value = util::read_json(&assets.join("indexes").join(format!("{index_id}.json"))).ok()?;
    for (ext, json) in [("json", true), ("lang", false)] {
        let Some(hash) = index["objects"][format!("minecraft/lang/{code}.{ext}")]["hash"].as_str() else { continue };
        let bytes = std::fs::read(assets.join("objects").join(hash.get(..2)?).join(hash)).ok()?;
        return Some(parse_lang(&bytes, json));
    }
    None
}

/// The language picked in the game's options ("lang:de_de").
fn game_language(game_dir: &Path) -> String {
    std::fs::read_to_string(game_dir.join("options.txt"))
        .ok()
        .and_then(|o| o.lines().find_map(|l| l.strip_prefix("lang:").map(|v| v.trim().to_lowercase())))
        .filter(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or_else(|| "en_us".into())
}

fn load_patterns(client_jar: &Path, assets: &Path, index_id: &str, game_dir: &Path) -> Patterns {
    let mut p = Patterns::default();
    let language = game_language(game_dir);
    if language != "en_us"
        && let Some(lang) = read_lang(client_jar, assets, index_id, &language)
    {
        p.add(&lang);
    }
    match read_lang(client_jar, assets, index_id, "en_us") {
        Some(lang) => p.add(&lang),
        None => {
            let english = Patterns::english();
            p.templates.extend(english.templates);
        }
    }
    p
}

// ---------------------------------------------------------------- which moments count

/// Whether the announced player is this player. Servers may put a rank or team in front of the
/// name ("[VIP] k3").
fn is_player(shown: &str, name: &str) -> bool {
    match shown.strip_suffix(name) {
        Some(before) => before.is_empty() || !before.ends_with(|c: char| c.is_alphanumeric() || c == '_'),
        None => false,
    }
}

/// (category, title, description) of a memory for this advancement, or `None` when it isn't one.
fn moment(id: Option<&str>, frame: Frame, shown: &str, description: Option<&str>, every: bool) -> Option<(String, String, String)> {
    if let Some((_, category, title, text)) = id.and_then(|id| MOMENTS.iter().find(|m| m.0 == id)) {
        return Some((category.to_string(), title.to_string(), text.to_string()));
    }
    let description = description.unwrap_or_default().to_string();
    match frame {
        Frame::Challenge => Some(("challenge".into(), shown.to_string(), description)),
        _ if every => Some(("advancement".into(), shown.to_string(), description)),
        _ => None,
    }
}

// ---------------------------------------------------------------- watching a game

/// What a running game is, for the memories it makes.
pub struct GameInfo {
    pub instance: Instance,
    pub game_dir: PathBuf,
    pub client_jar: PathBuf,
    pub asset_index: String,
    pub player: String,
    pub pid: u32,
    pub started_at: i64,
}

/// Follows one game's log and saves its memories.
pub struct Watcher {
    state: Arc<AppState>,
    game: Arc<GameInfo>,
    patterns: Arc<OnceLock<Patterns>>,
    place: Place,
    seen: HashSet<String>,
}

impl Watcher {
    pub fn new(state: Arc<AppState>, game: GameInfo) -> Self {
        let game = Arc::new(game);
        let patterns = Arc::new(OnceLock::new());
        let (g, p, assets) = (game.clone(), patterns.clone(), state.assets_dir());
        // Reading the translations takes a moment; the log keeps flowing meanwhile.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = p.set(load_patterns(&g.client_jar, &assets, &g.asset_index, &g.game_dir));
        });
        Self { state, game, patterns, place: Place::Menu, seen: HashSet::new() }
    }

    /// One line of the game's log.
    pub fn line(&mut self, text: &str) {
        if let Some(place) = place_from_log(text) {
            self.place = place;
            return;
        }
        let Some((_, chat)) = text.split_once("[CHAT] ") else { return };
        let Some(patterns) = self.patterns.get() else { return };
        let Some((player, shown, frame)) = patterns.read(chat.trim_end()) else { return };
        if !is_player(player, &self.game.player) {
            return;
        }
        let settings = self.state.settings();
        if !settings.memories || !self.seen.insert(shown.to_string()) {
            return;
        }
        let id = patterns.ids.get(shown).cloned();
        let description = id.as_ref().and_then(|i| patterns.descriptions.get(i)).map(String::as_str);
        let Some((category, title, description)) = moment(id.as_deref(), frame, shown, description, settings.memories_every_advancement) else {
            return;
        };
        let (world, server) = match &self.place {
            Place::World => (open_world(&self.game.game_dir, self.game.started_at), None),
            Place::Server(address) if !address.is_empty() => {
                (None, Some(crate::servers::name_for(&self.state, address).unwrap_or_else(|| address.clone())))
            }
            Place::Server(_) => (None, Some("Realms".to_string())),
            Place::Menu => (None, None),
        };
        let now = chrono::Local::now();
        let memory = Memory {
            id: format!("{}-{}", now.format("%Y%m%d-%H%M%S"), &uuid::Uuid::new_v4().simple().to_string()[..6]),
            at: now.timestamp_millis(),
            instance_id: self.game.instance.id.clone(),
            instance_name: self.game.instance.name.clone(),
            game_version: self.game.instance.game_version.clone(),
            loader: self.game.instance.loader.clone(),
            world,
            server,
            category,
            title,
            description,
            advancement: shown.to_string(),
            advancement_id: id,
            favorite: false,
            image: None,
            thumb: None,
        };
        let (state, pid) = (self.state.clone(), self.game.pid);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(CAPTURE_DELAY).await;
            let st = state.clone();
            let saved = tokio::task::spawn_blocking(move || save(&st, memory, capture::window_of_process(pid))).await;
            match saved {
                Ok(Ok(memory)) => {
                    let _ = state.app.emit("memory://added", memory);
                }
                Ok(Err(e)) => log::warn!("Couldn't save a memory: {e}"),
                Err(e) => log::warn!("Couldn't save a memory: {e}"),
            }
        });
    }
}

/// The world a singleplayer game has open: the one whose lock file was touched last since the game
/// started.
fn open_world(game_dir: &Path, since: i64) -> Option<String> {
    let mut best: Option<(i64, String)> = None;
    for e in std::fs::read_dir(game_dir.join("saves")).ok()?.flatten() {
        let Ok(modified) = e.path().join("session.lock").metadata().and_then(|m| m.modified()) else { continue };
        let ms = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
        if ms >= since - 5_000 && best.as_ref().is_none_or(|(t, _)| ms > *t) {
            best = Some((ms, e.file_name().to_string_lossy().to_string()));
        }
    }
    best.map(|(_, name)| name)
}

// ---------------------------------------------------------------- storage

fn dir(state: &AppState) -> PathBuf {
    state.data_dir().join("memories")
}

fn check_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        bail!("That memory doesn't exist.");
    }
    Ok(())
}

fn with_files(dir: &Path, mut memory: Memory) -> Memory {
    let image = dir.join(format!("{}.jpg", memory.id));
    let thumb = dir.join(format!("{}.thumb.jpg", memory.id));
    memory.image = image.exists().then(|| image.to_string_lossy().to_string());
    memory.thumb = thumb.exists().then(|| thumb.to_string_lossy().to_string()).or_else(|| memory.image.clone());
    memory
}

fn write(dir: &Path, memory: &Memory) -> Result<()> {
    let mut plain = memory.clone();
    plain.image = None;
    plain.thumb = None;
    util::write_json(&dir.join(format!("{}.json", memory.id)), &plain)
}

fn save(state: &AppState, memory: Memory, frame: Option<capture::Frame>) -> Result<Memory> {
    let dir = dir(state);
    std::fs::create_dir_all(&dir)?;
    if let Some(frame) = frame {
        let full = capture::shrink(&frame, FULL_SIDE);
        if let Some(bytes) = capture::jpeg(&full, 90) {
            util::write_atomic(&dir.join(format!("{}.jpg", memory.id)), &bytes)?;
        }
        if let Some(bytes) = capture::jpeg(&capture::shrink(&full, THUMB_SIDE), 82) {
            util::write_atomic(&dir.join(format!("{}.thumb.jpg", memory.id)), &bytes)?;
        }
    }
    write(&dir, &memory)?;
    Ok(with_files(&dir, memory))
}

fn load(state: &AppState, id: &str) -> Result<Memory> {
    check_id(id)?;
    let dir = dir(state);
    let memory: Memory = util::read_json(&dir.join(format!("{id}.json"))).map_err(|_| Error::Msg("That memory doesn't exist.".into()))?;
    Ok(with_files(&dir, memory))
}

#[tauri::command]
pub fn list_memories(state: State<'_, Arc<AppState>>) -> Vec<Memory> {
    let dir = dir(&state);
    let mut out: Vec<Memory> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| util::read_json::<Memory>(&e.path()).ok())
        .map(|m| with_files(&dir, m))
        .collect();
    out.sort_by_key(|m| std::cmp::Reverse(m.at));
    out
}

#[tauri::command]
pub fn set_memory_favorite(state: State<'_, Arc<AppState>>, id: String, favorite: bool) -> Result<Memory> {
    let mut memory = load(&state, &id)?;
    memory.favorite = favorite;
    write(&dir(&state), &memory)?;
    Ok(memory)
}

#[tauri::command]
pub fn delete_memory(state: State<'_, Arc<AppState>>, id: String) -> Result<()> {
    check_id(&id)?;
    let dir = dir(&state);
    for name in [format!("{id}.jpg"), format!("{id}.thumb.jpg"), format!("{id}.json")] {
        match std::fs::remove_file(dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(())
}

/// Shows the memory's picture in the file manager.
#[tauri::command]
pub fn reveal_memory(state: State<'_, Arc<AppState>>, id: String) -> Result<()> {
    let memory = load(&state, &id)?;
    let path = memory.image.map(PathBuf::from).unwrap_or_else(|| dir(&state).join(format!("{id}.json")));
    state.app.opener().reveal_item_in_dir(path).map_err(|e| Error::Msg(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn english() -> Patterns {
        Patterns::english()
    }

    #[test]
    fn reads_announcements() {
        let p = english();
        assert_eq!(p.read("k3 has made the advancement [Diamonds!]"), Some(("k3", "Diamonds!", Frame::Task)));
        assert_eq!(p.read("k3 has completed the challenge [Hot Tourist Destinations]"), Some(("k3", "Hot Tourist Destinations", Frame::Challenge)));
        assert_eq!(p.read("[VIP] k3 has reached the goal [The End?]"), Some(("[VIP] k3", "The End?", Frame::Goal)));
        // Titles may contain the connecting words themselves.
        assert_eq!(p.read("Steve has made the advancement [Who has made the advancement]"), Some(("Steve", "Who has made the advancement", Frame::Task)));
        assert_eq!(p.read("<k3> has made the advancement [lol]"), Some(("<k3>", "lol", Frame::Task)));
        assert_eq!(p.read("k3 joined the game"), None);
        assert_eq!(p.read("k3 has made the advancement Diamonds!"), None);
    }

    #[test]
    fn reads_other_languages() {
        let mut p = Patterns::default();
        let lang: HashMap<String, String> = [
            ("chat.type.advancement.task", "%s hat den Fortschritt %s erzielt"),
            ("chat.type.advancement.challenge", "%2$s : %1$s"),
            ("advancements.story.mine_diamond.title", "Diamanten!"),
            ("advancements.story.mine_diamond.description", "Finde Diamanten"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        p.add(&lang);
        assert_eq!(p.read("k3 hat den Fortschritt [Diamanten!] erzielt"), Some(("k3", "Diamanten!", Frame::Task)));
        assert_eq!(p.read("[Défi] : k3"), Some(("k3", "Défi", Frame::Challenge)));
        assert_eq!(p.ids.get("Diamanten!").map(String::as_str), Some("story.mine_diamond"));
        assert_eq!(p.descriptions.get("story.mine_diamond").map(String::as_str), Some("Finde Diamanten"));
        // A 1.12 .lang file.
        let old = parse_lang(b"# comment\nchat.type.advancement.task=%s has made the advancement %s\nadvancements.end.root.title=The End\n", false);
        assert_eq!(old.get("advancements.end.root.title").map(String::as_str), Some("The End"));
        assert!(Template::parse("no arguments").is_none());
        assert!(Template::parse("%s and %s and %s").is_none());
    }

    #[test]
    fn matches_only_this_player() {
        assert!(is_player("k3", "k3"));
        assert!(is_player("[VIP] k3", "k3"));
        assert!(is_player("[Owner]k3", "k3"));
        assert!(!is_player("xk3", "k3"));
        assert!(!is_player("k3_alt", "k3"));
        assert!(!is_player("Steve", "k3"));
    }

    #[test]
    fn keeps_only_moments_that_matter() {
        let diamonds = moment(Some("story.mine_diamond"), Frame::Task, "Diamonds!", None, false).unwrap();
        assert_eq!((diamonds.0.as_str(), diamonds.1.as_str()), ("treasure", "First diamonds"));
        assert!(moment(Some("story.mine_stone"), Frame::Task, "Stone Age", None, false).is_none());
        let stone = moment(Some("story.mine_stone"), Frame::Task, "Stone Age", Some("Mine Stone"), true).unwrap();
        assert_eq!((stone.0.as_str(), stone.1.as_str(), stone.2.as_str()), ("advancement", "Stone Age", "Mine Stone"));
        // Every challenge, modded ones too.
        assert_eq!(moment(None, Frame::Challenge, "Sky Pirate", None, false).unwrap().0, "challenge");
        assert!(moment(None, Frame::Goal, "Some mod goal", None, false).is_none());
    }

    #[test]
    fn memory_ids_are_plain() {
        assert!(check_id("20261019-061530-ab12cd").is_ok());
        assert!(check_id("../settings").is_err());
        assert!(check_id("").is_err());
        assert!(check_id("a\\b").is_err());
    }

    #[test]
    fn reads_the_game_language() {
        let dir = std::env::temp_dir().join(format!("vitra-lang-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(game_language(&dir), "en_us");
        std::fs::write(dir.join("options.txt"), "version:3955\nlang:de_de\nfov:0.0\n").unwrap();
        assert_eq!(game_language(&dir), "de_de");
        std::fs::write(dir.join("options.txt"), "lang:../../x\n").unwrap();
        assert_eq!(game_language(&dir), "en_us");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
