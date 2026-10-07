use std::io::Read;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use sha1::{Digest, Sha1};

use crate::bail;
use crate::error::Result;

/// SHA-1 of a file, streamed so large jars don't need to fit in memory.
pub fn sha1_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha1::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn sha1_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha1::digest(bytes))
}

/// Converts a Maven coordinate (`group:artifact:version[:classifier][@ext]`)
/// into its repository-relative path.
pub fn maven_path(name: &str) -> Option<String> {
    let (coords, ext) = match name.split_once('@') {
        Some((c, e)) => (c, e),
        None => (name, "jar"),
    };
    let parts: Vec<&str> = coords.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0].replace('.', "/");
    let artifact = parts[1];
    let version = parts[2];
    let file = match parts.get(3) {
        Some(classifier) => format!("{artifact}-{version}-{classifier}.{ext}"),
        None => format!("{artifact}-{version}.{ext}"),
    };
    Some(format!("{group}/{artifact}/{version}/{file}"))
}

/// `group:artifact[:classifier]` — used to de-duplicate libraries when a loader
/// overrides a vanilla library with a different version.
pub fn maven_key(name: &str) -> String {
    let coords = name.split('@').next().unwrap_or(name);
    let parts: Vec<&str> = coords.split(':').collect();
    match parts.len() {
        0..=2 => coords.to_string(),
        3 => format!("{}:{}", parts[0], parts[1]),
        _ => format!("{}:{}:{}", parts[0], parts[1], parts[3..].join(":")),
    }
}

/// Rejects relative paths that could escape their base directory. Used for every
/// path that comes from a downloaded file (modpack indexes, archives).
pub fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        bail!("Refusing absolute path in archive: {rel}");
    }
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) | Component::CurDir => {}
            _ => bail!("Refusing unsafe path in archive: {rel}"),
        }
    }
    Ok(base.join(rel_path))
}

pub fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Writes atomically: a crash mid-write leaves the previous file intact.
/// Each write uses its own temp file so concurrent writers never collide.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    ensure_parent(path)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", &uuid::Uuid::new_v4().simple().to_string()[..8]));
    std::fs::write(&tmp, bytes)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_atomic(path, &bytes)
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = std::fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

pub fn png_data_url(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

pub fn copy_dir_recursive(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            _ => e.metadata().map(|m| m.len()).unwrap_or(0),
        })
        .sum()
}

/// Reads PNG width/height from the IHDR chunk without decoding the image.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

pub fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

pub fn classpath_separator() -> &'static str {
    if cfg!(windows) { ";" } else { ":" }
}

pub fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() { "untitled".into() } else { trimmed }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maven_paths() {
        assert_eq!(
            maven_path("net.fabricmc:fabric-loader:0.16.0").unwrap(),
            "net/fabricmc/fabric-loader/0.16.0/fabric-loader-0.16.0.jar"
        );
        assert_eq!(
            maven_path("org.lwjgl:lwjgl:3.3.3:natives-windows").unwrap(),
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
        );
        assert_eq!(
            maven_path("de.oceanlabs.mcp:mcp_config:1.20.1@zip").unwrap(),
            "de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip"
        );
        assert_eq!(maven_key("org.ow2.asm:asm:9.6"), "org.ow2.asm:asm");
        assert_eq!(
            maven_key("org.lwjgl:lwjgl:3.3.3:natives-windows"),
            "org.lwjgl:lwjgl:natives-windows"
        );
    }

    #[test]
    fn concurrent_atomic_writes_do_not_collide() {
        let dir = std::env::temp_dir().join(format!("vitra-atomic-{}", uuid::Uuid::new_v4()));
        let path = dir.join("index.json");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let p = path.clone();
                std::thread::spawn(move || (0..40).all(|_| write_atomic(&p, format!("{{\"w\":{i}}}").as_bytes()).is_ok()))
            })
            .collect();
        assert!(handles.into_iter().all(|h| h.join().unwrap()));
        assert!(std::fs::read_to_string(&path).unwrap().starts_with("{\"w\":"));
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1, "temp files must not be left behind");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let base = Path::new("/base");
        assert!(safe_join(base, "mods/a.jar").is_ok());
        assert!(safe_join(base, "../evil").is_err());
        assert!(safe_join(base, "mods/../../evil").is_err());
        assert!(safe_join(base, "/etc/passwd").is_err());
    }
}
