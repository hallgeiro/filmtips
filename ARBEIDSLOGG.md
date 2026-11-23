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
| `schema.sql` | Tabellene `recommendations`, `user_pins`, `library` (inkl. `media_type`, `collection`), `movie_nights`, `wishes`, `wish_votes` + indekser |
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
- **Fysisk bibliotek og filsamling:** bytte øverst i Bibliotek-fanen. Filsamling = filmer med format `Digital` (vises som «Fil»). Samme film kan være i begge. Neste steg ved behov: egne felt for filer (kvalitet, lagringssted).
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
- **Filmkveld:** admin oppretter en kveld (tittel, dato, notat). Alle brukere legger inn ønsker via TMDB-søk (maks 3 per person per kveld, filmer fra biblioteket merkes med format) og kan gi 👍 til andres ønsker. Ønsket får forslagsstillerens stemme automatisk. Admin velger vinner, som avslutter kvelden (kan åpnes igjen). Uten admin kan man bare ønske og stemme som seg selv, og slette egne ønsker. Tabeller: `movie_nights`, `wishes`, `wish_votes`.
- **Filmvinduet på mobil:** lukkeknappen (×) ligger utenfor det rullbare området og er alltid synlig. Vinduet starter alltid øverst og bruker `dvh`.

## Viktige API-ruter

- `GET /api/search?q=&type=multi` – TMDB-søk, støtter IMDb-kode
- `GET /api/movie/:id/providers`, `GET /api/tv/:id/providers`
- `GET/POST/DELETE /api/recommendations`
- `GET /api/library`, `GET /api/library/facets`
- `POST /api/admin/library/import`, `.../rematch` (kryssjekk), `.../add`
- `PATCH /api/admin/library/:id`
- `GET /api/admin/barcode/:code`
- `POST /api/pin-login`, `/api/identity`, `/api/admin/login`, `/api/admin/reset-pin`

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

11. Filmkveld: ønsker og avstemning (tabeller opprettet i remote D1 før koden ble pushet).

12. Bibliotek delt i fysisk bibliotek og filsamling.

13. Innlogging: gyldig PIN-identitet (`filmtips_user`) gir nå også tilgang, og passord-økten fornyes ved bruk (`/api/config`). Logg ut fjerner begge cookiene. Passord kreves bare på ny enhet, ved slettede cookies eller etter passordbytte.

14. PIN som passord: på innloggingsskjermen kan navn med PIN logge inn med navn + 6-sifret PIN (`POST /api/pin-login`, `GET /api/login-info`), uten felles passord. Sperre: 5 feil forsøk gir 15 min lås. Nye PIN-er må være 6 siffer (første PIN for et navn krever fortsatt felles passord). Eldre 4–5-sifrede PIN-er virker bare etter passordinnlogging; admin kan nullstille dem for å få 6 siffer.

15. Admin kan lage PIN: velger admin et navn uten PIN, tilbys det å lage PIN (tidligere ble admin aldri spurt). «Nullstill PIN» tømmer valgt navn, så navnet må velges på nytt for å lage ny PIN.

16. Innloggingsskjermen: navn velges først. Navn med PIN får PIN-felt (med lenke til passord), navn uten PIN får passordfelt og blir spurt om å lage 6-sifret PIN rett etter innlogging. `GET /api/login-info` returnerer `users` og `pinUsers`. Sist valgte navn huskes i localStorage.

17. Felles passord fjernet: kun navn + 6-sifret PIN. `POST /api/pin-login` logger inn, eller lager PIN (`create: true`) for navn uten PIN. `/api/*` krever gyldig PIN-identitet eller admin-cookie. `/api/login` og passord-cookien `filmtips_session` er borte. `APP_PASSWORD` er nå bare signeringsnøkkel for cookies (ikke fjern den). Risiko: første som velger et ledig navn får det; admin kan nullstille.

18. Biblioteket: tiårsfilteret er en nedtrekksliste (`#lib-decades`) i stedet for knapper, for å spare plass på mobil.

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
