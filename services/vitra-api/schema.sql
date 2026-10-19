CREATE TABLE IF NOT EXISTS users (
  uuid      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  cape      TEXT,
  created   INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS capes (
  id      TEXT PRIMARY KEY,
  png     BLOB NOT NULL,
  w       INTEGER NOT NULL,
  h       INTEGER NOT NULL,
  frames  INTEGER NOT NULL,
  delay   INTEGER NOT NULL,
  owner   TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS capes_owner ON capes (owner, created);

CREATE TABLE IF NOT EXISTS presets (
  slug  TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  cape  TEXT NOT NULL,
  sort  INTEGER NOT NULL DEFAULT 0
);
