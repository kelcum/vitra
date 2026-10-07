//! Servers page: a curated list of large public servers, the player's own
//! servers, which ones are hidden, and live status via the vanilla Server
//! List Ping protocol (the same request the in-game multiplayer screen sends).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::bail;
use crate::error::{Error, Result};
use crate::state::AppState;
use crate::util;

struct Featured {
    id: &'static str,
    name: &'static str,
    address: &'static str,
    category: &'static str,
    description: &'static str,
}

const FEATURED: &[Featured] = &[
    Featured { id: "hypixel", name: "Hypixel", address: "mc.hypixel.net", category: "Minigames", description: "The biggest Java network: Bed Wars, SkyBlock, SkyWars, Duels and more." },
    Featured { id: "mccisland", name: "MCC Island", address: "play.mccisland.net", category: "Minigames", description: "Polished party games from the creators of MC Championship." },
    Featured { id: "cubecraft", name: "CubeCraft", address: "play.cubecraft.net", category: "Minigames", description: "EggWars, SkyWars, Parkour and Block Wars for Java and Bedrock." },
    Featured { id: "wynncraft", name: "Wynncraft", address: "play.wynncraft.com", category: "RPG", description: "A full MMORPG with quests, dungeons, raids and classes." },
    Featured { id: "originrealms", name: "Origin Realms", address: "play.originrealms.com", category: "Adventure", description: "Survival adventure with custom creatures, items and worlds." },
    Featured { id: "manacube", name: "ManaCube", address: "play.manacube.com", category: "Survival", description: "Skyblock, Parkour, Survival and Prison on one network." },
    Featured { id: "complex", name: "Complex Gaming", address: "hub.mc-complex.com", category: "Survival", description: "Pixelmon, Towny, Factions, Skyblock and Prison." },
    Featured { id: "pika", name: "PikaNetwork", address: "play.pika-network.net", category: "Minigames", description: "Bed Wars, practice PvP, Skyblock and survival modes." },
    Featured { id: "lifesteal", name: "Lifesteal", address: "lifesteal.net", category: "Survival", description: "SMP where every kill steals a heart from your opponent." },
    Featured { id: "purpleprison", name: "Purple Prison", address: "purpleprison.net", category: "Prison", description: "Mine, rank up and trade in one of the longest-running prisons." },
    Featured { id: "minemen", name: "Minemen Club", address: "minemen.club", category: "PvP", description: "Competitive practice PvP with ranked ladders." },
    Featured { id: "hoplite", name: "Hoplite", address: "hoplite.gg", category: "PvP", description: "Battle royale with kits, classes and seasonal ranks." },
    Featured { id: "minehut", name: "Minehut", address: "minehut.com", category: "Community", description: "A lobby for thousands of free player-run servers." },
    Featured { id: "2b2t", name: "2b2t", address: "2b2t.org", category: "Anarchy", description: "The oldest anarchy server: no rules, since 2010." },
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CustomServer {
    id: String,
    name: String,
    address: String,
    added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ServerStore {
    custom: Vec<CustomServer>,
    hidden: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEntry {
    pub id: String,
    pub name: String,
    pub address: String,
    pub category: Option<String>,
    pub description: Option<String>,
    pub featured: bool,
    pub hidden: bool,
}

fn store_path(state: &AppState) -> std::path::PathBuf {
    state.root.join("servers.json")
}

fn load_store(state: &AppState) -> ServerStore {
    util::read_json(&store_path(state)).unwrap_or_default()
}

fn save_store(state: &AppState, store: &ServerStore) -> Result<()> {
    util::write_json(&store_path(state), store)
}

fn entries(store: &ServerStore) -> Vec<ServerEntry> {
    let hidden = |id: &str| store.hidden.iter().any(|h| h == id);
    let mut out: Vec<ServerEntry> = store
        .custom
        .iter()
        .map(|c| ServerEntry {
            id: c.id.clone(),
            name: c.name.clone(),
            address: c.address.clone(),
            category: None,
            description: None,
            featured: false,
            hidden: hidden(&c.id),
        })
        .collect();
    out.extend(FEATURED.iter().map(|f| ServerEntry {
        id: f.id.into(),
        name: f.name.into(),
        address: f.address.into(),
        category: Some(f.category.into()),
        description: Some(f.description.into()),
        featured: true,
        hidden: hidden(f.id),
    }));
    out
}

/// The name of the server at `address` in Vitra's list (featured or your own), if it's there.
pub(crate) fn name_for(state: &AppState, address: &str) -> Option<String> {
    let same = |a: &str, b: &str| a.trim_end_matches('.').eq_ignore_ascii_case(b.trim_end_matches('.'));
    let (host, port) = split_address(address).ok()?;
    entries(&load_store(state))
        .into_iter()
        .find(|e| {
            split_address(&e.address)
                .map(|(h, p)| same(&h, &host) && p.unwrap_or(25565) == port.unwrap_or(25565))
                .unwrap_or(false)
        })
        .map(|e| e.name)
}

/// `host` or `host:port`; hostnames, IPv4 and bracketed IPv6.
fn split_address(address: &str) -> Result<(String, Option<u16>)> {
    let a = address.trim();
    if a.is_empty() {
        bail!("Enter a server address, like play.example.com");
    }
    if let Some(rest) = a.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').ok_or_else(|| Error::Msg("That address isn't valid.".into()))?;
        let port = match tail.strip_prefix(':') {
            Some(p) => Some(p.parse::<u16>().map_err(|_| Error::Msg("The port must be a number from 1 to 65535.".into()))?),
            None if tail.is_empty() => None,
            None => bail!("That address isn't valid."),
        };
        return Ok((host.to_string(), port));
    }
    let (host, port) = match a.rsplit_once(':') {
        Some((h, p)) => (h, Some(p.parse::<u16>().ok().filter(|p| *p > 0).ok_or_else(|| Error::Msg("The port must be a number from 1 to 65535.".into()))?)),
        None => (a, None),
    };
    let valid = !host.is_empty()
        && host.len() <= 253
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !valid {
        bail!("That address isn't valid. Use something like play.example.com or play.example.com:25565.");
    }
    Ok((host.to_lowercase(), port))
}

fn validate(name: &str, address: &str) -> Result<(String, String)> {
    let name = name.trim();
    if name.is_empty() {
        bail!("Give the server a name.");
    }
    if name.chars().count() > 48 {
        bail!("Keep the name under 48 characters.");
    }
    split_address(address)?;
    Ok((name.to_string(), address.trim().to_string()))
}

#[tauri::command]
pub fn list_servers(state: State<'_, Arc<AppState>>) -> Vec<ServerEntry> {
    entries(&load_store(&state))
}

#[tauri::command]
pub fn add_server(state: State<'_, Arc<AppState>>, name: String, address: String) -> Result<ServerEntry> {
    let (name, address) = validate(&name, &address)?;
    let mut store = load_store(&state);
    if store.custom.iter().any(|c| c.address.eq_ignore_ascii_case(&address)) {
        bail!("{address} is already in your servers.");
    }
    let server = CustomServer { id: uuid::Uuid::new_v4().simple().to_string(), name, address, added_at: util::now_millis() };
    store.custom.insert(0, server.clone());
    save_store(&state, &store)?;
    Ok(entries(&store).into_iter().find(|e| e.id == server.id).expect("just added"))
}

#[tauri::command]
pub fn edit_server(state: State<'_, Arc<AppState>>, id: String, name: String, address: String) -> Result<()> {
    let (name, address) = validate(&name, &address)?;
    let mut store = load_store(&state);
    let Some(server) = store.custom.iter_mut().find(|c| c.id == id) else {
        bail!("That server no longer exists.");
    };
    server.name = name;
    server.address = address;
    save_store(&state, &store)
}

#[tauri::command]
pub fn remove_server(state: State<'_, Arc<AppState>>, id: String) -> Result<()> {
    let mut store = load_store(&state);
    store.custom.retain(|c| c.id != id);
    store.hidden.retain(|h| h != &id);
    save_store(&state, &store)
}

#[tauri::command]
pub fn set_server_hidden(state: State<'_, Arc<AppState>>, id: String, hidden: bool) -> Result<()> {
    let mut store = load_store(&state);
    store.hidden.retain(|h| h != &id);
    if hidden {
        store.hidden.push(id);
    }
    save_store(&state, &store)
}

// ------------------------------------------------------------------ ping

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub latency_ms: u32,
    pub version: String,
    pub protocol: i64,
    pub players_online: i64,
    pub players_max: i64,
    /// Raw `description`: a string with § codes or a chat component.
    pub motd: serde_json::Value,
    /// `data:image/png;base64,...`
    pub favicon: Option<String>,
}

fn write_varint(buf: &mut Vec<u8>, value: i32) {
    let mut v = value as u32;
    loop {
        if v & !0x7F == 0 {
            buf.push(v as u8);
            return;
        }
        buf.push(((v & 0x7F) | 0x80) as u8);
        v >>= 7;
    }
}

fn packet(id: i32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::with_capacity(body.len() + 5);
    write_varint(&mut inner, id);
    inner.extend_from_slice(body);
    let mut out = Vec::with_capacity(inner.len() + 5);
    write_varint(&mut out, inner.len() as i32);
    out.extend(inner);
    out
}

async fn read_varint(stream: &mut TcpStream) -> Result<i32> {
    let mut value: u32 = 0;
    for i in 0..5 {
        let b = stream.read_u8().await?;
        value |= ((b & 0x7F) as u32) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(value as i32);
        }
    }
    bail!("The server sent an invalid response.")
}

/// One shared resolver (it caches answers). Nameservers are queried in
/// parallel with a short timeout: one slow DNS server shouldn't stall the page.
fn resolver() -> Option<&'static hickory_resolver::TokioResolver> {
    static RESOLVER: std::sync::OnceLock<Option<hickory_resolver::TokioResolver>> = std::sync::OnceLock::new();
    RESOLVER
        .get_or_init(|| {
            let mut builder = hickory_resolver::Resolver::builder_tokio().ok()?;
            let opts = builder.options_mut();
            opts.timeout = Duration::from_millis(1200);
            opts.attempts = 1;
            opts.num_concurrent_reqs = 3;
            Some(builder.build())
        })
        .as_ref()
}

/// Where to connect: an explicit port wins, then the `_minecraft._tcp` SRV
/// record (what the game itself checks), then port 25565.
async fn resolve(host: &str, port: Option<u16>) -> (String, u16) {
    if let Some(p) = port {
        return (host.to_string(), p);
    }
    if host.parse::<std::net::IpAddr>().is_err() {
        if let Some(resolver) = resolver() {
            if let Ok(Ok(srv)) = tokio::time::timeout(Duration::from_millis(1500), resolver.srv_lookup(format!("_minecraft._tcp.{host}."))).await {
                if let Some(r) = srv.iter().min_by_key(|r| r.priority()) {
                    let target = r.target().to_utf8();
                    return (target.trim_end_matches('.').to_string(), r.port());
                }
            }
        }
    }
    (host.to_string(), 25565)
}

pub(crate) async fn ping(address: &str) -> Result<ServerStatus> {
    let (host, port) = split_address(address)?;
    let (connect_host, connect_port) = resolve(&host, port).await;

    let mut stream = match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect((connect_host.as_str(), connect_port))).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => bail!("The server refused the connection."),
        Ok(Err(_)) => bail!("Couldn't reach the server. Check the address."),
        Err(_) => bail!("The server didn't answer in time."),
    };
    let _ = stream.set_nodelay(true);

    // Handshake (next state = status), then a status request.
    let mut hs = Vec::new();
    write_varint(&mut hs, -1);
    write_varint(&mut hs, host.len() as i32);
    hs.extend_from_slice(host.as_bytes());
    hs.extend_from_slice(&connect_port.to_be_bytes());
    write_varint(&mut hs, 1);
    let mut out = packet(0x00, &hs);
    out.extend(packet(0x00, &[]));

    let io = async {
        let sent = Instant::now();
        stream.write_all(&out).await?;
        let _len = read_varint(&mut stream).await?;
        let id = read_varint(&mut stream).await?;
        if id != 0x00 {
            bail!("The server sent an unexpected response.");
        }
        let n = read_varint(&mut stream).await?;
        if !(0..=2_000_000).contains(&n) {
            bail!("The server sent an oversized response.");
        }
        let mut json = vec![0u8; n as usize];
        stream.read_exact(&mut json).await?;
        let status_rtt = sent.elapsed();

        // Ping/pong gives a cleaner latency; fall back to the status round trip.
        let started = Instant::now();
        let latency = async {
            stream.write_all(&packet(0x01, &42i64.to_be_bytes())).await?;
            let _ = read_varint(&mut stream).await?;
            let _ = read_varint(&mut stream).await?;
            let _ = stream.read_i64().await?;
            Ok::<_, Error>(started.elapsed())
        };
        let latency = tokio::time::timeout(Duration::from_secs(2), latency).await.ok().and_then(|r| r.ok()).unwrap_or(status_rtt);
        Ok::<_, Error>((json, latency))
    };
    let (json, latency) = tokio::time::timeout(Duration::from_secs(7), io)
        .await
        .map_err(|_| Error::Msg("The server didn't answer in time.".into()))??;

    let v: serde_json::Value = serde_json::from_slice(&json).map_err(|_| Error::Msg("The server sent an unreadable status.".into()))?;
    let favicon = v["favicon"].as_str().filter(|f| f.starts_with("data:image/png;base64,")).map(|f| f.replace('\n', ""));
    Ok(ServerStatus {
        latency_ms: latency.as_millis().min(u32::MAX as u128) as u32,
        version: v["version"]["name"].as_str().unwrap_or("").to_string(),
        protocol: v["version"]["protocol"].as_i64().unwrap_or(-1),
        players_online: v["players"]["online"].as_i64().unwrap_or(0),
        players_max: v["players"]["max"].as_i64().unwrap_or(0),
        motd: v["description"].clone(),
        favicon,
    })
}

#[tauri::command]
pub async fn ping_server(address: String) -> Result<ServerStatus> {
    ping(&address).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints() {
        let mut b = Vec::new();
        write_varint(&mut b, 300);
        assert_eq!(b, vec![0xAC, 0x02]);
        b.clear();
        write_varint(&mut b, -1);
        assert_eq!(b, vec![0xFF, 0xFF, 0xFF, 0xFF, 0x0F]);
    }

    #[test]
    fn addresses() {
        assert_eq!(split_address("Play.Example.com").unwrap(), ("play.example.com".into(), None));
        assert_eq!(split_address("1.2.3.4:25570").unwrap(), ("1.2.3.4".into(), Some(25570)));
        assert_eq!(split_address("[::1]:25565").unwrap(), ("::1".into(), Some(25565)));
        assert!(split_address("bad host").is_err());
        assert!(split_address("host:99999").is_err());
        assert!(split_address("").is_err());
    }

    /// Network check against the featured list: `cargo test -- --ignored live_ping`.
    #[tokio::test]
    #[ignore]
    async fn live_ping() {
        for f in FEATURED {
            match ping(f.address).await {
                Ok(s) => println!("{:<14} {:>4} ms  {:>7}/{:<7} {:<28} favicon={}", f.name, s.latency_ms, s.players_online, s.players_max, s.version.chars().take(28).collect::<String>(), s.favicon.is_some()),
                Err(e) => println!("{:<14} ERROR {e}", f.name),
            }
        }
    }

    #[test]
    fn featured_ids_unique() {
        let mut ids: Vec<_> = FEATURED.iter().map(|f| f.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), FEATURED.len());
    }
}

