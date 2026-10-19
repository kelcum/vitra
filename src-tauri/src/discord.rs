use std::io;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
const CLOSE: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;
const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAME: usize = 1 << 20;

#[cfg(windows)]
type Pipe = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(unix)]
type Pipe = tokio::net::UnixStream;

pub struct Client {
    pipe: Pipe,
}

#[cfg(windows)]
async fn open(index: u8) -> io::Result<Pipe> {
    tokio::net::windows::named_pipe::ClientOptions::new().open(format!(r"\\.\pipe\discord-ipc-{index}"))
}

#[cfg(unix)]
async fn open(index: u8) -> io::Result<Pipe> {
    let dirs = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .chain(std::iter::once("/tmp".to_string()));
    let mut last = io::Error::from(io::ErrorKind::NotFound);
    for dir in dirs {
        for sub in ["", "app/com.discordapp.Discord/", "snap.discord/"] {
            match tokio::net::UnixStream::connect(format!("{dir}/{sub}discord-ipc-{index}")).await {
                Ok(s) => return Ok(s),
                Err(e) => last = e,
            }
        }
    }
    Err(last)
}

impl Client {
    pub async fn connect(app_id: &str) -> io::Result<Self> {
        let mut last = io::Error::new(io::ErrorKind::NotFound, "Discord isn't running");
        for index in 0..10 {
            match open(index).await {
                Ok(pipe) => {
                    let mut client = Client { pipe };
                    client.send(HANDSHAKE, &json!({ "v": 1, "client_id": app_id })).await?;
                    let (op, reply) = client.recv().await?;
                    if op == FRAME && reply["evt"] == "READY" {
                        return Ok(client);
                    }
                    let why = reply["message"].as_str().or_else(|| reply["data"]["message"].as_str()).unwrap_or("no reason given");
                    return Err(io::Error::new(io::ErrorKind::ConnectionRefused, format!("Discord refused the connection: {why}")));
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    pub async fn set_activity(&mut self, activity: Option<&Value>) -> io::Result<()> {
        let nonce = uuid::Uuid::new_v4().to_string();
        let args = json!({ "pid": std::process::id(), "activity": activity });
        self.send(FRAME, &json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": nonce })).await?;
        loop {
            let (op, msg) = self.recv().await?;
            match op {
                FRAME if msg["nonce"] == nonce.as_str() => {
                    if msg["evt"] == "ERROR" {
                        let why = msg["data"]["message"].as_str().unwrap_or("Discord rejected the status");
                        return Err(io::Error::new(io::ErrorKind::InvalidInput, why.to_string()));
                    }
                    return Ok(());
                }
                PING => self.send(PONG, &msg).await?,
                CLOSE => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "Discord closed the connection")),
                _ => {}
            }
        }
    }

    async fn send(&mut self, op: u32, payload: &Value) -> io::Result<()> {
        let frame = encode(op, payload)?;
        tokio::time::timeout(TIMEOUT, self.pipe.write_all(&frame))
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
    }

    async fn recv(&mut self) -> io::Result<(u32, Value)> {
        let read = async {
            let mut head = [0u8; 8];
            self.pipe.read_exact(&mut head).await?;
            let (op, len) = decode_head(head)?;
            let mut body = vec![0u8; len];
            self.pipe.read_exact(&mut body).await?;
            Ok((op, serde_json::from_slice(&body).unwrap_or(Value::Null)))
        };
        tokio::time::timeout(TIMEOUT, read).await.map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
    }
}

fn encode(op: u32, payload: &Value) -> io::Result<Vec<u8>> {
    let body = serde_json::to_vec(payload)?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

fn decode_head(head: [u8; 8]) -> io::Result<(u32, usize)> {
    let op = u32::from_le_bytes([head[0], head[1], head[2], head[3]]);
    let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Discord sent an oversized frame"));
    }
    Ok((op, len))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let frame = encode(FRAME, &json!({ "cmd": "SET_ACTIVITY" })).unwrap();
        let head: [u8; 8] = frame[..8].try_into().unwrap();
        let (op, len) = decode_head(head).unwrap();
        assert_eq!(op, FRAME);
        assert_eq!(len, frame.len() - 8);
        let body: Value = serde_json::from_slice(&frame[8..]).unwrap();
        assert_eq!(body["cmd"], "SET_ACTIVITY");
    }

    #[tokio::test]
    #[ignore]
    async fn live_discord() {
        let id = std::env::var("VITRA_DISCORD_ID").unwrap_or_else(|_| "1".into());
        match Client::connect(&id).await {
            Ok(mut c) => {
                c.set_activity(Some(&json!({ "details": "Testing Vitra", "state": "Rich Presence test" }))).await.unwrap();
                tokio::time::sleep(Duration::from_secs(8)).await;
                c.set_activity(None).await.unwrap();
                println!("connected, showed and cleared a status");
            }
            Err(e) => println!("{:?}: {e}", e.kind()),
        }
    }

    #[test]
    fn oversized_frames_are_refused() {
        let mut head = [0u8; 8];
        head[4..].copy_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert!(decode_head(head).is_err());
    }
}
