use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::error::Result;
use crate::minecraft::manifest::VersionManifest;
use crate::settings::Settings;
use crate::tasks::Tasks;
use crate::util;

pub const USER_AGENT: &str = concat!("vitra-launcher/", env!("CARGO_PKG_VERSION"));

pub struct RunningGame {
    pub pid: u32,
    pub started_at: i64,
    pub kill: tokio::sync::watch::Sender<bool>,
    pub log: tokio::sync::mpsc::WeakUnboundedSender<crate::minecraft::launch::LogLine>,
}

pub struct AppState {
    pub app: AppHandle,
    pub root: PathBuf,
    settings: RwLock<Settings>,
    pub http: reqwest::Client,
    pub tasks: Tasks,
    pub running: Mutex<HashMap<String, RunningGame>>,
    pub launching: Mutex<HashSet<String>>,
    pub presence: crate::presence::Presence,
    pub manifest: tokio::sync::Mutex<Option<(i64, VersionManifest)>>,
    pub auth_cancel: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
}

impl AppState {
    pub fn new(app: AppHandle, root: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&root)?;
        let mut settings = Settings::load(&root.join("settings.json"));
        if settings.msa_client_id.as_deref().map(str::trim) == Some(crate::auth::builtin_client_id().as_str()) {
            settings.msa_client_id = None;
            let _ = util::write_json(&root.join("settings.json"), &settings);
        }
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(45))
            .pool_max_idle_per_host(32)
            .build()?;
        Ok(Arc::new(Self {
            tasks: Tasks::new(app.clone()),
            app,
            root,
            settings: RwLock::new(settings),
            http,
            running: Mutex::new(HashMap::new()),
            launching: Mutex::new(HashSet::new()),
            presence: Default::default(),
            manifest: tokio::sync::Mutex::new(None),
            auth_cancel: Mutex::new(None),
        }))
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().expect("settings lock").clone()
    }

    pub fn replace_settings(&self, settings: Settings) -> Result<()> {
        util::write_json(&self.root.join("settings.json"), &settings)?;
        *self.settings.write().expect("settings lock") = settings;
        Ok(())
    }

    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<Settings> {
        let mut s = self.settings();
        f(&mut s);
        self.replace_settings(s.clone())?;
        let _ = self.app.emit("settings://changed", &s);
        Ok(s)
    }

    pub fn in_use(&self, id: &str) -> bool {
        self.launching.lock().unwrap().contains(id) || self.running.lock().unwrap().contains_key(id)
    }

    pub fn data_dir(&self) -> PathBuf {
        match self.settings().game_data_dir {
            Some(dir) if !dir.trim().is_empty() => PathBuf::from(if cfg!(windows) { dir.trim().replace('/', "\\") } else { dir }),
            _ => self.root.clone(),
        }
    }

    pub fn libraries_dir(&self) -> PathBuf {
        self.data_dir().join("libraries")
    }
    pub fn assets_dir(&self) -> PathBuf {
        self.data_dir().join("assets")
    }
    pub fn versions_dir(&self) -> PathBuf {
        self.data_dir().join("versions")
    }
    pub fn runtimes_dir(&self) -> PathBuf {
        self.data_dir().join("runtimes")
    }
    pub fn instances_dir(&self) -> PathBuf {
        self.data_dir().join("instances")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.root.join("cache")
    }
    pub fn skins_dir(&self) -> PathBuf {
        self.root.join("skins")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir().join("backups")
    }
}
