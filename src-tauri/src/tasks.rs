//! Long-running jobs (installs, downloads, backups) report progress through a
//! `TaskHandle`. Counters are atomics so download workers can update them
//! without locking; a single ticker per task emits throttled snapshots to the
//! UI so a 4,000-file asset download doesn't flood the IPC channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub stage: String,
    pub instance_id: Option<String>,
    /// 0..1, or `None` when progress genuinely can't be measured.
    pub progress: Option<f64>,
    pub files_done: u64,
    pub files_total: u64,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub bytes_per_sec: u64,
    pub eta_secs: Option<u64>,
    pub state: String,
    pub error: Option<String>,
    pub started_at: i64,
}

struct Inner {
    id: String,
    kind: String,
    title: String,
    instance_id: Option<String>,
    stage: Mutex<String>,
    measurable: AtomicBool,
    files_done: AtomicU64,
    files_total: AtomicU64,
    bytes_done: AtomicU64,
    bytes_total: AtomicU64,
    speed: AtomicU64,
    state: Mutex<(String, Option<String>)>,
    cancelled: AtomicBool,
    dirty: AtomicBool,
    started_at: i64,
}

impl Inner {
    fn snapshot(&self) -> TaskSnapshot {
        let files_done = self.files_done.load(Ordering::Relaxed);
        let files_total = self.files_total.load(Ordering::Relaxed);
        let bytes_done = self.bytes_done.load(Ordering::Relaxed);
        let bytes_total = self.bytes_total.load(Ordering::Relaxed);
        let speed = self.speed.load(Ordering::Relaxed);
        let measurable = self.measurable.load(Ordering::Relaxed);
        let progress = if !measurable {
            None
        } else if bytes_total > 0 {
            Some((bytes_done as f64 / bytes_total as f64).min(1.0))
        } else if files_total > 0 {
            Some((files_done as f64 / files_total as f64).min(1.0))
        } else {
            None
        };
        let eta_secs = if measurable && bytes_total > bytes_done && speed > 0 {
            Some((bytes_total - bytes_done) / speed)
        } else {
            None
        };
        let (state, error) = self.state.lock().unwrap().clone();
        TaskSnapshot {
            id: self.id.clone(),
            kind: self.kind.clone(),
            title: self.title.clone(),
            stage: self.stage.lock().unwrap().clone(),
            instance_id: self.instance_id.clone(),
            progress,
            files_done,
            files_total,
            bytes_done,
            bytes_total,
            bytes_per_sec: speed,
            eta_secs,
            state,
            error,
            started_at: self.started_at,
        }
    }
}

#[derive(Clone)]
pub struct TaskHandle {
    inner: Arc<Inner>,
    app: AppHandle,
}

impl TaskHandle {
    pub fn id(&self) -> &str {
        &self.inner.id
    }

    /// Starts a new stage. `measurable` = whether the stage can report honest
    /// progress; when false the UI shows an indeterminate animation.
    pub fn stage(&self, stage: impl Into<String>, measurable: bool) {
        *self.inner.stage.lock().unwrap() = stage.into();
        self.inner.measurable.store(measurable, Ordering::Relaxed);
        self.inner.files_done.store(0, Ordering::Relaxed);
        self.inner.files_total.store(0, Ordering::Relaxed);
        self.inner.bytes_done.store(0, Ordering::Relaxed);
        self.inner.bytes_total.store(0, Ordering::Relaxed);
        self.inner.speed.store(0, Ordering::Relaxed);
        self.emit_now();
    }

    pub fn set_totals(&self, files: u64, bytes: u64) {
        self.inner.files_total.store(files, Ordering::Relaxed);
        self.inner.bytes_total.store(bytes, Ordering::Relaxed);
        self.inner.dirty.store(true, Ordering::Relaxed);
    }

    pub fn file_done(&self) {
        self.inner.files_done.fetch_add(1, Ordering::Relaxed);
        self.inner.dirty.store(true, Ordering::Relaxed);
    }

    pub fn add_bytes(&self, n: u64) {
        self.inner.bytes_done.fetch_add(n, Ordering::Relaxed);
        self.inner.dirty.store(true, Ordering::Relaxed);
    }

    /// Undo bytes counted for an attempt that failed and will be retried.
    pub fn sub_bytes(&self, n: u64) {
        let counter = &self.inner.bytes_done;
        let mut current = counter.load(Ordering::Relaxed);
        while let Err(actual) =
            counter.compare_exchange_weak(current, current.saturating_sub(n), Ordering::Relaxed, Ordering::Relaxed)
        {
            current = actual;
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Relaxed)
    }

    pub fn check_cancelled(&self) -> Result<()> {
        if self.is_cancelled() { Err(Error::Cancelled) } else { Ok(()) }
    }

    pub fn finish(&self) {
        *self.inner.state.lock().unwrap() = ("done".into(), None);
        self.emit_now();
    }

    pub fn fail(&self, err: &Error) {
        let state = if matches!(err, Error::Cancelled) { "cancelled" } else { "failed" };
        *self.inner.state.lock().unwrap() = (state.into(), Some(err.to_string()));
        self.emit_now();
    }

    /// Records the outcome of `result` on the task and passes it through.
    pub fn complete<T>(&self, result: Result<T>) -> Result<T> {
        match &result {
            Ok(_) => self.finish(),
            Err(e) => self.fail(e),
        }
        result
    }

    fn emit_now(&self) {
        self.inner.dirty.store(false, Ordering::Relaxed);
        let _ = self.app.emit("task://update", self.inner.snapshot());
    }
}

pub struct Tasks {
    app: AppHandle,
    map: Mutex<HashMap<String, Arc<Inner>>>,
}

impl Tasks {
    pub fn new(app: AppHandle) -> Self {
        Self { app, map: Mutex::new(HashMap::new()) }
    }

    pub fn start(&self, kind: &str, title: impl Into<String>, instance_id: Option<String>) -> TaskHandle {
        let inner = Arc::new(Inner {
            id: uuid::Uuid::new_v4().to_string(),
            kind: kind.into(),
            title: title.into(),
            instance_id,
            stage: Mutex::new("Preparing".into()),
            measurable: AtomicBool::new(false),
            files_done: AtomicU64::new(0),
            files_total: AtomicU64::new(0),
            bytes_done: AtomicU64::new(0),
            bytes_total: AtomicU64::new(0),
            speed: AtomicU64::new(0),
            state: Mutex::new(("running".into(), None)),
            cancelled: AtomicBool::new(false),
            dirty: AtomicBool::new(true),
            started_at: crate::util::now_millis(),
        });
        self.map.lock().unwrap().insert(inner.id.clone(), inner.clone());
        let handle = TaskHandle { inner: inner.clone(), app: self.app.clone() };
        handle.emit_now();

        // Ticker: emits at most ~7 times/sec and computes a smoothed speed.
        let ticker = handle.clone();
        tauri::async_runtime::spawn(async move {
            let mut last_bytes = 0u64;
            let mut last_t = Instant::now();
            let mut smoothed = 0f64;
            loop {
                tokio::time::sleep(Duration::from_millis(150)).await;
                if ticker.inner.state.lock().unwrap().0 != "running" {
                    break;
                }
                let bytes = ticker.inner.bytes_done.load(Ordering::Relaxed);
                let dt = last_t.elapsed().as_secs_f64();
                if dt > 0.0 {
                    let inst = bytes.saturating_sub(last_bytes) as f64 / dt;
                    smoothed = if smoothed == 0.0 { inst } else { smoothed * 0.8 + inst * 0.2 };
                    ticker.inner.speed.store(smoothed as u64, Ordering::Relaxed);
                }
                last_bytes = bytes;
                last_t = Instant::now();
                if ticker.inner.dirty.swap(false, Ordering::Relaxed) {
                    let _ = ticker.app.emit("task://update", ticker.inner.snapshot());
                }
            }
        });
        handle
    }

    pub fn cancel(&self, id: &str) {
        if let Some(t) = self.map.lock().unwrap().get(id) {
            t.cancelled.store(true, Ordering::Relaxed);
        }
    }

    pub fn list(&self) -> Vec<TaskSnapshot> {
        let mut map = self.map.lock().unwrap();
        // Forget finished tasks older than 10 minutes so the map can't grow forever.
        let cutoff = crate::util::now_millis() - 10 * 60 * 1000;
        map.retain(|_, t| t.state.lock().unwrap().0 == "running" || t.started_at > cutoff);
        let mut v: Vec<_> = map.values().map(|t| t.snapshot()).collect();
        v.sort_by_key(|t| t.started_at);
        v
    }
}

#[tauri::command]
pub fn list_tasks(state: tauri::State<'_, Arc<crate::state::AppState>>) -> Vec<TaskSnapshot> {
    state.tasks.list()
}

#[tauri::command]
pub fn cancel_task(state: tauri::State<'_, Arc<crate::state::AppState>>, id: String) {
    state.tasks.cancel(&id);
}
