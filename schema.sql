-- Kjør: npm run db:setup (lokalt)  |  npm run db:setup:remote (produksjon)
CREATE TABLE IF NOT EXISTS recommendations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id     INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  poster_path TEXT,
  username    TEXT    NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 6),
  comment     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Hver person har én anbefaling per film (kan oppdateres)
  UNIQUE (tmdb_id, username)
);

CREATE INDEX IF NOT EXISTS idx_recommendations_created ON recommendations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_tmdb ON recommendations (tmdb_id);

-- PIN per bruker (PBKDF2-hash, aldri klartekst). Låser i 15 min etter 5 feil forsøk.
CREATE TABLE IF NOT EXISTS user_pins (
  username        TEXT PRIMARY KEY,
  pin_hash        TEXT    NOT NULL,
  salt            TEXT    NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
