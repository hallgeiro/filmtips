# Filmtips

Ikke-kommersiell filmanbefalingsapp for familie og venner. Hono på Cloudflare Workers, D1 (SQLite), statiske filer med Tailwind via CDN.

> Dette prosjektet er helt separat fra andre prosjekter (f.eks. Karmøy-fiskeapp). Egen Worker (`filmtips`), egen D1-database (`filmtips`), egne hemmeligheter og eget repo/mappe. Ikke gjenbruk `database_id` eller secrets fra andre prosjekter.

## Oppsett

```bash
npm install
npx wrangler login
npx wrangler d1 create filmtips        # lim inn database_id i wrangler.jsonc
cp .dev.vars.example .dev.vars         # fyll inn APP_PASSWORD (hemmelig signeringsnøkkel) og TMDB_API_KEY
npm run dev                            # oppretter tabellen lokalt (db:setup) og starter på http://localhost:8787
```

TMDB-nøkkel: gratis på https://www.themoviedb.org/settings/api (både v3-nøkkel og Read Access Token fungerer).

## Utrulling

```bash
npm run db:setup:remote
npx wrangler secret put APP_PASSWORD   # lang, tilfeldig streng (signeringsnøkkel, ikke et passord man taster)
npx wrangler secret put TMDB_API_KEY
npm run deploy
```

Navnene i nedtrekkslisten settes i `wrangler.jsonc` under `vars.USERS` (kommaseparert).

## API

Alle `/api/*`-ruter krever innloggingscookie (PIN-identitet eller admin), unntatt `/api/pin-login`, `/api/login-info` og `/api/logout`.

| Rute | Beskrivelse |
|---|---|
| `POST /api/pin-login` | `{username, pin, create?}` logger inn med navn + 6-sifret PIN. Med `create: true` lages PIN-en hvis navnet ikke har en |
| `GET /api/login-info` | `{users, pinUsers}` til innloggingsskjermen (alle navn og de som har PIN) |
| `POST /api/logout` | sletter innloggingscookien |
| `GET /api/config` | navn, hvem som har PIN, valgt identitet og om du er admin |
| `GET /api/search?q=[&type=multi]` | søk i TMDB (norsk). Støtter IMDb-kode/-lenke (tt1234567). `type=multi` tar med TV-serier |
| `GET /api/movie/:id/providers`, `/api/tv/:id/providers` | strømmetjenester i Norge |
| `GET /api/recommendations[?tmdb_id=]` | hent anbefalinger |
| `POST /api/recommendations` | lagre/oppdater (én per person per film) |
| `DELETE /api/recommendations/:id?username=` | slett egen anbefaling (admin kan slette alle) |
| `GET /api/ratings?tmdb_id=&media_type=` | alle karakterer (1–10) på en film/serie, med snitt |
| `POST /api/ratings` | `{username, tmdb_id, media_type, title, poster_path, rating}` gir din karakter (`rating: null` fjerner den) |
| `POST /api/seen` | `{username, tmdb_id, media_type, title, year, poster_path, seen}` kryss av (eller fjern, `seen: false`) at du har sett filmen uten karakter |
| `POST /api/viewings` | `{username, tmdb_id, media_type, title, year, poster_path, how?, seen_on?}` legger til en visning (filmen kan sees flere ganger). `how`: `kino`, `streaming`, `bluray`, `4k`, `dvd`, `fil`, `tv`, `annet`. `seen_on`: YYYY-MM-DD |
| `PATCH/DELETE /api/viewings/:id` | endre `{how, seen_on}` / slett en visning (eier eller admin) |
| `GET /api/films/:username` | alle filmer en bruker har sett, med karakter hvis gitt |
| `GET /api/recommendations/:id/comments` | kommentarer på en anbefaling |
| `POST /api/recommendations/:id/comments` | `{username, body}` (maks 500 tegn) legger til kommentar som deg selv |
| `DELETE /api/comments/:id` | slett egen kommentar (admin kan slette alle) |
| `POST /api/identity` | `{username, pin}` bytter navn når du er innlogget. Første gang opprettes PIN-en (6 siffer), deretter må den oppgis |
| `GET /api/lists[?tmdb_id=&media_type=]`, `POST /api/lists` | alle filmlister (med forhåndsvisning av plakater) / opprett `{username, title, description?, ranked?}` |
| `GET/PATCH/DELETE /api/lists/:id` | hent liste med filmer / endre / slett (eier eller admin) |
| `POST /api/lists/:id/items` | `{tmdb_id, media_type, title, year, poster_path}` legger film i listen (maks 200) |
| `DELETE /api/lists/:id/items/:itemId`, `POST .../move` | fjern film / flytt opp eller ned `{direction:'up'|'down'}` |
| `GET /api/library[?q=&format=&tmdb_id=]` | bibliotek (importert fra CLZ), adskilt fra anbefalinger |
| `GET /api/library/facets` | tiår som finnes i biblioteket |
| `GET /api/admin/barcode/:code` | (admin) slå opp strekkode (UPCitemdb, 100/dag) og foreslå TMDB-treff |
| `POST /api/admin/library/add` | (admin) legg til én film med format(er) og evt. strekkode |
| `PATCH /api/admin/library/:id` | (admin) rett eller fjern TMDB-match |
| `POST /api/admin/library/rematch` | (admin) kryssjekker titler uten treff og usikre treff: regissør + år mot TMDB (inkl. alternative titler), OMDb (hvis `OMDB_API_KEY`), Wikidata. Bokssett merkes «Samling». 3 om gangen |
| `POST /api/admin/library/import` | (admin) importerer opptil 20 filmer om gangen, matcher mot TMDB |
| `POST /api/admin/reset-pin` | `{username}` (admin) fjerner PIN slik at den kan lages på nytt |
| `POST /api/admin/login` / `logout` | `{password}` mot `ADMIN_PASSWORD` gir admin-cookie |

## Merknader

- Admin: sett secret `ADMIN_PASSWORD`. Trykk «Admin» øverst i appen og skriv passordet for å kunne slette andres anbefalinger. Uten admin kan man bare slette egne (tillitsbasert på valgt navn).
- Innlogging: velg navn og skriv en PIN på 6 siffer. Det finnes ikke noe felles passord. Første som velger et navn uten PIN lager den (skriv den to ganger). Eldre PIN-er på 4–5 siffer må nullstilles av admin. PIN lagres som PBKDF2-hash i tabellen `user_pins`, med lås i 15 minutter etter 5 feil forsøk. Uten admin kan man bare anbefale og slette som navnet man har logget inn som. Glemt PIN: admin trykker «Nullstill PIN». Kjør `npm run db:setup:remote` (eller kjør `schema.sql` mot D1) når tabellen `user_pins` mangler.
- Sett og karakterer: «Sett» (ett festet kort per bruker nederst i fanen Lister, ditt eget først) viser alle filmer en bruker har sett eller gitt karakter (velg bruker, filtrer på med/uten karakter, sorter på karakter, nyeste eller tittel). I filmvinduet kan du krysse av «Jeg har sett denne» uten å gi karakter, og logge hver visning med hvordan du så den (kino, streaming, Blu-ray, 4K, DVD, fil/digital kopi osv.) og dato. En film kan ha flere visninger. «Sett» kan filtreres på hvordan. Å gi karakter regnes som sett.
- Lister: i fanen «Lister» lager brukerne egne filmlister (favoritter, film noir osv.), rangerte (nummerert, med flytt opp/ned) eller ikke. Alle kan se alle lister, bare eieren (og admin) kan endre. Filmer legges til ved å søke i både biblioteket og TMDB, eller fra «Mine lister» i filmvinduet (nedtrekksmeny der du krysser av for å legge filmen i en liste eller fjerner krysset for å ta den bort, eller lager en ny liste).
- Sikkerheten er bevisst enkel (navn + 6-sifret PIN med sperre ved gjetting), tilpasset familie og venner. `APP_PASSWORD` brukes bare som hemmelig nøkkel for å signere innloggings-cookies. Bytter du den, logges alle ut. Hold den lang og tilfeldig.
- TMDB krever attribusjon. Strømdata kommer fra JustWatch. Begge er kreditert i bunnteksten.
- Bibliotek: som admin trykker du «Importer CLZ-CSV…» og velger eksportfilen fra CLZ Movies (kolonnene Title og Format kreves). Filmer matches mot TMDB på tittel og år, og samme film i flere formater slås sammen. Importen kan kjøres på nytt uten duplikater. Anbefalte filmer som finnes i biblioteket merkes med formatet.
- Biblioteket kan sorteres på tittel, år (nyest/eldst) og regissør (etter etternavn), filtreres på format og tiår (nedtrekksliste), og søkes på tittel eller regissør. Med knappen ved søkefeltet kan du bytte mellom bildegalleri og kompakt liste, både i Søk og Bibliotek. Trykk på et regissørnavn for å se alle filmene hans eller hennes. Som admin kan du rette feilmatcher («Rett») og legge til enkeltfilmer med strekkodeskanning (kamera krever https).
- TV og IMDb: biblioteket kan inneholde TV-serier (media_type `tv`, TMDB). TMDB-id er bare unik innen film eller TV, derfor lagres typen sammen med id-en. Anbefalinger gjelder bare filmer. Alle søkefelt godtar en IMDb-kode eller -lenke, som slås opp via TMDB. «Match på nytt» (admin) rydder titler som «: Season 4» og «Extended directors cut» og søker på film og TV.
- OMDb (valgfritt): secret `OMDB_API_KEY` (Runtime). Brukes bare av «Match på nytt» når TMDB ikke finner tittelen. IMDb-koden fra OMDb slås opp i TMDB, og treffet merkes som usikkert. Nøkkelen må aldri sjekkes inn (repoet er public).
- Kryssjekk: et treff godtas som sikkert bare hvis år (±2) og regissør fra CLZ stemmer med TMDB. Treff fra OMDb/Wikidata er alltid «usikre». Letterboxd og IMDb har ikke åpent API og brukes ikke direkte.
- Filmkveld: admin oppretter kvelder (dato, tittel, notat). Alle legger inn ønsker (TMDB-søk, maks 3 per person per kveld) og stemmer 👍 på andres. Admin velger vinner, som avslutter kvelden. Tabeller: `movie_nights`, `wishes`, `wish_votes`. Ruter: `/api/nights`, `/api/nights/:id`, `/api/nights/:id/wishes`, `/api/wishes/:id` (DELETE), `/api/wishes/:id/vote`, `/api/admin/nights` (POST/PATCH/DELETE).
- Bibliotek har tre visninger: 📀 Fysisk bibliotek (Blu-ray/4K UHD/DVD), 💾 Filsamling (format `Digital`) og Alle. `GET /api/library?kind=physical|files`. En film kan være i begge. Merking på film og ønsker skiller «I biblioteket» og «I filsamlingen». I filsamlingen er formatet «Fil (digital)» forhåndsvalgt når du legger til en film.
