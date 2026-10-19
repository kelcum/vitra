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
//!
//! Fabric 26.3 instances run Vitra's own mod, which reports more through "Vitra moment: {json}"
//! lines (see the mod's `Moments`): every finished advancement with its id (also on servers that
//! don't announce them), the first visit ever to a biome, rare mobs in sight, and where the player
//! stood for each. With the mod there, those lines replace the chat announcements.

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

/// Biomes whose first visit is kept (from the mod): (biome id without "minecraft:", title, description).
const BIOMES: &[(&str, &str, &str)] = &[
    ("mushroom_fields", "Mushroom island", "You set foot on a mushroom island."),
    ("cherry_grove", "Cherry grove", "You walked into a cherry grove."),
    ("ice_spikes", "Ice spikes", "You found the ice spikes."),
    ("badlands", "The badlands", "You reached the badlands."),
    ("eroded_badlands", "Eroded badlands", "You found the eroded badlands."),
    ("bamboo_jungle", "Bamboo jungle", "You pushed into a bamboo jungle."),
    ("mangrove_swamp", "Mangrove swamp", "You waded into a mangrove swamp."),
    ("deep_dark", "The Deep Dark", "You went down into the Deep Dark."),
    ("lush_caves", "Lush caves", "You found lush caves."),
    ("pale_garden", "Pale garden", "You wandered into a pale garden."),
    ("jagged_peaks", "Jagged peaks", "You climbed the jagged peaks."),
    ("flower_forest", "Flower forest", "You found a flower forest."),
    ("warm_ocean", "Warm ocean", "You found a warm ocean."),
    ("crimson_forest", "Crimson forest", "You found a crimson forest."),
    ("warped_forest", "Warped forest", "You found a warped forest."),
    ("soul_sand_valley", "Soul sand valley", "You crossed a soul sand valley."),
    ("basalt_deltas", "Basalt deltas", "You found the basalt deltas."),
];

/// Rare mobs whose first sighting is kept (from the mod): (kind, title, description).
const MOBS: &[(&str, &str, &str)] = &[
    ("minecraft:warden", "The Warden", "You came face to face with the Warden."),
    ("minecraft:elder_guardian", "An elder guardian", "You spotted an elder guardian."),
    ("minecraft:piglin_brute", "A piglin brute", "You ran into a piglin brute."),
    ("minecraft:evoker", "An evoker", "You met an evoker."),
    ("minecraft:illusioner", "An illusioner", "You saw an illusioner, one of the rarest mobs."),
    ("minecraft:ravager", "A ravager", "A ravager charged into view."),
    ("minecraft:allay", "An allay", "You found an allay."),
    ("minecraft:sniffer", "A sniffer", "You met a sniffer."),
    ("minecraft:creaking", "A creaking", "You saw a creaking."),
    ("minecraft:skeleton_horse", "A skeleton horse", "You saw a skeleton horse."),
    ("minecraft:axolotl/blue", "A blue axolotl", "You found a blue axolotl, about one in 1,200."),
    ("minecraft:sheep/pink", "A pink sheep", "You spotted a pink sheep."),
    ("minecraft:panda/brown", "A brown panda", "You found a brown panda."),
    ("minecraft:mooshroom/brown", "A brown mooshroom", "You found a brown mooshroom."),
];

/// Where the player stood (from the mod).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spot {
    /// "minecraft:overworld", "minecraft:the_nether", "minecraft:the_end" or a modded dimension.
    pub dimension: String,
    pub biome: Option<String>,
    /// The biome's name in the game's language.
    pub biome_name: Option<String>,
    pub x: i64,
    pub y: i64,
    pub z: i64,
}

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
    /// "treasure", "nether", "end", "boss", "milestone", "adventure", "challenge", "advancement",
    /// "biome" or "mob".
    pub category: String,
    pub title: String,
    pub description: String,
    /// What the game calls it, in the game's language: the advancement ("Diamonds!"), biome or mob;
    /// and its id when known ("story.mine_diamond", "minecraft:cherry_grove", "minecraft:warden").
    pub advancement: String,
    pub advancement_id: Option<String>,
    /// Where it happened, in Fabric 26.3 instances.
    #[serde(default)]
    pub spot: Option<Spot>,
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
    /// Advancements (by id, else shown title) already kept this session.
    seen: HashSet<String>,
    /// Vitra's mod is reporting moments, so chat announcements are left to it.
    mod_reports: bool,
}

/// A moment about to become a memory.
struct Found {
    category: String,
    title: String,
    description: String,
    advancement: String,
    advancement_id: Option<String>,
    spot: Option<Spot>,
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
        Self { state, game, patterns, place: Place::Menu, seen: HashSet::new(), mod_reports: false }
    }

    /// One line of the game's log.
    pub fn line(&mut self, text: &str) {
        if let Some((_, json)) = text.split_once("Vitra moment: ") {
            if let Ok(report) = serde_json::from_str::<serde_json::Value>(json.trim()) {
                self.reported(&report);
            }
            return;
        }
        if text.contains("Vitra moments: ready") {
            self.mod_reports = true;
            return;
        }
        if let Some(place) = place_from_log(text) {
            self.place = place;
            return;
        }
        if self.mod_reports {
            return;
        }
        let Some((_, chat)) = text.split_once("[CHAT] ") else { return };
        let Some(patterns) = self.patterns.get() else { return };
        let Some((player, shown, frame)) = patterns.read(chat.trim_end()) else { return };
        if !is_player(player, &self.game.player) {
            return;
        }
        let id = patterns.ids.get(shown).cloned();
        let description = id.as_ref().and_then(|i| patterns.descriptions.get(i)).cloned();
        self.advancement(id, frame, shown.to_string(), description, None);
    }

    fn advancement(&mut self, id: Option<String>, frame: Frame, shown: String, description: Option<String>, spot: Option<Spot>) {
        let settings = self.state.settings();
        if !settings.memories || !self.seen.insert(id.clone().unwrap_or_else(|| shown.clone())) {
            return;
        }
        let Some((category, title, description)) =
            moment(id.as_deref(), frame, &shown, description.as_deref(), settings.memories_every_advancement)
        else {
            return;
        };
        self.keep(Found { category, title, description, advancement: shown, advancement_id: id, spot });
    }

    /// A "Vitra moment" line from the mod.
    fn reported(&mut self, r: &serde_json::Value) {
        let settings = self.state.settings();
        match read_report(r, settings.memories_every_advancement) {
            Some(Report::Advancement { id, frame, shown, description, spot }) => self.advancement(Some(id), frame, shown, description, spot),
            Some(Report::Biome(found)) if settings.memories => self.keep(found),
            // The mod reports each kind once per session; whether it's the first time in this world
            // is kept here.
            Some(Report::Mob(found)) if settings.memories => {
                if let Some(kind) = &found.advancement_id
                    && first_sighting(&self.state, &self.world_key(), kind)
                {
                    self.keep(found);
                }
            }
            _ => {}
        }
    }

    fn world_and_server(&self) -> (Option<String>, Option<String>) {
        match &self.place {
            Place::World => (open_world(&self.game.game_dir, self.game.started_at), None),
            Place::Server(address) if !address.is_empty() => {
                (None, Some(crate::servers::name_for(&self.state, address).unwrap_or_else(|| address.clone())))
            }
            Place::Server(_) => (None, Some("Realms".to_string())),
            Place::Menu => (None, None),
        }
    }

    /// Which world sightings count for: the singleplayer save, or the server.
    fn world_key(&self) -> String {
        match &self.place {
            Place::Server(address) => format!("server:{}", address.to_lowercase()),
            _ => match open_world(&self.game.game_dir, self.game.started_at) {
                Some(world) => format!("world:{}/{world}", self.game.instance.id),
                None => format!("instance:{}", self.game.instance.id),
            },
        }
    }

    /// Takes the picture a moment later and saves the memory.
    fn keep(&self, found: Found) {
        let (world, server) = self.world_and_server();
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
            category: found.category,
            title: found.title,
            description: found.description,
            advancement: found.advancement,
            advancement_id: found.advancement_id,
            spot: found.spot,
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

/// What a "Vitra moment" line is about.
enum Report {
    Advancement { id: String, frame: Frame, shown: String, description: Option<String>, spot: Option<Spot> },
    Biome(Found),
    Mob(Found),
}

/// Reads a "Vitra moment" line. Biomes and mobs outside the kept lists give `None` (biomes are all
/// kept with `every`).
fn read_report(r: &serde_json::Value, every: bool) -> Option<Report> {
    let text = |k: &str| r[k].as_str().map(str::to_string);
    let id = text("id")?;
    let spot = r["dimension"].as_str().map(|dimension| Spot {
        dimension: dimension.to_string(),
        biome: text("biome"),
        biome_name: text("biomeName"),
        x: r["x"].as_i64().unwrap_or_default(),
        y: r["y"].as_i64().unwrap_or_default(),
        z: r["z"].as_i64().unwrap_or_default(),
    });
    match r["kind"].as_str()? {
        "advancement" => Some(Report::Advancement {
            frame: match r["frame"].as_str() {
                Some("challenge") => Frame::Challenge,
                Some("goal") => Frame::Goal,
                _ => Frame::Task,
            },
            shown: text("title").unwrap_or_else(|| id.clone()),
            description: text("description"),
            id: advancement_key(&id),
            spot,
        }),
        "biome" => {
            let name = text("name").unwrap_or_else(|| id.clone());
            let (title, description) = match BIOMES.iter().find(|b| id.strip_prefix("minecraft:") == Some(b.0)) {
                Some((_, title, description)) => (title.to_string(), description.to_string()),
                None if every => (name.clone(), format!("Your first time in {name}.")),
                None => return None,
            };
            Some(Report::Biome(Found { category: "biome".into(), title, description, advancement: name, advancement_id: Some(id), spot }))
        }
        "mob" => {
            let (_, title, description) = MOBS.iter().find(|m| m.0 == id)?;
            Some(Report::Mob(Found {
                category: "mob".into(),
                title: title.to_string(),
                description: description.to_string(),
                advancement: text("name").unwrap_or_else(|| title.to_string()),
                advancement_id: Some(id),
                spot,
            }))
        }
        _ => None,
    }
}

/// "minecraft:story/mine_diamond" → "story.mine_diamond", the form the translations use; other
/// namespaces keep theirs ("create:root").
fn advancement_key(id: &str) -> String {
    match id.strip_prefix("minecraft:") {
        Some(path) => path.replace('/', "."),
        None => id.replace('/', "."),
    }
}

/// Notes that this kind of mob was seen in this world; true the first time.
fn first_sighting(state: &AppState, world: &str, kind: &str) -> bool {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir(state).join("sightings.json");
    let mut all: HashMap<String, Vec<String>> = util::read_json(&path).unwrap_or_default();
    let seen = all.entry(world.to_string()).or_default();
    if seen.iter().any(|k| k == kind) {
        return false;
    }
    seen.push(kind.to_string());
    if let Err(e) = util::write_json(&path, &all) {
        log::warn!("Couldn't note a sighting: {e}");
    }
    true
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
        .filter(|e| e.path().extension().is_some_and(|x| x == "json") && e.file_name() != "sightings.json")
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
    fn reads_the_mods_reports() {
        let line = r#"{"kind":"advancement","id":"minecraft:story/mine_diamond","frame":"task","title":"Diamonds!","description":"Acquire diamonds","dimension":"minecraft:overworld","biome":"minecraft:dripstone_caves","biomeName":"Dripstone Caves","x":12,"y":-58,"z":-340}"#;
        let Some(Report::Advancement { id, frame, shown, spot, .. }) = read_report(&serde_json::from_str(line).unwrap(), false) else {
            panic!("not an advancement")
        };
        assert_eq!((id.as_str(), frame, shown.as_str()), ("story.mine_diamond", Frame::Task, "Diamonds!"));
        let spot = spot.unwrap();
        assert_eq!((spot.x, spot.y, spot.z, spot.biome_name.as_deref()), (12, -58, -340, Some("Dripstone Caves")));

        let biome = |id: &str, every| read_report(&serde_json::json!({ "kind": "biome", "id": id, "name": "Somewhere" }), every);
        let Some(Report::Biome(cherry)) = biome("minecraft:cherry_grove", false) else { panic!("cherry grove") };
        assert_eq!((cherry.title.as_str(), cherry.spot), ("Cherry grove", None));
        assert!(biome("minecraft:plains", false).is_none());
        let Some(Report::Biome(plains)) = biome("minecraft:plains", true) else { panic!("plains") };
        assert_eq!(plains.description, "Your first time in Somewhere.");

        let mob = |id: &str| read_report(&serde_json::json!({ "kind": "mob", "id": id, "name": "Axolotl" }), true);
        let Some(Report::Mob(blue)) = mob("minecraft:axolotl/blue") else { panic!("blue axolotl") };
        assert_eq!((blue.title.as_str(), blue.advancement.as_str()), ("A blue axolotl", "Axolotl"));
        assert!(mob("minecraft:cow").is_none());
        assert!(read_report(&serde_json::json!({ "kind": "weather", "id": "rain" }), true).is_none());
        assert_eq!(advancement_key("minecraft:nether/find_fortress"), "nether.find_fortress");
        assert_eq!(advancement_key("create:root"), "create:root");
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
