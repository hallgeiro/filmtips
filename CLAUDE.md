# Prosjektkontekst for Claude

**Filmtips** er en ikke-kommersiell filmapp for familie og venner (anbefalinger, bibliotek,
lister, «sett», filmkveld). Cloudflare Worker (Hono, TypeScript) + D1 + vanlig JS i `public/`.
Struktur, API-ruter, valg og historikk: [ARBEIDSLOGG.md](ARBEIDSLOGG.md). Les den før større
endringer, og legg nye punkter i kronologien når noe endres. Oppsett: [README.md](README.md).

Live: <https://filmtips.hallgeirolsen.com>. Språk i appen, kommentarer og dokumentasjon: norsk bokmål.

## Arbeidsmåte

Eieren bestemmer, Claude implementerer og sier fra når noe virker feil. Vis en plan før
endringer i mange filer. Ikke skriv om git-historikken.

**Publisering – alltid denne veien.** Eieren har ikke terminal på jobb-PC-en og publiserer
aldri med `wrangler deploy` selv. Foreslå det heller ikke.

1. Arbeid på en gren (aldri rett på `main`). Test, commit og push grenen.
2. Åpne en pull request mot `main`. `gh pr create` virker ikke (GraphQL er blokkert); bruk
   `gh api repos/hallgeiro/filmtips/pulls -f title=… -f head=… -f base=main -f body=…`.
3. Si fra til eieren, med lenke, at hen må trykke «Merge pull request» på GitHub. Claude slår
   ikke sammen selv og pusher ikke til `main`.
4. Cloudflare Workers Builds publiserer automatisk når `main` endres.
5. Etter sammenslåing: sjekk at siden er live, f.eks. en endret fil på
   <https://filmtips.hallgeirolsen.com> med `?sjekk=<tall>` bak adressen for å komme rundt
   hurtigbufring. Byggestatus står i GitHub-sjekken «Workers Builds».

**Databaseendringer (D1) trenger et ekstra steg.** Nye tabeller, kolonner og ombygginger må
kjøres i den eksterne D1-databasen `filmtips` *før* koden som bruker dem slås sammen, ellers
feiler appen. Eieren har ikke terminal, så Claude gir SQL-en klar til å limes inn i
D1-konsollen i Cloudflare-dashbordet (Storage & databases → D1 → filmtips → Console), sier
tydelig at den må kjøres først, og oppdaterer `schema.sql` i samme pull request.
Hemmeligheter (`TMDB_API_KEY`, `ADMIN_PASSWORD` m.fl.) settes under Settings → Variables and
Secrets (Runtime), aldri i koden – repoet er offentlig.
