-- Kjør: npm run db:setup (lokalt)  |  npm run db:setup:remote (produksjon)
CREATE TABLE IF NOT EXISTS recommendations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id     INTEGER NOT NULL,
  title       TEXT    NOT NULL,
  poster_path TEXT,
  username    TEXT    NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),  -- karakter 1–10 (var 1–6 terningkast før)
  comment     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Hver person har én anbefaling per film (kan oppdateres)
  UNIQUE (tmdb_id, username)
);

CREATE INDEX IF NOT EXISTS idx_recommendations_created ON recommendations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendations_tmdb ON recommendations (tmdb_id);

-- Karakterer 1–10: alle brukere, film og TV. Karakter i en anbefaling lagres også her.
CREATE TABLE IF NOT EXISTS ratings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT    NOT NULL DEFAULT 'movie',         -- 'movie' eller 'tv'
  title       TEXT    NOT NULL,
  poster_path TEXT,
  username    TEXT    NOT NULL,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 10),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tmdb_id, media_type, username)
);

-- Sett film: avkrysning uten karakter. Å gi karakter regnes alltid som sett (raden opprettes automatisk).
CREATE TABLE IF NOT EXISTS seen_films (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id     INTEGER NOT NULL,
  media_type  TEXT    NOT NULL DEFAULT 'movie',
  title       TEXT    NOT NULL,
  year        TEXT,
  poster_path TEXT,
  username    TEXT    NOT NULL,
  seen_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  how         TEXT,                                    -- utgått: bruk viewings
  seen_on     TEXT,                                    -- utgått: bruk viewings
  UNIQUE (tmdb_id, media_type, username)
);
-- Eksisterende database: ALTER TABLE seen_films ADD COLUMN how TEXT; ALTER TABLE seen_films ADD COLUMN seen_on TEXT;
CREATE INDEX IF NOT EXISTS idx_seen_user ON seen_films (username, seen_at DESC);

-- Visninger: en film kan sees flere ganger. Hver visning har egen måte og dato (begge valgfrie).
CREATE TABLE IF NOT EXISTS viewings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT    NOT NULL DEFAULT 'movie',
  username   TEXT    NOT NULL,
  how        TEXT,                                     -- kino, streaming, bluray, 4k, dvd, fil, tv, annet
  seen_on    TEXT,                                     -- YYYY-MM-DD
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_viewings_film ON viewings (tmdb_id, media_type, username);

-- Kommentarer på andres (og egne) anbefalinger
CREATE TABLE IF NOT EXISTS rec_comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rec_id     INTEGER NOT NULL,                       -- recommendations.id
  username   TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rec_comments_rec ON rec_comments (rec_id, created_at);

-- Filmlister: brukerne lager egne lister (f.eks. favoritter, film noir), rangerte eller ikke
CREATE TABLE IF NOT EXISTS film_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  description TEXT,
  ranked      INTEGER NOT NULL DEFAULT 0,              -- 1 = rangert (nummerert)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS film_list_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id    INTEGER NOT NULL,                         -- film_lists.id
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT    NOT NULL DEFAULT 'movie',         -- 'movie' eller 'tv'
  title      TEXT    NOT NULL,
  year       TEXT,
  poster_path TEXT,
  position   INTEGER NOT NULL,
  added_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (list_id, tmdb_id, media_type)
);
CREATE INDEX IF NOT EXISTS idx_film_lists_user ON film_lists (username);
CREATE INDEX IF NOT EXISTS idx_film_list_items_list ON film_list_items (list_id, position);

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

-- Påmelding til filmkveld: ett svar per bruker per kveld (yes / maybe / no). Ikke svart = ingen rad.
CREATE TABLE IF NOT EXISTS night_rsvps (
  night_id   INTEGER NOT NULL,
  username   TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('yes','maybe','no')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (night_id, username)
);
