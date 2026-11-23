# Filmtips – struktur og arbeidslogg

Sammendrag av oppsett, arkitektur og utviklingsarbeid. Filmtips er en ikke-kommersiell filmanbefalingsapp for familie og venner. Prosjektet er helt adskilt fra Karmøy-fiskeapp. Bare GitHub/Cloudflare-oppsettet er gjenbrukt som tilnærming.

## Hosting og drift

- **Kode:** GitHub `hallgeiro/filmtips` (public), branch `main`.
- **Deploy:** Cloudflare Workers Builds bygger og deployer automatisk ved push til `main`.
- **Domene:** `filmtips.hallgeirolsen.com` (custom domain via `routes` i `wrangler.jsonc`).
- **Database:** Cloudflare D1 `filmtips` (binding `DB`).
- **Stack:** Cloudflare Workers + statiske assets, Hono (TypeScript), D1 (SQLite), vanilla JS + Tailwind CDN.
- **Secrets** (Settings → *Runtime* variables and secrets, ikke Build-seksjonen): `APP_PASSWORD` (bare signeringsnøkkel for cookies, ikke et innloggingspassord), `TMDB_API_KEY`, `ADMIN_PASSWORD`, og valgfritt `OMDB_API_KEY` (gratis, 1000 oppslag/dag). Secrets skal aldri inn i koden, siden repoet er public.
- **Variabel:** `USERS` i `wrangler.jsonc` (`Hallgeir,Eirik,Daniel`). Nye brukere legges til der og pushes.
- **Free plan:** maks 50 subrequests per request. Derfor små TMDB-batcher (8 titler) og `db.batch` mot D1.

## Filstruktur

| Fil | Innhold |
| --- | --- |
| `wrangler.jsonc` | Worker-konfig, D1-binding, assets (`run_worker_first: ["/api/*"]`), custom domain, `USERS` |
| `schema.sql` | Tabellene `recommendations`, `ratings`, `rec_comments`, `film_lists`, `film_list_items`, `user_pins`, `library` (inkl. `media_type`, `collection`), `movie_nights`, `wishes`, `wish_votes` + indekser |
| `ARBEIDSLOGG.md` | Denne filen: struktur, arbeidsmåte og status |
| `src/index.ts` | Hele backend (Hono): auth, TMDB-søk, anbefalinger, bibliotek, admin |
| `public/index.html` | UI: login, faner (Søk / Anbefalinger / Bibliotek), modaler |
| `public/app.js` | Frontend-logikk |
| `README.md` | Oppsett og API-oversikt |
| `.dev.vars.example` | Mal for lokale secrets |

## Autentisering

- Ingen felles passord. Innlogging er navn + 6-sifret PIN (`POST /api/pin-login`). Første som velger et navn uten PIN lager den (`create: true`, skrives to ganger). Admin kan nullstille.
- PIN lagres som PBKDF2-SHA256 (100k iterasjoner + salt). Etter 5 feil er brukeren låst i 15 minutter. Feil PIN gir 403. Eldre PIN-er på 4–5 siffer virker bare via `/api/identity` og bør nullstilles.
- Identitetscookie `filmtips_user` (365 dager) er HMAC-signert med `APP_PASSWORD` og knyttet til PIN-hashen, så nullstilt PIN ugyldiggjør den. Alle `/api/*`-ruter krever gyldig identitet eller admin-cookie.
- Innloggingsskjermen velger navn først (`GET /api/login-info`), viser PIN-felt for navn med PIN og «Lag PIN» (to felt) for navn uten.
- Admin (Hallgeir) logger inn via «Admin» i appen med `ADMIN_PASSWORD` (cookie `filmtips_admin`). Admin kan slette alles anbefalinger og velge hvilket navn som helst (og blir tilbudt å lage PIN for navn uten). Andre kan bare legge inn og slette egne.

## Funksjoner

- **Søk (TMDB):** norske titler, strømmetjenester i Norge (JustWatch via TMDB), også IMDb-kode eller -lenke.
- **Anbefalinger:** karakter 1–10 (vises som ⭐ 8/10), kommentar, én anbefaling per bruker per film. Gjelder kun filmer.
- **Bibliotek:** importert fra CLZ Movies (CSV), adskilt fra anbefalinger. Formater (Blu-ray, 4K UHD, DVD, Digital) vises. Anbefalte filmer som finnes i biblioteket merkes med format.
- **Fysisk bibliotek og filsamling:** bytte øverst i Bibliotek-fanen. Filsamling = filmer med format `Digital` (vises som «Fil»). Samme film kan være i begge. Neste steg ved behov: egne felt for filer (kvalitet, lagringssted).
- **Sortering og filter:** tittel, år (nyest/eldst), regissør, tiår (nedtrekksliste), format og regissør.
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
- `GET/POST/DELETE /api/recommendations`, `/api/lists` (+ `/api/lists/:id/items`)
- `GET /api/library`, `GET /api/library/facets`
- `POST /api/admin/library/import`, `.../rematch` (kryssjekk), `.../add`
- `PATCH /api/admin/library/:id`
- `GET /api/admin/barcode/:code`
- `POST /api/pin-login`, `GET /api/login-info`, `/api/identity`, `/api/admin/login`, `/api/admin/reset-pin`

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

19. Biblioteket: valg mellom bildegalleri og liste (knapp ▦/☰ ved søkefeltet, valget huskes i localStorage). Listevisning har liten plakat, tittel, år/format og regissør på én rad.

20. Liste/galleri-valget gjelder nå også Søk-fanen (egen knapp ved søkefeltet). Valget er felles for Søk og Bibliotek og huskes i localStorage.

21. Kommentarer på anbefalinger: tabell `rec_comments` (opprettet i remote D1 før push). «💬 Kommenter» under hver anbefaling i Feed og i filmvinduet åpner en tråd. Alle innloggede kan kommentere alles anbefalinger (maks 500 tegn), slette egne (admin alle). Slettes en anbefaling, slettes kommentarene også. `schema.sql` er oppdatert.

22. Filmlister: ny fane «Lister». Tabeller `film_lists` og `film_list_items` (opprettet i remote D1 før push). Brukerne lager lister (rangert eller ikke, med beskrivelse), alle ser alle, eieren/admin endrer. Filmer legges til via søk som slår opp i både biblioteket (`/api/library`) og TMDB (`/api/search`). Biblioteksfilmer uten TMDB-treff kan ikke legges i lister. Rangerte lister har ▲/▼ (`POST .../move`). Fanelinjen kan rulles sideveis.

23. Filmvinduet har «Mine lister»: nedtrekksliste med egne lister (lister som allerede har filmen er avmerket) og «Ny liste…» som lager listen og legger filmen inn i ett steg. Gjelder både film og TV, fra Søk, Bibliotek, Feed og lister. `GET /api/lists?tmdb_id=&media_type=` gir `has_item` per liste.

24. Karakter 1–10 i stedet for terningkast 1–6. Gamle karakterer er omregnet (1→2, 2→3, 3→5, 4→7, 5→8, 6→10). Tabellen `recommendations` ble bygget om i remote D1 (CHECK-sperren kan ikke endres med ALTER): ny tabell med CHECK 1–10, kopiert data, droppet gammel, rename, indekser på nytt.

25. Karakter uten anbefaling: tabell `ratings` (tmdb_id, media_type, username, rating 1–10), for film og TV. Filmvinduet har «Karakter» med snitt, hvem som ga hva og et rutenett 1–10 som lagrer med ett trykk (trykk igjen for å fjerne). Karakter i en anbefaling lagres også i `ratings`, og endres karakteren her, følger en eksisterende anbefaling med. Har man en anbefaling, kan karakteren ikke fjernes uten å slette anbefalingen. `recommendations` er bygget om i remote D1 med CHECK 1–10 (gamle karakterer omregnet), og eksisterende karakterer er kopiert til `ratings`.

26. Filmvinduet har bare én karakterskala (under «Karakter»). Anbefalingsskjemaet viser valgt karakter som tekst og bruker den; uten karakter må man gi en først.

27. «Mine lister» i filmvinduet: egen synlig knapp «➕ Opprett ny liste med denne filmen» (navn, rangert, «Opprett og legg til») i stedet for et skjult valg nederst i nedtrekkslisten.

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
