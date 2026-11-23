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

-- Kommentarer på andres (og egne) anbefalinger
CREATE TABLE IF NOT EXISTS rec_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rec_id     INTEGER NOT NULL,                       -- recommendations.id
  username   TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_comments_rec ON rec_comments (rec_id, created_at);

-- PIN per bruker (PBKDF2-hash, aldri klartekst). Låser i 15 min etter 5 feil forsøk.
CREATE TABLE IF NOT EXISTS user_pins (
  username        TEXT PRIMARY KEY,
  pin_hash        TEXT    NOT NULL,
  salt            TEXT    NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Bibliotek importert fra CLZ Movies (egne filmer, adskilt fra anbefalinger)
CREATE TABLE IF NOT EXISTS library (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  year        INTEGER NOT NULL DEFAULT 0,
  formats     TEXT    NOT NULL,            -- f.eks. '4K UHD|Blu-ray'
  genres      TEXT,
  runtime     INTEGER,
  director    TEXT,
  distributor TEXT,
  added_date  TEXT,
  tmdb_id     INTEGER,                     -- NULL = ikke matchet mot TMDB ennå
  tmdb_title  TEXT,
  poster_path TEXT,
  barcode     TEXT,                        -- EAN/UPC fra skanning (valgfri)
  media_type  TEXT    NOT NULL DEFAULT 'movie',   -- 'movie' eller 'tv' (TMDB-id er bare unik innen hver type)
  collection  INTEGER NOT NULL DEFAULT 0,          -- 1 = bokssett/samling, ikke én film
  director_sort TEXT,                      -- første regissør som 'Etternavn, Fornavn' (for sortering)
  match       TEXT    NOT NULL DEFAULT 'none' CHECK (match IN ('exact', 'fuzzy', 'none')),
  UNIQUE (title, year)
);
CREATE INDEX IF NOT EXISTS idx_library_tmdb ON library (tmdb_id);
CREATE INDEX IF NOT EXISTS idx_library_title ON library (title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_library_barcode ON library (barcode);
-- Eksisterende database uten kolonnene: ALTER TABLE library ADD COLUMN barcode TEXT; ALTER TABLE library ADD COLUMN director_sort TEXT; ALTER TABLE library ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'; ALTER TABLE library ADD COLUMN collection INTEGER NOT NULL DEFAULT 0;

-- Filmkveld: admin oppretter kvelder, brukerne legger inn ønsker og stemmer
CREATE TABLE IF NOT EXISTS movie_nights (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  date           TEXT    NOT NULL,                       -- YYYY-MM-DD
  note           TEXT,
  status         TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  winner_wish_id INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wishes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  night_id    INTEGER NOT NULL,
  tmdb_id     INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  year        INTEGER,
  poster_path TEXT,
  username    TEXT    NOT NULL,
  comment     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (night_id, tmdb_id)
);
CREATE TABLE IF NOT EXISTS wish_votes (
  wish_id  INTEGER NOT NULL,
  username TEXT    NOT NULL,
  PRIMARY KEY (wish_id, username)
);
CREATE INDEX IF NOT EXISTS idx_wishes_night ON wishes(night_id);
