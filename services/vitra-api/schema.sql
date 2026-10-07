-- Vitra cosmetics: who uses Vitra, and which cape they wear.

CREATE TABLE IF NOT EXISTS users (
  uuid      TEXT PRIMARY KEY,          -- Minecraft UUID, 32 lowercase hex characters
  name      TEXT NOT NULL,
  cape      TEXT,                      -- capes.id, or NULL for none
  created   INTEGER NOT NULL,          -- ms since epoch
  last_seen INTEGER NOT NULL DEFAULT 0 -- last ping from the game, ms since epoch
);

CREATE TABLE IF NOT EXISTS capes (
  id      TEXT PRIMARY KEY,            -- first 20 hex chars of the image's SHA-256
  png     BLOB NOT NULL,               -- frames stacked top to bottom, each a cape texture (2:1)
  w       INTEGER NOT NULL,
  h       INTEGER NOT NULL,
  frames  INTEGER NOT NULL,
  delay   INTEGER NOT NULL,            -- ms per frame
  owner   TEXT NOT NULL,               -- uploader's UUID, or 'preset'
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS capes_owner ON capes (owner, created);

CREATE TABLE IF NOT EXISTS presets (
  slug  TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  cape  TEXT NOT NULL,                 -- capes.id
  sort  INTEGER NOT NULL DEFAULT 0
);
