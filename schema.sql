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
  director_sort TEXT,                      -- første regissør som 'Etternavn, Fornavn' (for sortering)
  match       TEXT    NOT NULL DEFAULT 'none' CHECK (match IN ('exact', 'fuzzy', 'none')),
  UNIQUE (title, year)
);
CREATE INDEX IF NOT EXISTS idx_library_tmdb ON library (tmdb_id);
CREATE INDEX IF NOT EXISTS idx_library_title ON library (title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_library_barcode ON library (barcode);
-- Eksisterende database uten kolonnene: ALTER TABLE library ADD COLUMN barcode TEXT; ALTER TABLE library ADD COLUMN director_sort TEXT; ALTER TABLE library ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie';
