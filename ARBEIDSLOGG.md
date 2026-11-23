# Filmtips – struktur og arbeidslogg

Sammendrag av oppsett, arkitektur og utviklingsarbeid. Filmtips er en ikke-kommersiell filmanbefalingsapp for familie og venner. Prosjektet er helt adskilt fra Karmøy-fiskeapp. Bare GitHub/Cloudflare-oppsettet er gjenbrukt som tilnærming.

## Hosting og drift

- **Kode:** GitHub `hallgeiro/filmtips` (public), branch `main`.
- **Deploy:** Cloudflare Workers Builds bygger og deployer automatisk ved push til `main`.
- **Domene:** `filmtips.hallgeirolsen.com` (custom domain via `routes` i `wrangler.jsonc`).
- **Database:** Cloudflare D1 `filmtips` (binding `DB`).
- **Stack:** Cloudflare Workers + statiske assets, Hono (TypeScript), D1 (SQLite), vanilla JS + Tailwind CDN.
- **Secrets** (Settings → *Runtime* variables and secrets, ikke Build-seksjonen): `APP_PASSWORD`, `TMDB_API_KEY`, `ADMIN_PASSWORD`, og valgfritt `OMDB_API_KEY` (gratis, 1000 oppslag/dag). Secrets skal aldri inn i koden, siden repoet er public.
- **Variabel:** `USERS` i `wrangler.jsonc` (`Hallgeir,Eirik,Daniel`). Nye brukere legges til der og pushes.
- **Free plan:** maks 50 subrequests per request. Derfor små TMDB-batcher (8 titler) og `db.batch` mot D1.

## Filstruktur

| Fil | Innhold |
| --- | --- |
| `wrangler.jsonc` | Worker-konfig, D1-binding, assets (`run_worker_first: ["/api/*"]`), custom domain, `USERS` |
| `schema.sql` | Tabellene `recommendations`, `user_pins`, `library` (inkl. `media_type`, `collection`) + indekser |
| `ARBEIDSLOGG.md` | Denne filen: struktur, arbeidsmåte og status |
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
- **Kryssjekk treff (admin):** går gjennom titler uten treff og usikre treff, 3 om gangen (knappen i admin-linjen). Rekkefølge per tittel:
  1. TMDB-søk begrenset til årstallet, pluss varianter (tall → romertall, uten punktum, del før « / ») og TMDB sine alternative titler.
  2. Treffet godtas som sikkert bare hvis utgivelsesår (±2) og regissør fra CLZ stemmer. Mangler regissør, kreves lik tittel og nøyaktig samme år (usikkert treff).
  3. Vanlig tittelmatching (film, så TV), deretter OMDb (IMDb-kode → TMDB), deretter Wikidata (titler på mange språk → IMDb-kode → TMDB). Treff fra disse er alltid «usikre».
  4. Bokssett og samlinger («Collection», «Trilogy», «3 Films» osv.) merkes `collection = 1` og vises som «Samling», ikke som feil.
- **Filmvinduet på mobil:** lukkeknappen (×) ligger utenfor det rullbare området og er alltid synlig. Vinduet starter alltid øverst og bruker `dvh`.

## Viktige API-ruter

- `GET /api/search?q=&type=multi` – TMDB-søk, støtter IMDb-kode
- `GET /api/movie/:id/providers`, `GET /api/tv/:id/providers`
- `GET/POST/DELETE /api/recommendations`
- `GET /api/library`, `GET /api/library/facets`
- `POST /api/admin/library/import`, `.../rematch` (kryssjekk), `.../add`
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
8. Arbeidslogg (denne filen) og OMDb som reserve (`OMDB_API_KEY` satt som secret).
9. Kryssjekk: regissør- og årskontroll, alternative titler, Wikidata og «Samling»-merking. Status etter første kjøring: ca. 30 titler gjenstår å rette manuelt.
10. Mobil-rettelser i filmvinduet (lukkeknapp, scrollposisjon). En feil underveis fjernet midlertidig alle dialoger fra `index.html`. Den ble rettet umiddelbart (commit `88a6ee6`).

## Kjente begrensninger og mulige neste steg

- Rundt 30 titler må rettes manuelt med «Rett match» (IMDb-kode eller TMDB-lenke). Det koster ingen OMDb-oppslag.
- Letterboxd og IMDb har ikke åpent API og brukes ikke direkte. OMDb og Wikidata dekker mye av det samme.
- Free plan tillater maks 50 oppslag per request, så kryssjekken tar bare 3 titler om gangen og kan bruke noen minutter. Siden må stå åpen mens den kjører.
- UPCitemdb-strekkodeoppslag er begrenset til 100 per dag.
- Wrangler CLI kan ikke kjøres lokalt hos bruker (gruppepolicy). Alt gjøres via dashboard og GitHub.
- Ved databaseendringer må `ALTER TABLE` kjøres mot remote D1. `schema.sql` brukes bare for ny database.

## Arbeidsmåte

- **Utvikling:** kode redigeres i arbeidsmappen, sjekkes lokalt (`node --check`, `tsc`, SQLite-tester av spørringer), og pushes til `main`. Workers Builds deployer automatisk.
- **Databaseendringer:** `ALTER TABLE` kjøres mot remote D1 (Cloudflare-connector eller dashboard) *før* koden som bruker kolonnen pushes. `schema.sql` oppdateres samtidig.
- **Secrets og variabler:** settes i Cloudflare-dashboardet under Runtime. `USERS` endres i `wrangler.jsonc`.
- **Etter deploy:** vent 1–2 minutter, last siden på nytt (lukk fanen på mobil ved cache-problemer).
- **Commits:** korte norske meldinger, én endring per commit. Pass på at store søk-og-erstatt-skript ikke treffer flere steder enn tiltenkt (se punkt 10 i kronologien).
- **Admin-rutiner:** importer CLZ-CSV (8 titler om gangen), kjør «Kryssjekk treff», se gjennom «⚠ Å sjekke», rett resten med «Rett match», legg til enkeltfilmer med strekkode eller tittelsøk.
