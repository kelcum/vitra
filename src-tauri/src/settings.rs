use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

use crate::error::Result;
use crate::state::AppState;
use crate::util;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Background {
    /// "liquid" (heavily blurred latest screenshot or panorama), "aurora"
    /// (built-in art), "panorama" (title panorama from an installed version),
    /// "screenshot" (latest in-game screenshot) or "image" (custom file).
    pub kind: String,
    pub value: Option<String>,
    pub dim: f32,
}

impl Default for Background {
    fn default() -> Self {
        Self { kind: "liquid".into(), value: None, dim: 0.3 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Notifications {
    pub downloads: bool,
    pub crashes: bool,
    pub game_updates: bool,
}

impl Default for Notifications {
    fn default() -> Self {
        Self { downloads: true, crashes: true, game_updates: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    // Appearance
    pub theme: String,
    pub accent: String,
    pub glass_intensity: f32,
    pub blur: u32,
    pub transparency: f32,
    pub background: Background,
    pub motion: String,
    pub ambient_effects: bool,
    pub ui_scale: f32,

    // Behaviour
    pub startup_page: String,
    pub on_game_launch: String,
    pub reopen_on_exit: bool,
    pub show_news: bool,
    /// Look for a newer Vitra on start and every few hours.
    pub check_updates: bool,
    pub notifications: Notifications,
    /// Vitra badges and capes in Fabric instances (adds the Vitra Cosmetics mod at launch).
    pub cosmetics: bool,
    /// Show Vitra and what you're playing on your Discord profile.
    pub discord_presence: bool,
    /// Name the server you're on in that status.
    pub discord_show_server: bool,
    /// Keep a picture of big first-time moments (Memories).
    pub memories: bool,
    /// Also keep every other advancement, not just the milestones and challenges.
    pub memories_every_advancement: bool,

    // Game defaults
    pub game_data_dir: Option<String>,
    pub download_concurrency: u32,
    pub default_memory_mb: u32,
    pub default_jvm_args: String,
    pub default_version: Option<String>,
    pub default_loader: String,

    // Accounts
    pub msa_client_id: Option<String>,
    pub active_account: Option<String>,

    // Session
    pub selected_instance: Option<String>,
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            // "auto" = picked from the background.
            accent: "auto".into(),
            glass_intensity: 0.7,
            blur: 28,
            transparency: 0.64,
            background: Background::default(),
            motion: "full".into(),
            ambient_effects: true,
            ui_scale: 1.0,
            startup_page: "home".into(),
            on_game_launch: "minimize".into(),
            reopen_on_exit: true,
            show_news: true,
            check_updates: true,
            notifications: Notifications::default(),
            cosmetics: true,
            discord_presence: true,
            discord_show_server: true,
            memories: true,
            memories_every_advancement: false,
            game_data_dir: None,
            download_concurrency: 16,
            default_memory_mb: recommended_memory_mb(false),
            default_jvm_args: String::new(),
            default_version: None,
            default_loader: "fabric".into(),
            msa_client_id: None,
            active_account: None,
            selected_instance: None,
            onboarded: false,
        }
    }
}

impl Settings {
    pub fn load(path: &PathBuf) -> Self {
        match util::read_json::<Settings>(path) {
            Ok(s) => s.sanitized(),
            Err(_) => Settings::default(),
        }
    }

    /// Clamp values so a hand-edited or corrupted file can never make the UI
    /// unreadable or the downloader misbehave.
    pub fn sanitized(mut self) -> Self {
        self.glass_intensity = self.glass_intensity.clamp(0.0, 1.0);
        self.blur = self.blur.min(60);
        self.transparency = self.transparency.clamp(0.15, 0.95);
        self.background.dim = self.background.dim.clamp(0.0, 0.9);
        self.ui_scale = self.ui_scale.clamp(0.8, 1.4);
        self.download_concurrency = self.download_concurrency.clamp(1, 64);
        let total = total_memory_mb();
        self.default_memory_mb = self.default_memory_mb.clamp(512, total.saturating_sub(1024).max(1024));
        if !matches!(self.theme.as_str(), "dark" | "light" | "system") {
            self.theme = "dark".into();
        }
        if !matches!(self.motion.as_str(), "full" | "reduced" | "off") {
            self.motion = "full".into();
        }
        if !matches!(self.on_game_launch.as_str(), "keep" | "minimize" | "hide") {
            self.on_game_launch = "minimize".into();
        }
        self
    }
}

pub fn total_memory_mb() -> u32 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    (sys.total_memory() / 1024 / 1024) as u32
}

/// A sensible default heap size. Never more than half of physical memory, and
/// never "all of it" — Minecraft gets slower, not faster, with an oversized heap
/// because GC pauses grow.
pub fn recommended_memory_mb(modded: bool) -> u32 {
    let total = total_memory_mb();
    let target = if modded { 6144 } else { 3072 };
    let cap = total / 2;
    let value = target.min(cap).max(1024);
    // Round to 512 MB steps so the slider lands on clean numbers.
    (value / 512) * 512
}

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    state.settings()
}

#[tauri::command]
pub fn save_settings(state: State<'_, Arc<AppState>>, settings: Settings) -> Result<Settings> {
    let settings = settings.sanitized();
    let dir_changed = settings.game_data_dir != state.settings().game_data_dir;
    if let Some(dir) = settings.game_data_dir.as_ref().filter(|d| !d.trim().is_empty()) {
        // Fail early (and clearly) if the new location isn't usable.
        let probe = std::path::Path::new(dir).join(".vitra-write-test");
        std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&probe, b"ok")).map_err(|e| {
            crate::error::Error::Msg(format!("Vitra can't write to that folder: {e}"))
        })?;
        let _ = std::fs::remove_file(probe);
    }
    state.replace_settings(settings.clone())?;
    state.presence.poke();
    if dir_changed {
        crate::allow_asset_dirs(&state);
    }
    Ok(settings)
}

#[tauri::command]
pub fn reset_settings(state: State<'_, Arc<AppState>>) -> Result<Settings> {
    let current = state.settings();
    // Keep identity-related values; reset everything the user can see.
    let fresh = Settings {
        msa_client_id: current.msa_client_id,
        active_account: current.active_account,
        selected_instance: current.selected_instance,
        game_data_dir: current.game_data_dir,
        onboarded: true,
        ..Settings::default()
    };
    state.replace_settings(fresh.clone())?;
    Ok(fresh)
}
