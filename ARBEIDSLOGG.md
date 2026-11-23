# Filmtips – struktur og arbeidslogg

Sammendrag av oppsett, arkitektur og utviklingsarbeid. Filmtips er en ikke-kommersiell filmanbefalingsapp for familie og venner. Prosjektet er helt adskilt fra Karmøy-fiskeapp. Bare GitHub/Cloudflare-oppsettet er gjenbrukt som tilnærming.

## Hosting og drift

- **Kode:** GitHub `hallgeiro/filmtips` (public), branch `main`.
- **Deploy:** Cloudflare Workers Builds bygger og deployer automatisk ved push til `main`.
- **Domene:** `filmtips.hallgeirolsen.com` (custom domain via `routes` i `wrangler.jsonc`).
- **Database:** Cloudflare D1 `filmtips` (binding `DB`).
- **Stack:** Cloudflare Workers + statiske assets, Hono (TypeScript), D1 (SQLite), vanilla JS + Tailwind CDN.
- **Secrets** (Settings → *Runtime* variables and secrets, ikke Build-seksjonen): `APP_PASSWORD`, `TMDB_API_KEY`, `ADMIN_PASSWORD`.
- **Variabel:** `USERS` i `wrangler.jsonc` (`Hallgeir,Eirik,Daniel`). Nye brukere legges til der og pushes.
- **Free plan:** maks 50 subrequests per request. Derfor små TMDB-batcher (8 titler) og `db.batch` mot D1.

## Filstruktur

| Fil | Innhold |
| --- | --- |
| `wrangler.jsonc` | Worker-konfig, D1-binding, assets (`run_worker_first: ["/api/*"]`), custom domain, `USERS` |
| `schema.sql` | Tabellene `recommendations`, `user_pins`, `library` + indekser |
| `src/index.ts` | Hele backend (Hono): auth, TMDB-søk, anbefalinger, bibliotek, admin |
| `public/index.html` | UI: login, faner (Søk / Anbefalinger / Bibliotek), modaler |
| `public/app.js` | Frontend-logikk |
| `README.md` | Oppsett og API-oversikt |
| `.dev.vars.example` | Mal for lokale secrets |

## Autentisering

- Felles passord gir en HMAC-signert sesjonscookie (`filmtips_session`).
- Hver bruker har en PIN, lagret som PBKDF2-SHA256 (100k iterasjoner + salt). Etter 5 feil er brukeren låst i 15 minutter. Feil PIN gir 403.
- Identitetscookie `filmtips_user` er signert og knyttet til PIN-hashen.
- Admin (Hallgeir) logger inn med `ADMIN_PASSWORD` (cookie `filmtips_admin`). Admin kan slette alles anbefalinger og velge hvilket navn som helst. Andre kan bare legge inn og slette egne.

## Funksjoner

- **Søk (TMDB):** norske titler, strømmetjenester i Norge (JustWatch via TMDB), også IMDb-kode eller -lenke.
- **Anbefalinger:** terningkast 1–6, kommentar, én anbefaling per bruker per film. Gjelder kun filmer.
- **Bibliotek:** importert fra CLZ Movies (CSV), adskilt fra anbefalinger. Formater (Blu-ray, 4K UHD, DVD, Digital) vises. Anbefalte filmer som finnes i biblioteket merkes med format.
- **Sortering og filter:** tittel, år (nyest/eldst), regissør, tiår, format og regissør.
- **Rett match (admin):** korriger feil TMDB-treff, også med IMDb-kode eller TMDB-lenke.
- **Legg til enkeltfilm (admin):** strekkodeskanning (html5-qrcode + UPCitemdb) eller tittelsøk.
- **TV-serier:** `media_type` `movie`/`tv` i biblioteket, egen providers-rute, «TV»-merking.
- **Bedre titteloppslag:** fjerner «: Season N», «Complete Series», «Extended», «Director's Cut» osv. før søk. Prøver film først, så TV.
- **Match på nytt (admin):** går gjennom titler uten treff, 8 om gangen.

## Viktige API-ruter

- `GET /api/search?q=&type=multi` – TMDB-søk, støtter IMDb-kode
- `GET /api/movie/:id/providers`, `GET /api/tv/:id/providers`
- `GET/POST/DELETE /api/recommendations`
- `GET /api/library`, `GET /api/library/facets`
- `POST /api/admin/library/import`, `.../rematch`, `.../add`
- `PATCH /api/admin/library/:id`
- `GET /api/admin/barcode/:code`
- `POST /api/login`, `/api/identity`, `/api/admin/login`, `/api/admin/reset-pin`

## Kronologi

1. Scaffold av prosjektet etter spesifikasjon, med klar separasjon fra fiskeapp-prosjektet.
2. GitHub-repo og Cloudflare-tilkobling, D1 opprettet, secrets satt (feilsøkt: de lå først i Build-seksjonen).
3. Flyttet fra `*.karmoy-fiskeapp.workers.dev` til eget domene.
4. Brukerstyring: admin-sletting, kun egne anbefalinger, PIN per bruker.
5. CLZ-import av ca. 2800 titler, med formatvisning på anbefalinger.
6. Rett match, strekkodeskanning, sortering på år/tiår/regissør.
7. TV-serier, bedre titteloppslag, IMDb-kodesøk og «Match på nytt» (commit `bd14fd8`).

## Kjente begrensninger og mulige neste steg

- Titler som bokssett og samlinger blir trolig fortsatt uten treff og må rettes manuelt.
- Mulig reserve: OMDb (gratis nøkkel, 1000 kall/dag) hvis mange titler blir stående uten treff.
- UPCitemdb-strekkodeoppslag er begrenset til 100 per dag.
- Wrangler CLI kan ikke kjøres lokalt hos bruker (gruppepolicy). Alt gjøres via dashboard og GitHub.
- Ved databaseendringer må `ALTER TABLE` kjøres mot remote D1. `schema.sql` brukes bare for ny database.
