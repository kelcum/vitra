use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;

use crate::bail;
use crate::error::Result;
use crate::state::AppState;

pub const API: &str = "https://api.modrinth.com/v2";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MrFile {
    pub url: String,
    pub filename: String,
    #[serde(default)]
    pub primary: bool,
    pub hashes: HashMap<String, String>,
    #[serde(default)]
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MrDependency {
    #[serde(default)]
    pub version_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    pub dependency_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MrVersion {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub version_number: String,
    #[serde(default)]
    pub game_versions: Vec<String>,
    #[serde(default)]
    pub loaders: Vec<String>,
    #[serde(default)]
    pub version_type: String,
    #[serde(default)]
    pub dependencies: Vec<MrDependency>,
    pub files: Vec<MrFile>,
    #[serde(default)]
    pub date_published: String,
    #[serde(default)]
    pub downloads: u64,
}

impl MrVersion {
    pub fn primary_file(&self) -> Option<&MrFile> {
        self.files.iter().find(|f| f.primary).or(self.files.first())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MrProject {
    pub id: String,
    pub slug: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon_url: Option<String>,
    pub project_type: String,
}

async fn get<T: serde::de::DeserializeOwned>(state: &AppState, path: &str, query: &[(&str, String)]) -> Result<T> {
    let resp = state.http.get(format!("{API}{path}")).query(query).send().await?;
    let status = resp.status();
    if status.as_u16() == 404 {
        bail!("Not found on Modrinth.");
    }
    if status.as_u16() == 429 {
        bail!("Modrinth is rate-limiting requests. Wait a few seconds and try again.");
    }
    if !status.is_success() {
        bail!("Modrinth returned an error ({status}).");
    }
    Ok(resp.json().await?)
}

pub async fn version(state: &AppState, id: &str) -> Result<MrVersion> {
    get(state, &format!("/version/{id}"), &[]).await
}

pub async fn project_versions(
    state: &AppState,
    project: &str,
    loaders: Option<&[&str]>,
    game_version: Option<&str>,
) -> Result<Vec<MrVersion>> {
    let mut q = Vec::new();
    if let Some(l) = loaders {
        q.push(("loaders", serde_json::to_string(l)?));
    }
    if let Some(g) = game_version {
        q.push(("game_versions", json!([g]).to_string()));
    }
    get(state, &format!("/project/{project}/version"), &q).await
}

pub async fn projects(state: &AppState, ids: &[String]) -> Result<Vec<MrProject>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for chunk in ids.chunks(100) {
        let batch: Vec<MrProject> = get(state, "/projects", &[("ids", serde_json::to_string(chunk)?)]).await?;
        out.extend(batch);
    }
    Ok(out)
}

pub async fn versions_by_hash(state: &AppState, hashes: &[String]) -> Result<HashMap<String, MrVersion>> {
    if hashes.is_empty() {
        return Ok(HashMap::new());
    }
    let resp = state
        .http
        .post(format!("{API}/version_files"))
        .json(&json!({ "hashes": hashes, "algorithm": "sha1" }))
        .send()
        .await?;
    if !resp.status().is_success() {
        bail!("Modrinth lookup failed ({}).", resp.status());
    }
    Ok(resp.json().await?)
}

pub async fn latest_by_hash(
    state: &AppState,
    hashes: &[String],
    loaders: &[&str],
    game_version: &str,
) -> Result<HashMap<String, MrVersion>> {
    if hashes.is_empty() {
        return Ok(HashMap::new());
    }
    let resp = state
        .http
        .post(format!("{API}/version_files/update"))
        .json(&json!({ "hashes": hashes, "algorithm": "sha1", "loaders": loaders, "game_versions": [game_version] }))
        .send()
        .await?;
    if !resp.status().is_success() {
        bail!("Modrinth update check failed ({}).", resp.status());
    }
    Ok(resp.json().await?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    pub project_type: String,
    pub loader: Option<String>,
    pub game_version: Option<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    pub sort: Option<String>,
    pub offset: u32,
    pub limit: u32,
}

#[tauri::command]
pub async fn modrinth_search(state: State<'_, Arc<AppState>>, params: SearchParams) -> Result<Value> {
    let mut facets: Vec<Vec<String>> = vec![vec![format!("project_type:{}", params.project_type)]];
    if let Some(loader) = params.loader.filter(|l| !l.is_empty() && l != "vanilla") {
        if params.project_type == "mod" || params.project_type == "modpack" {
            if loader == "quilt" && params.project_type == "mod" {
                facets.push(vec!["categories:quilt".into(), "categories:fabric".into()]);
            } else {
                facets.push(vec![format!("categories:{loader}")]);
            }
        }
    }
    if let Some(gv) = params.game_version.filter(|g| !g.is_empty()) {
        facets.push(vec![format!("versions:{gv}")]);
    }
    for c in params.categories {
        facets.push(vec![format!("categories:{c}")]);
    }
    let index = params.sort.unwrap_or_else(|| "relevance".into());
    get(
        &state,
        "/search",
        &[
            ("query", params.query),
            ("facets", serde_json::to_string(&facets)?),
            ("index", index),
            ("offset", params.offset.to_string()),
            ("limit", params.limit.min(50).to_string()),
        ],
    )
    .await
}

#[tauri::command]
pub async fn modrinth_project(state: State<'_, Arc<AppState>>, id: String) -> Result<Value> {
    get(&state, &format!("/project/{id}"), &[]).await
}

#[tauri::command]
pub async fn modrinth_versions(
    state: State<'_, Arc<AppState>>,
    id: String,
    loader: Option<String>,
    game_version: Option<String>,
) -> Result<Vec<MrVersion>> {
    let loaders: Option<Vec<&str>> = loader.as_deref().map(|l| crate::content::compatible_loaders(l, "mod"));
    project_versions(&state, &id, loaders.as_deref(), game_version.as_deref()).await
}

#[tauri::command]
pub async fn modrinth_categories(state: State<'_, Arc<AppState>>) -> Result<Value> {
    let cache = state.cache_dir().join("modrinth-categories.json");
    crate::net::cached_json(&state.http, &format!("{API}/tag/category"), &cache).await
}
