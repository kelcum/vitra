//! Mojang version manifest and version JSON model, rule evaluation and the
//! `inheritsFrom` merge used by mod loaders.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::util;

pub const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionManifest {
    pub latest: Latest,
    pub versions: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Latest {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub url: String,
    pub release_time: String,
    #[serde(default)]
    pub sha1: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionJson {
    pub id: String,
    #[serde(default)]
    pub inherits_from: Option<String>,
    #[serde(default)]
    pub main_class: Option<String>,
    #[serde(default)]
    pub minecraft_arguments: Option<String>,
    #[serde(default)]
    pub arguments: Option<Arguments>,
    #[serde(default)]
    pub asset_index: Option<AssetIndexRef>,
    #[serde(default)]
    pub assets: Option<String>,
    #[serde(default)]
    pub downloads: Option<HashMap<String, FileRef>>,
    #[serde(default)]
    pub libraries: Vec<Library>,
    #[serde(default)]
    pub java_version: Option<JavaVersion>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    #[serde(default)]
    pub logging: Option<Logging>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<ArgValue>,
    #[serde(default)]
    pub jvm: Vec<ArgValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArgValue {
    Plain(String),
    Conditional { rules: Vec<Rule>, value: StringOrVec },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StringOrVec {
    One(String),
    Many(Vec<String>),
}

impl StringOrVec {
    pub fn to_vec(&self) -> Vec<String> {
        match self {
            StringOrVec::One(s) => vec![s.clone()],
            StringOrVec::Many(v) => v.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetIndexRef {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    #[serde(default)]
    pub total_size: Option<u64>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRef {
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaVersion {
    #[serde(default)]
    pub component: Option<String>,
    pub major_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Logging {
    #[serde(default)]
    pub client: Option<LoggingClient>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingClient {
    pub argument: String,
    pub file: LoggingFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingFile {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Library {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<LibraryDownloads>,
    /// Maven repository base (Fabric/Quilt style libraries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<Rule>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natives: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LibraryDownloads {
    #[serde(default)]
    pub artifact: Option<Artifact>,
    #[serde(default)]
    pub classifiers: Option<HashMap<String, Artifact>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub sha1: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
    #[serde(default)]
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsRule {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
}

/// Feature flags used by conditional arguments.
#[derive(Debug, Clone, Default)]
pub struct Features {
    pub is_demo_user: bool,
    pub has_custom_resolution: bool,
    pub has_quick_plays_support: bool,
    pub is_quick_play_singleplayer: bool,
    pub is_quick_play_multiplayer: bool,
}

impl Features {
    fn get(&self, name: &str) -> bool {
        match name {
            "is_demo_user" => self.is_demo_user,
            "has_custom_resolution" => self.has_custom_resolution,
            "has_quick_plays_support" => self.has_quick_plays_support,
            "is_quick_play_singleplayer" => self.is_quick_play_singleplayer,
            "is_quick_play_multiplayer" => self.is_quick_play_multiplayer,
            _ => false,
        }
    }
}

fn os_rule_matches(os: &OsRule) -> bool {
    if let Some(name) = &os.name {
        if name != util::os_name() {
            return false;
        }
    }
    if let Some(arch) = &os.arch {
        let is_x86 = cfg!(target_arch = "x86");
        if arch == "x86" && !is_x86 {
            return false;
        }
    }
    // `version` regexes only target ancient Windows/macOS releases; every
    // supported OS satisfies them, so they are treated as matching.
    true
}

/// Mojang rule semantics: disallowed by default when rules exist; the last
/// matching rule wins.
pub fn rules_allow(rules: &Option<Vec<Rule>>, features: &Features) -> bool {
    let Some(rules) = rules else { return true };
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        let mut matches = true;
        if let Some(os) = &rule.os {
            matches &= os_rule_matches(os);
        }
        if let Some(feats) = &rule.features {
            matches &= feats.iter().all(|(k, v)| features.get(k) == *v);
        }
        if matches {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

impl Library {
    pub fn is_allowed(&self) -> bool {
        rules_allow(&self.rules, &Features::default())
    }

    /// Classifier for old-style native libraries on this OS, e.g. `natives-windows`.
    pub fn native_classifier(&self) -> Option<String> {
        let natives = self.natives.as_ref()?;
        let key = match util::os_name() {
            "osx" => natives.get("osx").or_else(|| natives.get("macos")),
            other => natives.get(other),
        }?;
        let arch = if cfg!(target_pointer_width = "64") { "64" } else { "32" };
        Some(key.replace("${arch}", arch))
    }

    /// The main artifact: (relative path, url, sha1, size). Libraries without
    /// a URL (produced locally by Forge installers) return an empty URL.
    pub fn artifact(&self) -> Option<(String, String, Option<String>, Option<u64>)> {
        if let Some(dl) = &self.downloads {
            if let Some(a) = &dl.artifact {
                let path = a.path.clone().or_else(|| util::maven_path(&self.name))?;
                return Some((path, a.url.clone(), a.sha1.clone(), a.size));
            }
            // Old natives-only entries have classifiers but no artifact.
            if dl.classifiers.is_some() && self.natives.is_some() {
                return None;
            }
        }
        let path = util::maven_path(&self.name)?;
        let base = self.url.clone().unwrap_or_else(|| "https://libraries.minecraft.net/".into());
        let base = if base.ends_with('/') { base } else { format!("{base}/") };
        Some((path.clone(), format!("{base}{path}"), self.sha1.clone(), self.size))
    }

    pub fn native_artifact(&self) -> Option<Artifact> {
        let classifier = self.native_classifier()?;
        let dl = self.downloads.as_ref()?;
        let mut a = dl.classifiers.as_ref()?.get(&classifier)?.clone();
        if a.path.is_none() {
            a.path = util::maven_path(&format!("{}:{}", self.name, classifier));
        }
        Some(a)
    }
}

impl VersionJson {
    /// Merges a loader profile (`self`, which `inheritsFrom` the parent) onto
    /// its parent. Loader libraries win on conflicts.
    pub fn merge_onto(self, parent: VersionJson) -> VersionJson {
        let mut seen = HashSet::new();
        let mut libraries = Vec::new();
        for lib in self.libraries.into_iter().chain(parent.libraries) {
            let key = util::maven_key(&lib.name);
            // Keep natives of the same artifact distinct from the main jar.
            let key = if lib.natives.is_some() { format!("{key}#natives") } else { key };
            if seen.insert(key) {
                libraries.push(lib);
            }
        }
        let arguments = match (parent.arguments, self.arguments) {
            (Some(mut p), Some(c)) => {
                p.game.extend(c.game);
                p.jvm.extend(c.jvm);
                Some(p)
            }
            (p, c) => c.or(p),
        };
        VersionJson {
            id: self.id,
            inherits_from: None,
            main_class: self.main_class.or(parent.main_class),
            minecraft_arguments: self.minecraft_arguments.or(parent.minecraft_arguments),
            arguments,
            asset_index: self.asset_index.or(parent.asset_index),
            assets: self.assets.or(parent.assets),
            downloads: self.downloads.or(parent.downloads),
            libraries,
            java_version: self.java_version.or(parent.java_version),
            kind: parent.kind.or(self.kind),
            logging: self.logging.or(parent.logging),
        }
    }

    pub fn supports_quick_play(&self) -> bool {
        self.arguments
            .as_ref()
            .map(|a| {
                a.game.iter().any(|arg| match arg {
                    ArgValue::Conditional { value, .. } => {
                        value.to_vec().iter().any(|v| v == "--quickPlaySingleplayer")
                    }
                    _ => false,
                })
            })
            .unwrap_or(false)
    }

    /// The Java major version this version needs. Versions from before Mojang
    /// started declaring it all run on Java 8.
    pub fn java_major(&self) -> u32 {
        self.java_version.as_ref().map(|j| j.major_version).unwrap_or(8)
    }

    pub fn java_component(&self) -> String {
        self.java_version
            .as_ref()
            .and_then(|j| j.component.clone())
            .unwrap_or_else(|| "jre-legacy".into())
    }
}

/// Expands `${placeholders}` in a single argument.
pub fn substitute(arg: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let key = &after[..end];
                match vars.get(key) {
                    Some(v) => out.push_str(v),
                    None => {
                        out.push_str("${");
                        out.push_str(key);
                        out.push('}');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn expand_args(args: &[ArgValue], features: &Features, vars: &HashMap<&str, String>) -> Vec<String> {
    let mut out = Vec::new();
    for arg in args {
        match arg {
            ArgValue::Plain(s) => out.push(substitute(s, vars)),
            ArgValue::Conditional { rules, value } => {
                if rules_allow(&Some(rules.clone()), features) {
                    out.extend(value.to_vec().iter().map(|v| substitute(v, vars)));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitution() {
        let mut vars = HashMap::new();
        vars.insert("a", "1".to_string());
        assert_eq!(substitute("x${a}y${b}", &vars), "x1y${b}");
        assert_eq!(substitute("-Dfoo=${a}", &vars), "-Dfoo=1");
    }

    #[test]
    fn rules() {
        let win_only = Some(vec![Rule {
            action: "allow".into(),
            os: Some(OsRule { name: Some("windows".into()), arch: None, version: None }),
            features: None,
        }]);
        assert_eq!(rules_allow(&win_only, &Features::default()), cfg!(windows));
        let disallow_osx = Some(vec![
            Rule { action: "allow".into(), os: None, features: None },
            Rule {
                action: "disallow".into(),
                os: Some(OsRule { name: Some("osx".into()), arch: None, version: None }),
                features: None,
            },
        ]);
        assert_eq!(rules_allow(&disallow_osx, &Features::default()), !cfg!(target_os = "macos"));
        let demo = Some(vec![Rule {
            action: "allow".into(),
            os: None,
            features: Some(HashMap::from([("is_demo_user".to_string(), true)])),
        }]);
        assert!(!rules_allow(&demo, &Features::default()));
        assert!(rules_allow(&demo, &Features { is_demo_user: true, ..Default::default() }));
    }
}
