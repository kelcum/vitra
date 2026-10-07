//! Parallel downloader.
//!
//! - Skips files that are already present (size match, or full SHA-1 when
//!   `verify` is requested — used by "Repair").
//! - Streams into `<file>.part` and resumes with HTTP Range after interruptions.
//! - Verifies SHA-1 after every download; a mismatch is deleted and retried.
//! - Retries transient failures with exponential backoff.
//! - Reuses connections through a single shared `reqwest::Client`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::{StreamExt, TryStreamExt, stream};
use reqwest::StatusCode;
use reqwest::header::RANGE;
use serde::de::DeserializeOwned;
use tokio::io::AsyncWriteExt;

use crate::bail;
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::tasks::TaskHandle;
use crate::util;

#[derive(Debug, Clone)]
pub struct Download {
    pub url: String,
    pub path: PathBuf,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

impl Download {
    pub fn new(url: impl Into<String>, path: PathBuf) -> Self {
        Self { url: url.into(), path, sha1: None, size: None }
    }
    pub fn sha1(mut self, sha1: Option<String>) -> Self {
        self.sha1 = sha1.filter(|s| !s.is_empty());
        self
    }
    pub fn size(mut self, size: Option<u64>) -> Self {
        self.size = size.filter(|s| *s > 0);
        self
    }
}

/// True when the file on disk already satisfies the job.
fn is_satisfied(job: &Download, verify: bool) -> bool {
    let Ok(meta) = std::fs::metadata(&job.path) else {
        return false;
    };
    if let Some(size) = job.size {
        if meta.len() != size {
            return false;
        }
    }
    if verify {
        if let Some(expected) = &job.sha1 {
            return util::sha1_file(&job.path)
                .map(|h| h.eq_ignore_ascii_case(expected))
                .unwrap_or(false);
        }
    }
    true
}

/// Downloads every job that isn't already satisfied. Progress is reported on
/// `task` within its current stage.
pub async fn download_all(state: &AppState, task: &TaskHandle, jobs: Vec<Download>, verify: bool) -> Result<()> {
    let mut seen = HashSet::new();
    let jobs: Vec<Download> = jobs.into_iter().filter(|j| seen.insert(j.path.clone())).collect();

    let pending: Vec<Download> = tokio::task::spawn_blocking(move || {
        jobs.into_iter().filter(|j| !is_satisfied(j, verify)).collect()
    })
    .await
    .map_err(|e| Error::Msg(e.to_string()))?;

    if pending.is_empty() {
        return Ok(());
    }

    // Byte-accurate progress is only honest when every size is known.
    let all_sized = pending.iter().all(|j| j.size.is_some());
    let total_bytes = if all_sized { pending.iter().filter_map(|j| j.size).sum() } else { 0 };
    task.set_totals(pending.len() as u64, total_bytes);

    let concurrency = state.settings().download_concurrency.max(1) as usize;
    stream::iter(pending.into_iter().map(|job| download_with_retry(&state.http, task, job)))
        .buffer_unordered(concurrency)
        .try_collect::<Vec<()>>()
        .await?;
    Ok(())
}

async fn download_with_retry(http: &reqwest::Client, task: &TaskHandle, job: Download) -> Result<()> {
    let mut attempt = 0u32;
    loop {
        task.check_cancelled()?;
        let mut counted = 0u64;
        match try_download(http, task, &job, &mut counted).await {
            Ok(()) => {
                task.file_done();
                return Ok(());
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(e) => {
                task.sub_bytes(counted);
                attempt += 1;
                if attempt > 4 {
                    let name = job.path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    bail!("Couldn't download {name} after several attempts ({e}). Check your connection and try again.");
                }
                tokio::time::sleep(Duration::from_millis(400 * 2u64.pow(attempt))).await;
            }
        }
    }
}

async fn try_download(http: &reqwest::Client, task: &TaskHandle, job: &Download, counted: &mut u64) -> Result<()> {
    util::ensure_parent(&job.path)?;
    let part = part_path(&job.path);
    let existing = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0);

    let mut req = http.get(&job.url);
    if existing > 0 {
        req = req.header(RANGE, format!("bytes={existing}-"));
    }
    let resp = req.send().await?;
    let status = resp.status();

    if status == StatusCode::RANGE_NOT_SATISFIABLE {
        // The partial file is already complete (or bogus) — verify decides.
        task.add_bytes(existing);
        *counted += existing;
    } else {
        if !status.is_success() {
            if existing > 0 {
                let _ = tokio::fs::remove_file(&part).await;
            }
            bail!("server returned {status}");
        }
        let resuming = status == StatusCode::PARTIAL_CONTENT && existing > 0;
        let mut file = if resuming {
            task.add_bytes(existing);
            *counted += existing;
            tokio::fs::OpenOptions::new().append(true).open(&part).await?
        } else {
            tokio::fs::File::create(&part).await?
        };
        let mut body = resp.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            task.add_bytes(chunk.len() as u64);
            *counted += chunk.len() as u64;
            if task.is_cancelled() {
                file.flush().await?;
                return Err(Error::Cancelled);
            }
        }
        file.flush().await?;
    }

    let part_len = tokio::fs::metadata(&part).await?.len();
    if let Some(size) = job.size {
        if part_len != size {
            let _ = tokio::fs::remove_file(&part).await;
            bail!("size mismatch (expected {size} bytes, got {part_len})");
        }
    }
    if let Some(expected) = &job.sha1 {
        let p = part.clone();
        let actual = tokio::task::spawn_blocking(move || util::sha1_file(&p))
            .await
            .map_err(|e| Error::Msg(e.to_string()))??;
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = tokio::fs::remove_file(&part).await;
            bail!("checksum mismatch — the file was corrupted in transit");
        }
    }
    tokio::fs::rename(&part, &job.path).await?;
    Ok(())
}

fn part_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    path.with_file_name(name)
}

/// GET + JSON decode with a couple of retries for flaky connections.
pub async fn get_json<T: DeserializeOwned>(http: &reqwest::Client, url: &str) -> Result<T> {
    let mut attempt = 0;
    loop {
        let result = async {
            let resp = http.get(url).send().await?;
            let status = resp.status();
            if !status.is_success() {
                bail!("{url} returned {status}");
            }
            Ok::<T, Error>(resp.json::<T>().await?)
        }
        .await;
        match result {
            Ok(v) => return Ok(v),
            Err(e) if attempt >= 2 => return Err(e),
            Err(_) => {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
            }
        }
    }
}

pub async fn get_bytes(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let resp = http.get(url).send().await?;
    let status = resp.status();
    if !status.is_success() {
        bail!("{url} returned {status}");
    }
    Ok(resp.bytes().await?.to_vec())
}

/// Fetches JSON and caches it on disk. When offline, falls back to the cached
/// copy so the launcher still works (e.g. launching already-installed versions).
pub async fn cached_json<T: DeserializeOwned + serde::Serialize>(
    http: &reqwest::Client,
    url: &str,
    cache: &Path,
) -> Result<T> {
    match get_json::<serde_json::Value>(http, url).await {
        Ok(value) => {
            let _ = util::write_json(cache, &value);
            Ok(serde_json::from_value(value)?)
        }
        Err(e) => match util::read_json::<T>(cache) {
            Ok(v) => Ok(v),
            Err(_) => Err(e),
        },
    }
}

/// Downloads a single small file (e.g. a version JSON) with verification.
pub async fn fetch_file(http: &reqwest::Client, url: &str, path: &Path, sha1: Option<&str>) -> Result<()> {
    if let Some(expected) = sha1 {
        if path.exists() && util::sha1_file(path).map(|h| h.eq_ignore_ascii_case(expected)).unwrap_or(false) {
            return Ok(());
        }
    }
    let bytes = get_bytes(http, url).await?;
    if let Some(expected) = sha1 {
        if !util::sha1_bytes(&bytes).eq_ignore_ascii_case(expected) {
            bail!("Checksum mismatch for {url}");
        }
    }
    util::write_atomic(path, &bytes)
}
