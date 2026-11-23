# Filmtips

Ikke-kommersiell filmanbefalingsapp for familie og venner. Hono på Cloudflare Workers, D1 (SQLite), statiske filer med Tailwind via CDN.

> Dette prosjektet er helt separat fra andre prosjekter (f.eks. Karmøy-fiskeapp). Egen Worker (`filmtips`), egen D1-database (`filmtips`), egne hemmeligheter og eget repo/mappe. Ikke gjenbruk `database_id` eller secrets fra andre prosjekter.

## Oppsett

```bash
npm install
npx wrangler login
npx wrangler d1 create filmtips        # lim inn database_id i wrangler.jsonc
cp .dev.vars.example .dev.vars         # fyll inn APP_PASSWORD og TMDB_API_KEY
npm run dev                            # oppretter tabellen lokalt (db:setup) og starter på http://localhost:8787
```

TMDB-nøkkel: gratis på https://www.themoviedb.org/settings/api (både v3-nøkkel og Read Access Token fungerer).

## Utrulling

```bash
npm run db:setup:remote
npx wrangler secret put APP_PASSWORD
npx wrangler secret put TMDB_API_KEY
npm run deploy
```

Navnene i nedtrekkslisten settes i `wrangler.jsonc` under `vars.USERS` (kommaseparert).

## API

Alle `/api/*`-ruter unntatt `/api/login` krever innloggingscookie.

| Rute | Beskrivelse |
|---|---|
| `POST /api/login` | `{password}` setter økt-cookie |
| `POST /api/logout` | sletter cookie |
| `GET /api/config` | liste over navn |
| `GET /api/search?q=` | filmsøk (TMDB, norsk) |
| `GET /api/movie/:id/providers` | strømmetjenester i Norge |
| `GET /api/recommendations[?tmdb_id=]` | hent anbefalinger |
| `POST /api/recommendations` | lagre/oppdater (én per person per film) |
| `DELETE /api/recommendations/:id?username=` | slett egen anbefaling (admin kan slette alle) |
| `POST /api/identity` | `{username, pin}` velger navn. Første gang opprettes PIN-en, deretter må den oppgis |
| `GET /api/library[?q=&format=&tmdb_id=]` | bibliotek (importert fra CLZ), adskilt fra anbefalinger |
| `POST /api/admin/library/import` | (admin) importerer opptil 20 filmer om gangen, matcher mot TMDB |
| `POST /api/admin/reset-pin` | `{username}` (admin) fjerner PIN slik at den kan lages på nytt |
| `POST /api/admin/login` / `logout` | `{password}` mot `ADMIN_PASSWORD` gir admin-cookie |

## Merknader

- Admin: sett secret `ADMIN_PASSWORD`. Trykk «Admin» øverst i appen og skriv passordet for å kunne slette andres anbefalinger. Uten admin kan man bare slette egne (tillitsbasert på valgt navn).
- PIN: hver bruker lager en PIN (4–6 siffer) første gang de velger navnet sitt. PIN lagres som PBKDF2-hash i tabellen `user_pins`, med lås i 15 minutter etter 5 feil forsøk. Uten admin kan man bare anbefale og slette som navnet man har logget inn som. Glemt PIN: admin trykker «Nullstill PIN». Kjør `npm run db:setup:remote` (eller kjør `schema.sql` mot D1) når tabellen `user_pins` mangler.
- Sikkerheten er bevisst enkel (felles passord, tillitsbasert navnevalg), tilpasset familie og venner.
- TMDB krever attribusjon. Strømdata kommer fra JustWatch. Begge er kreditert i bunnteksten.
- Bibliotek: som admin trykker du «Importer CLZ-CSV…» og velger eksportfilen fra CLZ Movies (kolonnene Title og Format kreves). Filmer matches mot TMDB på tittel og år, og samme film i flere formater slås sammen. Importen kan kjøres på nytt uten duplikater. Anbefalte filmer som finnes i biblioteket merkes med formatet.
