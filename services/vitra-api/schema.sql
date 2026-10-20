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

CREATE TABLE IF NOT EXISTS badge_requests (
  id         TEXT PRIMARY KEY,
  discord    TEXT NOT NULL,
  name       TEXT NOT NULL,
  badge      TEXT NOT NULL,
  colors     TEXT NOT NULL,
  details    TEXT NOT NULL,
  image      BLOB,
  image_type TEXT,
  source     TEXT NOT NULL,
  ip         TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  created    INTEGER NOT NULL,
  posted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS badge_requests_ip ON badge_requests (ip, created);
CREATE INDEX IF NOT EXISTS badge_requests_discord ON badge_requests (discord, status);
CREATE INDEX IF NOT EXISTS badge_requests_posted ON badge_requests (posted, created);
