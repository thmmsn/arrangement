# Arrangement / Events – enkelt påmeldingssystem

*Arrangement* på norsk, *Events* på engelsk.

Et lite og enkelt alternativ til Hoopla for påmelding til arrangementer:

- **Arrangementer kan bare nås via lenke** – `arrangement.domain.no/<hash>`. Det finnes ingen oversikt, og søkemotorer blir bedt om å holde seg unna.
- **Forsidebilde** som lastes opp (GPS og andre metadata fjernes) eller lenkes til. Fra et opplastet bilde lages et **delingsbilde** (`og:image`), så lenken får bilde når den deles.
- **Påmelding med navn, e-post og egendefinerte felter** (kort tekst, lang tekst, telefon, tall, nedtrekksliste, avkrysning).
- **Den som melder på kan legge til flere personer** i samme skjema. Hver person er én gjest og tar én plass, og hver person svarer på de egendefinerte feltene (f.eks. allergier). Arrangøren bestemmer hvor mange som kan meldes på om gangen (standard 10, 1 = bare seg selv).
- **Antall påmeldte vises** på arrangementssiden (kan skrus av), med ledige plasser hvis det er et tak.
- **E-post via [Resend](https://resend.com)**: én bekreftelse til den som meldte på (med alle personene), ett varsel til arrangøren, admin-lenke ved opprettelse og kvittering ved avmelding.
- **Avmelding**: den som meldte på, kan melde av hele eller deler av påmeldingen, og hver person har sin egen avmeldingslenke til å videresende. Arrangøren kan slå avmelding av per arrangement.
- **All administrasjon under `/admin`** – enkelt å skjule bak Cloudflare Access, på eget subdomene eller egen sti.
- **Utseendet styres med miljøvariabler**: navn, logo, farger, fonter, hjørneradius og tekster.
- **Flere domener, én database og én admin**: hvert domene er et *nettsted* med eget språk (norsk eller engelsk), tema, avsender og base-URL.
- **Helt lukket uten lenke**: forsiden og alle ukjente adresser svarer bare `404 Not Found` – uten logo, navn eller språk.
- **Mobilbillett med QR-kode** per person, med dørkode på 5 bokstaver, PDF-billett i e-posten, **Apple Wallet** og **Google Wallet** – som Hoopla.
- **Innsjekking i døra**: en egen dørvaktlenke. Dørvakten kan skanne QR-koden med vanlig kamera på iPhone, bruke skanneren på siden, taste inn billettnummeret eller søke på navn. Det gir grønt, gult eller rødt svar med «Angre», og innsjekking virker også uten nett.
- **Kalenderfil (.ics)** til deltakerne, og lenke til Google Kalender.
- **Sted fra Kartverket** (adresse, stedsnavn eller gnr/bnr) med kartpunkt, som gir **veibeskrivelse** på sidene, i e-posten og i Wallet. Wallet-kortet dukker opp av seg selv når tiden nærmer seg og man er i nærheten.
- **Brytere per arrangement**: billett, kalender, PDF, Wallet og selvavmelding er på som standard og kan slås av hver for seg.
- **Skins**: arrangøren velger utseende per arrangement (Mørk, Lys, Glass, Glød, Fjord, Høy kontrast). Eieren kan legge til egne, se [docs/skins.md](docs/skins.md).
- **Livsløpet er automatisk**:
  - Den første e-posten har alle lenkene: admin, dørvakt og avlys.
  - Tjenesteadministratoren (`ADMIN_EMAIL`) får kopi.
  - Arrangøren får en rapport ved påmeldingsfristen.
  - Etteranmelding kan tillates.
  - Arrangementet kan avlyses, med en valgfri melding til alle påmeldte.
  - Alle data slettes 30 dager etter at arrangementet er over.

Backend: Node.js, Express og SQLite. Frontend: ren HTML, CSS og JavaScript uten byggesteg.
Produksjon: `docker compose` med Cloudflare Tunnel – ingen åpne porter på serveren.

---

## Adressene

| Adresse | Hvem | Hva |
|---|---|---|
| `/<hash>` | Alle som får lenken | Arrangementsside med påmelding |
| `/<hash>/avmelding#<nøkkel>` | Den som meldte på (e-posten, etter påmeldingen og `/b/…`), eller én person (videresendt) | Avmelding av hele eller deler av påmeldingen – eller bare den ene personen |
| `/admin/ny` | Administrator | Opprett nytt arrangement |
| `/admin/<hash>#<nøkkel>` | Arrangøren (lenke i e-posten) | Påmeldte, innsjekking, dørvaktlenke, redigering, CSV, stenging, avlysning, sletting |
| `/admin/<hash>/avlys#<nøkkel>` | Arrangøren og tjenesteadministratoren (lenke i e-posten) | Samme side, åpnet på «Avlys arrangement» |
| `/b/<nøkkel>` | Den som meldte på (lenke i e-posten) | Alle billettene i påmeldingen, med Wallet, PDF, kalender, avmelding og «Del billetten» per person |
| `/t/<nøkkel>` | Gjesten – og det QR-koden peker på | Én billett. For en innlogget dørvakt: innsjekking |
| `/<hash>/kalender.ics` | Alle som har lenken til arrangementet | Kalenderfil |
| `/<hash>/skanner#<nøkkel>` | Dørvakter (lenke fra arrangøren) | Innsjekking: skanner, billettnummer og navnesøk |

Alt annet – også forsiden `/` – svarer med det samme nakne `404 Not Found` (ren tekst, uten logo, navn eller språk). Det gjelder også ugyldige lenker, både for sider og API. Uten en gyldig hash kan man dermed ikke se hvilket nettsted eller system som ligger på domenet. Statiske filer (CSS og JavaScript) må være tilgjengelige for at arrangementssidene skal virke, men de inneholder ingen data. Temastilarket har et navn som er en hash av innholdet, så det kan ikke gjettes.

Gamle admin-lenker (`/<hash>/admin#<nøkkel>`) sendes videre til `/admin/<hash>` – men bare for arrangementer som finnes.

### Hvor vanskelig er lenkene å gjette?

`<hash>` er 12 tilfeldige tegn fra et alfabet på 31 tegn (små bokstaver og tall, uten `0 o 1 l i`, som lett forveksles). Antall mulige lenker er

$$31^{12} \approx 7{,}9 \cdot 10^{17} \approx 2^{59{,}4}$$

Selv med 1000 gjett i sekundet tar det i snitt $\frac{31^{12}}{2 \cdot 1000 \cdot N}$ sekunder å treffe ett av $N$ arrangementer. Med $N = 1000$ er det rundt $4 \cdot 10^{11}$ sekunder, altså over 12 000 år.

Admin-nøkkelen er 24 tilfeldige byte, altså $2^{192}$ muligheter – den kan ikke gjettes.

Billettlenkene (`/t/…` og `/b/…`) består av et nummer på 10 tegn fra det samme alfabetet og en signatur på 128 bit, altså $2^{128} \approx 3{,}4 \cdot 10^{38}$ muligheter. Signaturen er en HMAC-SHA-256 av nummeret med en hemmelighet som bare finnes i databasen (se [Billetter og innsjekking](#billetter-og-innsjekking)). Nummeret alene gir ingen tilgang.

Nøklene etter `#` sendes **aldri** til serveren av nettleseren. De havner derfor ikke i serverlogger, proxy-logger eller `Referer`-headere. JavaScript på siden leser nøkkelen og sender den i `Authorization`-headeren. I databasen lagres bare SHA-256-hashen av nøklene.

---

## Kom i gang lokalt

Krever Node.js 22.9 eller nyere (og Python + C++-kompilator for `better-sqlite3`, som finnes på de fleste utviklermaskiner).

```bash
npm install
cp .env.example .env      # tøm DOMAIN, og sett ADMIN_NO_AUTH=true
npm run dev               # starter på http://localhost:3000 og laster på nytt ved endringer
```

1. Gå til <http://localhost:3000/admin/ny> og opprett et arrangement. Lokalt, uten Cloudflare Access, må `ADMIN_NO_AUTH=true` være satt – ellers er oppretting slått av.
2. Du får en påmeldingslenke og en administrasjonslenke.
3. Uten `RESEND_API_KEY` skrives e-postene til terminalen, så du ser nøyaktig hva som ville blitt sendt (inkludert avmeldingslenken).

Vil du prøve to nettsteder lokalt, kan du bruke `localhost` og `127.0.0.1` som to «domener»:

```ini
BASE_URL=http://localhost:3000
SITE_EN_DOMAIN=127.0.0.1
SITE_EN_BASE_URL=http://127.0.0.1:3000
SITE_EN_LANG=en
```

Kjør testene:

```bash
npm test
```

---

## Produksjon med Docker og Cloudflare Tunnel

Alt styres fra **én `.env`-fil** ved siden av `docker-compose.yml`.

```
server
├── docker-compose.yml
├── .env              ← alle innstillinger og hemmeligheter (kopi av .env.example)
├── branding/         ← valgfritt: logo, favicon, eget stilark
├── skins/            ← valgfritt: egne skins (se docs/skins.md)
└── secrets/          ← valgfritt: sertifikater og nøkler til Apple Wallet og Google Wallet
```

`docker-compose.yml` starter to containere:

- **arrangement** – appen. Databasen ligger i volumet `arrangement-data`, så den overlever nye versjoner.
- **cloudflared** – kobler seg *ut* til Cloudflare. Ingen porter åpnes på serveren mot internett; de offentlige sidene kan bare nås gjennom tunnelen. (Vil du bruke appen fra kontorets LAN uten Access, se [4. Kontorets LAN](#4-kontorets-lan-uten-cloudflare-access-valgfritt).)

### 1. Opprett tunnelen

1. Cloudflare-dashbordet → **Zero Trust → Networks → Tunnels → Create a tunnel** → velg *Cloudflared* → gi den et navn.
2. Velg *Docker* som miljø og kopier tokenet (den lange strengen etter `--token`). Sett det som `TUNNEL_TOKEN` i `.env`.
3. Under **Public Hostname** legger du til:

   | Hostname | Service |
   |---|---|
   | `arrangement.domain.no` | `HTTP` → `arrangement:3000` |
   | `events.domain.com` *(ett per ekstra nettsted, se [Flere nettsteder](#flere-nettsteder))* | `HTTP` → `arrangement:3000` |
   | `arrangement-admin.domain.no` *(hvis du bruker eget admin-vertsnavn)* | `HTTP` → `arrangement:3000` |

   `arrangement` er navnet på app-containeren i `docker-compose.yml`, så cloudflared finner den direkte.

### 2. Fyll inn `.env` og start

```bash
cp .env.example .env
nano .env                       # DOMAIN, TUNNEL_TOKEN, RESEND_API_KEY, EMAIL_FROM, …
docker compose up -d --build
docker compose logs -f arrangement  # se at alt starter, og eventuelle advarsler
```

Etter endringer i `.env`: kjør `docker compose up -d` på nytt, så startes appen med de nye verdiene. Ny versjon av koden: `git pull && docker compose up -d --build`.

**Versjonsnummer:** står nederst til høyre på alle sidene og i oppstartsloggen («Arrangement 2026.9.28.1 kjører …»), så det er lett å se hvilken versjon som kjører. Formatet er `år.måned.dag.løpenummer`: `2026.9.28.1` er første versjon 28. september 2026, `2026.9.28.2` den andre samme dag. Tallene har ingen ledende nuller og sammenlignes del for del som tall, så `2026.10.1.1` kommer etter `2026.9.30.4`. Nummeret står i filen `VERSION` og økes med `npm run bump` før en ny versjon legges på `main` (samme dag: løpenummeret + 1; ny dag: dagens dato og `.1`, i norsk tid). Det ligger i en fil og ikke i git, fordi Docker-bildet bygges uten `.git`-mappen. Den nakne `404`-siden viser ikke versjonen.

Noen innstillinger er låst i `docker-compose.yml` med vilje, uansett hva `.env` sier: databasen ligger alltid i volumet (`/data/arrangement.db`), klient-IP leses fra Cloudflares `cf-connecting-ip`, og appen får ikke se `TUNNEL_TOKEN`.

### 3. Skjul administrasjonen bak Cloudflare Access

All administrasjon ligger under `/admin` (sider) og `/api/admin` (API). Resten – arrangementssider, påmelding og avmelding – er offentlig. Velg én av to måter:

**A. Eget subdomene (anbefalt)** – enklest å få riktig:

1. Sett `ADMIN_HOST=arrangement-admin.domain.no` i `.env`. Da finnes `/admin` og `/api/admin` *bare* på det vertsnavnet; på `arrangement.domain.no` gir de 404. Admin-lenkene i e-postene peker dit.
2. Legg til vertsnavnet i tunnelen (se over).
3. **Zero Trust → Access → Applications → Add an application → Self-hosted**, domene `arrangement-admin.domain.no` (hele), og en policy som slipper inn deg (og eventuelle arrangører), f.eks. *Emails* med innlogging via engangskode.

> Bruk ett nivå under domenet (`arrangement-admin.domain.no`), ikke `admin.arrangement.domain.no` – Cloudflares gratis sertifikat dekker bare ett nivå.

Med flere nettsteder er A det klart beste valget: ellers finnes `/admin` på hvert eneste offentlige domene, og hvert domene trenger sin egen Access-regel. Uten `ADMIN_HOST` skriver appen en advarsel ved oppstart.

**B. Samme domene, egne stier:** Lag én Access-applikasjon for `arrangement.domain.no` med **to** stier: `admin` og `api/admin`. Glemmer du `api/admin`, er selve dataene ubeskyttet av Access – derfor anbefales C i tillegg.

**C. La appen verifisere Access (påkrevd, i tillegg til A eller B):**

Sett `CF_ACCESS_TEAM_DOMAIN` (Zero Trust → Settings → Custom Pages → *Team domain*) og `CF_ACCESS_AUD` (applikasjonens *Application Audience (AUD) Tag*). Da sjekker appen selv signaturen på Access-tokenet Cloudflare sender med hver forespørsel, og avviser alt til `/admin` og `/api/admin` som ikke har passert Access. En feilkonfigurert Access-regel kan dermed ikke gjøre admin offentlig.

Access er den eneste innloggingen – det finnes ikke noe passord. Uten C er oppretting av arrangementer derfor slått av, slik at en glemt innstilling aldri gjør det mulig for hvem som helst å opprette arrangementer og sende e-post i ditt navn. For lokal utvikling uten Access finnes `ADMIN_NO_AUTH=true`, som appen varsler tydelig om ved oppstart, og som ikke har noen virkning når Access er satt opp.

**Arrangører:** Admin-lenken per arrangement (`/admin/<hash>#<nøkkel>`) krever fortsatt sin egen nøkkel. Med Access må arrangørene i tillegg slippes inn av Access-policyen – legg til e-postadressene deres der, eller behold administrasjonen for deg selv.

### 4. Kontorets LAN uten Cloudflare Access (valgfritt)

Appen kan brukes fullt ut fra kontorets nett, også admin og oppretting av arrangementer, uten Cloudflare Access. Da starter appen en **ekstra HTTP-lytter** i samme prosess, med samme app og database:

```
Internett ──► Cloudflare ──► tunnel ──► arrangement:3000   (PORT – som før: Access, ADMIN_HOST, rate limiting)
Kontorets LAN ──────────► verten:9067 ──► arrangement:3001   (LAN_PORT – betrodd)
```

**Tilliten følger porten forespørselen kom inn på, aldri headere.** `Host`, `X-Forwarded-*`, `cf-connecting-ip` og query-parametere kan klienten sette fritt, så ingen av dem kan gjøre en forespørsel på `PORT` betrodd. Teknisk merker LAN-lytteren hver forespørsel med et privat `Symbol` før appen ser den. Det kan ikke settes av noe klienten sender. En test (`test/lan.test.js`) prøver å lure `PORT` med alle kombinasjoner av falske `Host`, `X-Forwarded-*`, `Forwarded`, `cf-connecting-ip` og query, og viser at admin fortsatt avvises.

| | `PORT` (3000, tunnelen) | `LAN_PORT` (f.eks. 3001) |
|---|---|---|
| Admin (`/admin`, `/api/admin`) | Access-token og `ADMIN_HOST`, som før | Slipper inn uten Access og uten `ADMIN_HOST` |
| Opprette arrangementer | Krever Access | Tillatt |
| Admin-nøkkel per arrangement | Kreves | Kreves fortsatt – LAN erstatter Access, ikke nøkkelen |
| Rate limiting | Per klient-IP (`CLIENT_IP_HEADER` bak tunnelen) | Av. Klient-IP leses alltid fra socketen |
| Nettsted | Fra `Host` | Fra `Host`, eller `?site=<id>` (f.eks. `?site=com`) |
| Arrangement på et annet nettsted | `301` til det offentlige domenet | `302` til samme adresse på LAN med `?site=<id>` |
| Dørvakt-informasjonskapsel | `Secure` (https) | Uten `Secure`, fordi LAN er vanlig http |

**Lenker er alltid de offentlige.** E-post, Wallet, kalender, PDF, dørvaktlenken og «Del billetten» bygges fra nettstedets offentlige adresse (`DOMAIN` / `SITE_<ID>_DOMAIN`), også når handlingen skjedde på LAN. Admin-siden viser de offentlige lenkene, så det er dem som kopieres og deles videre. Admin-lenken i e-posten peker til det offentlige admin-vertsnavnet. På LAN åpner du den samme siden ved å bytte ut starten: `http://<server>:9067/admin/<hash>#<nøkkel>`.

**Oppsett med docker compose:**

1. Sett `LAN_PORT=3001` i `.env`.
2. I `docker-compose.yml`, fjern `#` foran `ports:` og `- "9067:3001"`. **Bare LAN-porten publiseres på verten.** Port 3000 publiseres aldri.
3. Tunnelen går fortsatt til `arrangement:3000`. Pek den **aldri** til `3001`.
4. `docker compose up -d`. Oppstartsloggen sier tydelig at LAN-porten er betrodd.
5. Fra kontoret: `http://<serverens-LAN-IP>:9067/admin/ny`. .com-sidene forhåndsvises med `?site=com`.

> **Viktig:** Docker publiserer porter på *alle* vertens nettverkskort og går forbi brannmurer som `ufw`. Har serveren en offentlig IP-adresse, bind porten til LAN-adressen: `"192.168.1.10:9067:3001"`. Alle som når LAN-porten, er administrator.

### Lagene som beskytter administrasjonen

| Lag | Beskytter mot |
|---|---|
| Cloudflare Access (innlogging) | Alle som ikke er på lista di |
| `ADMIN_HOST` | At admin i det hele tatt finnes på det offentlige domenet |
| Appens egen Access-sjekk (`CF_ACCESS_*`) | Feilkonfigurerte Access-regler |
| Admin-nøkkel per arrangement | At én arrangør ser andres arrangementer |
| Oppretting slått av uten Access | At en glemt innstilling åpner for oppretting |
| Rate limiting per ekte klient-IP | Masseoppretting og spam (maks 20 nye arrangementer per 15 min) |
| `LAN_PORT` bare på kontorets nett | At noen utenfor kontoret når den betrodde porten (tilliten følger porten – aldri headere) |

### Oppgradering fra «booking»

Prosjektet het tidligere *booking*. Tjenesten i `docker-compose.yml` heter nå `arrangement`, volumet `arrangement-data` og databasefilen `arrangement.db`. En eksisterende installasjon beholder dataene slik:

1. **Databasefilen** flyttes automatisk. Finner appen `booking.db`, men ikke `arrangement.db`, i samme mappe, flyttes filen (med `-wal` og `-shm`) ved oppstart, og det står i loggen.
2. **Docker-volumet** har fått nytt navn, så dataene må kopieres over én gang, før appen startes med den nye versjonen:

   ```bash
   docker compose down
   docker volume ls                       # finn det gamle volumet, f.eks. booking_booking-data
   docker volume create arrangement_arrangement-data
   docker run --rm -v booking_booking-data:/fra -v arrangement_arrangement-data:/til alpine cp -a /fra/. /til/
   docker compose up -d --build
   ```

   Volumnavnet får mappenavnet som prefiks (`<mappe>_arrangement-data`). Kjører du fra en mappe som fortsatt heter `booking`, blir det nye volumet `booking_arrangement-data`, og da skal det navnet brukes i kommandoene over.
3. **Cloudflare-tunnelen:** tjenesten heter nå `arrangement`, så *Public Hostname* må peke til `HTTP` → `arrangement:3000` (tidligere `booking:3000`).
4. **GitHub:** navnet på repoet endres under *Settings → General → Repository name*. GitHub sender gamle adresser videre, men oppdater gjerne `git remote set-url origin …`.

Domenene dine endres ikke av omdøpingen. `arrangement.domain.no` og `events.domain.com` i dokumentasjonen er bare eksempler.

### Sikkerhetskopi

SQLite-databasen er én fil i volumet. Ta en trygg kopi mens appen kjører:

```bash
docker compose exec arrangement node -e "require('better-sqlite3')('/data/arrangement.db').backup('/data/backup.db').then(() => console.log('ok'))"
docker compose cp arrangement:/data/backup.db ./backup-$(date +%F).db
```

### Uten Docker eller Cloudflare

Appen er en vanlig Node-server (`npm start`) og kan kjøres bak hvilken som helst reverse proxy (nginx, Caddy …). Sett da `TRUST_PROXY=1` (ikke `CLIENT_IP_HEADER`) og `DATABASE_PATH` til en fil på en persistent disk. `LAN_PORT` virker på samme måte: la proxyen bare sende til `PORT`, og la LAN-porten bare være tilgjengelig på kontorets nett.

---

## Flere nettsteder

Samme app, database og admin kan betjene flere offentlige domener samtidig. Hvert domene er et **nettsted** med eget språk, tema, avsenderadresse og egen base-URL. Hvert arrangement hører til ett nettsted.

### Oppsett – eksempel med to domener

```ini
# Hovednettstedet: dagens variabler, uendret
DOMAIN=arrangement.domain.no
SITE_LANG=nb
SITE_NAME=Påmelding
LOGO_URL=/assets/custom/logo.svg
EMAIL_FROM=Påmelding <arrangement@domain.no>
COLOR_ACCENT=#8b2e2a

# Et ekstra nettsted med prefikset SITE_NET_
SITE_NET_DOMAIN=events.domain.com
SITE_NET_LANG=en
SITE_NET_SITE_NAME=Registration
SITE_NET_LOGO_URL=/assets/custom/logo-en.svg
SITE_NET_EMAIL_FROM=Registration <events@domain.com>
# SITE_NET_COLOR_ACCENT er ikke satt → arves fra hovednettstedet (#8b2e2a)

# Anbefalt: admin på eget vertsnavn, så /admin ikke finnes på noen av de offentlige domenene
ADMIN_HOST=arrangement-admin.domain.no
```

- **Hovednettstedet** kommer fra de vanlige variablene (`DOMAIN`, `BASE_URL`, `EMAIL_FROM`, `SITE_LANG` og temavariablene). Eksisterende installasjoner fortsetter å virke uten endringer, og de får ID-en `main`.
- **Et ekstra nettsted** defineres med prefikset `SITE_<ID>_` og finnes så snart `SITE_<ID>_DOMAIN` er satt. ID-en kan bare inneholde A–Z og 0–9. Det kan sette `DOMAIN`, `BASE_URL`, `LANG`, `EMAIL_FROM` og alle temavariablene.
- **Arv:** Det nettstedet ikke setter selv, arves fra hovednettstedet. Unntaket er `FOOTER_TEXT`, som bare arves når språket er det samme – en norsk bunntekst skal ikke havne på et engelsk nettsted.
- **Språk:** `nb` (norsk bokmål, standard) eller `en` (engelsk). Hovednettstedets språk heter `SITE_LANG`, ikke `LANG`, fordi `LANG` er en standard miljøvariabel i Linux som ofte allerede er satt (f.eks. `en_US.UTF-8`).
- Legg hvert domene til under *Public Hostname* i Cloudflare-tunnelen, og verifiser avsenderdomenet i Resend.

Oppsettet sjekkes ved oppstart. To nettsteder med samme domene, en `SITE_<ID>_BASE_URL` som peker på et annet domene enn `SITE_<ID>_DOMAIN` (det ville gitt en evig løkke av omdirigeringer), eller prefikset `SITE_MAIN_` stopper oppstarten med en tydelig feilmelding. Ukjente eller ugyldige verdier gir en advarsel i loggen.

### Slik virker det

| | |
|---|---|
| **Valg av nettsted** | Ut fra `Host`-headeren – aldri `X-Forwarded-Host`, som en klient kan sette selv. Et ukjent vertsnavn får hovednettstedet. |
| **Opprette arrangementer** | Nettstedet velges i skjemaet (vises når det finnes mer enn ett) og kan endres ved redigering. De ferdige feltene («Telefon», «Allergier» …) får etiketter på nettstedets språk. |
| **Feil domene** | Åpnes et arrangement – eller avmeldingssiden – på feil domene, sendes nettleseren med `301` til riktig domene, med samme sti. `#nøkkelen` i avmeldingslenker følger med. |
| **Språk på sidene** | Arrangementssiden, påmeldingen, feilmeldingene og avmeldingen er på nettstedets språk, og `<html lang>` følger nettstedet. Datoer formateres etter språket («lørdag 26. oktober 2030 kl. 18:00» / «Saturday, 26 October 2030 at 18:00»). |
| **E-post** | Alle lenker og logoer bygges fra arrangementets nettsted, aldri fra `DOMAIN`. Avsenderen er nettstedets `EMAIL_FROM`, og teksten er på nettstedets språk. |
| **Admin** | Adminsidene, admin-API-et og CSV-eksporten bruker hovednettstedets språk og tema, uansett domene. Admin-lenken peker til `ADMIN_HOST` hvis den er satt, ellers til arrangementets domene. |

Databasen oppgraderes automatisk: eksisterende arrangementer havner på hovednettstedet. Fjerner du et nettsted fra oppsettet, vises arrangementene dets på hovednettstedet, og appen varsler om dem ved oppstart.

### Språk og ordbøker

All tekst ligger i én ordbok per språk: `public/assets/i18n/nb.js` og `en.js`. Både nettleseren og serveren (sider, skript, e-poster, feilmeldinger og CSV) bruker de samme filene. Flertall håndteres med `Intl.PluralRules` (`{ one: '… påmeldt', other: '… påmeldte' }`).

En test sjekker at alle språk har nøyaktig de samme nøklene og plassholderne, og at hver tekstnøkkel koden bruker, finnes. Et nytt språk legges til ved å kopiere `en.js`, oversette den og registrere den i `public/assets/i18n/index.js`.

---

## Billetter og innsjekking

### Billetten

Hver person i en påmelding får en billett med QR-kode og en **dørkode** på 5 bokstaver, for eksempel `FFRXK`.

**Den som melder på, får alt – også for de andre.** Ingen andre enn den som melder på får e-post, og den som melder på videresender selv til hver enkelt. Derfor får den som meldte på:

| Hvor | Hva |
|---|---|
| **Rett etter påmeldingen** (på siden) | «Vis billettene», «Legg alle i Apple Wallet», «Lagre alle i Google Wallet», «Last ned alle (PDF)», kalender og «Meld av» |
| **Bekreftelses-e-posten** | De samme knappene øverst (Wallet som tydelige svarte knapper). Ved flere personer: under hver person dørkode og egne lenker til *Billett*, *Apple Wallet*, *Google Wallet*, *PDF* og *Meld av*, klare til å videresendes. PDF-billetten (én side per person) og kalenderfilen ligger ved. |
| **Siden med alle billettene** (`/b/…`) | Bla mellom billettene (1 / 3). Hver billett har «Del billetten» (telefonens delingsmeny, eller kopier på PC), Wallet og PDF for den ene billetten. Nederst Wallet og PDF for alle, kalender og «Meld av». |

Wallet-knappene vises bare når Wallet er satt opp på serveren og slått på for arrangementet (se [Wallet](#apple-wallet)). Er de ikke satt opp, står det i loggen ved oppstart, og bryterne i skjemaet er grået ut med «ikke satt opp på serveren».

**PDF-billetten** er formet som en billett med avrivningskant: nettstedets logo (`LOGO_URL`) øverst på nettstedets bakgrunnsfarge – samme kontrast som på nettsiden – med «BILLETT» og «1 / 3» til høyre, deretter tittel, tid, sted og navn, og under avrivningskanten QR-koden og dørkoden. Logoen kan være PNG, JPEG eller SVG (tegnes som vektorer, skarp på alle skrivere). Den leses fra `branding/` når `LOGO_URL=/assets/custom/<fil>`, eller hentes over https. WebP kan ikke brukes i PDF; da står nettstedsnavnet øverst, og loggen sier fra ved oppstart. Tekstfargene kontrollsjekkes mot bakgrunnen (WCAG), så billetten er lesbar også med mørkt tema.

**QR-koden er en lenke:** `https://arrangement.domain.no/t/<billettnummer><signatur>`. Da kan den skannes med vanlig kamera på alle telefoner. Signaturen er

$$\text{signatur} = \mathrm{HMAC\text{-}SHA256}(\text{hemmelighet},\ \texttt{ticket:} \,\|\, \text{nummer})$$

forkortet til 128 bit. Hemmeligheten lages tilfeldig i databasen første gang appen starter. Serveren lagrer bare nummeret og regner ut lenken på nytt når den trengs (e-post, PDF, Wallet). En lekket database gir dermed ikke billettlenkene. En falsk eller endret lenke gir den nakne 404-en. Påmeldingslenken (`/b/…`) signeres med et annet formål, så den ene kan aldri brukes som den andre.

Billettlenken gir bare rett til å *se* billetten, altså navnet og arrangementet. Innsjekking krever i tillegg at telefonen er logget inn som dørvakt.

### Avmelding

Avmeldingslenken er `/<hash>/avmelding#<nøkkel>`. Nøkkelen står etter `#`, så den havner aldri i serverlogger eller `Referer`. Det finnes to slags nøkler, begge avledet med HMAC som billettnøkkelen, men med egne formål:

$$\text{påmelding} = \text{påmeldingsnummer} \,\|\, \mathrm{HMAC\text{-}SHA256}(\text{hemmelighet},\ \texttt{cancel-booking:} \,\|\, \text{påmeldingsnummer})$$

$$\text{person} = \text{billettnummer} \,\|\, \mathrm{HMAC\text{-}SHA256}(\text{hemmelighet},\ \texttt{cancel-ticket:} \,\|\, \text{billettnummer})$$

(signaturen forkortet til 128 bit). Påmeldingens nøkkel lar deg velge hvem som skal meldes av. Personens nøkkel melder bare av den ene personen, og siden snakker da til personen selv («Hei Kari! Vil du melde deg av?»). Den som meldte på, får kvittering, og arrangøren får varsel.

**Hvorfor ikke bare billettlenken?** Billettlenken står i QR-koden, som vises fram i døra, ligger i Wallet og skrives ut. Den som ser eller tar bilde av QR-koden, skal kunne se billetten, men ikke melde personen av. Derfor har enkeltbilletten (`/t/…`) aldri «Meld av», og verken billett- eller påmeldingsnøkkelen virker som avmeldingsnøkkel.

**Bryteren «Deltakerne kan melde seg av selv»** (på som standard): Slått av, vises ingen avmeldingslenker, og API-et avviser avmelding med `403`, også for lenker som ble sendt ut mens den var på. E-posten sier i stedet «Svar på denne e-posten, så får arrangøren beskjed» (svaret går til arrangøren).

### Dørvaktlenken

På admin-siden og i den første e-posten til arrangøren står en **dørvaktlenke** (`/<hash>/skanner#<nøkkel>`). Arrangøren deler den med dem som skal stå i døra.

1. Dørvakten åpner lenken én gang og skriver eventuelt navnet sitt. Telefonen får en informasjonskapsel for arrangementet. Den er `HttpOnly`, `SameSite=Lax` og gyldig til to døgn etter at arrangementet er over. Nøkkelen fjernes fra adresselinjen.
2. **Med vanlig kamera** (iPhone eller Android): QR-koden åpner billetten, siden ser at telefonen tilhører en dørvakt og sjekker gjesten inn. Skjermen blir grønn («Sjekket inn»), gul («Allerede sjekket inn 18:02 av Kari») eller rød («Ugyldig billett», «Feil arrangement» eller «Avlyst»), med lyd og vibrasjon. «Angre» retter et feiltrykk.
3. **Skanneren på siden** (`/<hash>/skanner`) bruker kameraet direkte. Den bruker nettleserens innebygde QR-leser når den finnes, ellers [jsQR](https://github.com/cozmo/jsQR). Siden har også felt for **dørkoden** og **søk på navn** (minst to tegn, maks ti treff) for gjester uten billett på telefonen.
   - Dørkoden sendes så snart femte bokstav er skrevet.
   - Koden har bare bokstaver, så dørvakten slipper å bytte mellom bokstaver og tall på tastaturet.
4. **Hele familien på én gang:** etter en innsjekking vises de andre i samme påmelding med en «Sjekk inn»-knapp.

Innsjekkingen skjer alltid med en `POST` fra siden, aldri bare ved at lenken åpnes. E-postprogrammer og forhåndsvisninger åpner nemlig lenker av seg selv. Den er også atomisk (`UPDATE … WHERE checked_in_at IS NULL`), så to dørvakter som skanner samme billett samtidig aldri begge får «Sjekket inn».

### Dørkoden

Dørkoden står stort på billetten, i PDF-en, under QR-koden i Wallet og i bekreftelses-e-posten, én per person. Den har 5 bokstaver fra et alfabet på 24 (A–Z uten I og O, som ligner 1 og 0) og er unik innenfor arrangementet. Antall mulige koder er

$$24^5 = 7\,962\,624$$

Hvis noen finner på en kode i døra, er sannsynligheten for å treffe en av $N$ gyldige billetter

$$p = \frac{N}{24^5}, \qquad N = 500 \;\Rightarrow\; p \approx 6{,}3 \cdot 10^{-5} \approx 0{,}006\,\%$$

Dørvakten ser i tillegg navnet på skjermen og kan be om legitimasjon. Dørkoden er ikke en hemmelighet på samme måte som billettlenken: den gir bare innsjekking, og bare for en innlogget dørvakt. Selve billettsiden kan bare åpnes med den lange, signerte lenken i QR-koden.

Billettnummeret på 10 tegn (i lenken) godtas også i feltet, med Enter.

**Dørvaktmodus:** dørvakten ser bare navn, hvem som meldte på og status, aldri e-post, telefonnummer eller svar på skjemaet.

**Uten nett:** skannersiden har en liste med navn, dørkoder og SHA-256-hasher av alle billettlenker. Forsvinner nettet, kjenner siden igjen en ekte billett selv og legger innsjekkingen i kø. Køen sendes, med riktig tidspunkt, så snart nettet er tilbake. Hashene kan ikke brukes til å lage billetter.

**Ny dørvaktlenke:** «Lag ny lenke» på admin-siden gjør den gamle ugyldig og logger ut alle telefoner som brukte den. Nøkkelen er avledet av arrangementet og et versjonsnummer, så den kan alltid vises på nytt.

På admin-siden er det en kolonne «Innsjekket» med tidspunkt og dørvakt, «Sjekk inn» og «Angre», og en teller. CSV-eksporten har kolonnene «Etteranmelding», «Innsjekket» og «Dørkode».

---

## Forsidebilde

Arrangøren kan **laste opp et bilde** eller lime inn en lenke. Et opplastet bilde går foran lenken.

- **I nettleseren:** et stort bilde (over 2000 piksler på den lengste siden, eller over 1,5 MB) skaleres ned før opplasting. JPEG forblir JPEG; PNG og WebP blir WebP, som beholder gjennomsiktighet. Et mobilbilde på 12 MB blir typisk noen hundre kB, og retningen blir riktig.
- **På serveren:**
  - Filtypen avgjøres av innholdet, ikke filnavnet. Bare JPEG, PNG og WebP godtas, maks 5 MB og maks 40 millioner piksler, så et lite «bildebombe»-bilde ikke kan få nettleseren til å gå tom for minne.
  - **Alle metadata fjernes** før lagring: EXIF og XMP (GPS-posisjon, tidspunkt, kameramodell), kommentarer og tekstfelter. Bare bildets retning beholdes, i en minimal EXIF-blokk, så mobilbilder ikke vises liggende. Selve bildedataene endres ikke.
- **Lagring:** bildet ligger i databasen, i en egen tabell, og slettes sammen med arrangementet.
- **Hele bildet vises:** på arrangementssiden fyller bildet innholdskolonnen i bredden, med samme kanter som tittelen og teksten, og får sin egen høyde – det beskjæres aldri, så tekst, dato og logo ut mot kantene av en plakat blir med. Et svært høyt bilde (en stående plakat) begrenses til 70 % av skjermhøyden (men minst 320 piksler), så påmeldingen ikke havner langt ned. Da skaleres det ned og sentreres (`object-fit: contain`). Liggende format passer best, helst 1,91 : 1, for eksempel 1920 × 1005 piksler, som er det samme formatet som delingsbildet under.
- **Visning:** bildet vises på arrangementets eget domene (`/<hash>/bilde/<hash-av-innholdet>.jpg`), med `Cache-Control: private`, så det ikke blir liggende i en delt mellomlagring etter at arrangementet er slettet. I Google Wallet vises det øverst på kortet som et bredt banner. Der er det Google som bestemmer hvordan bildet skaleres og beskjæres (Google anbefaler forholdet 3 : 1), så en stående plakat kan bli beskåret eller liten der.

### Delingsbilde (og:image)

Når arrangementslenken deles i Messenger, Slack, Teams, iMessage, LinkedIn o.l., viser tjenesten en forhåndsvisning med tittel og bilde. Bildet er et eget **delingsbilde som lages fra det opplastede forsidebildet**:

- **Format:** JPEG på 1200 × 630 piksler (forholdet 1,91 : 1 som disse tjenestene bruker), beskåret fra midten. Dette er det eneste stedet systemet selv beskjærer forsidebildet, fordi forhåndsvisningen har fast format. Et forsidebilde i forholdet 1,91 : 1 (f.eks. 1920 × 1005) mister ingenting. Små bilder skaleres opp, så forhåndsvisningen alltid blir stor.
- **Riktig vei:** bildet roteres etter EXIF-retningen, så mobilbilder ikke blir liggende.
- **Gjennomsiktighet** (PNG/WebP) fylles med hvitt – ellers blir den svart hos noen tjenester.
- **Uten metadata:** delingsbildet har verken EXIF, XMP eller fargeprofil (fargene gjøres om til sRGB).
- **Når:** delingsbildet lages samtidig med opplastingen og lagres ved siden av forsidebildet. Kan ikke bildedataene leses (et ødelagt eller avkortet bilde), avvises opplastingen med «Ugyldig bilde». Bilder som ble lastet opp før delingsbildet fantes, får det ved første vedlikehold etter oppgraderingen.
- **Adresse:** `/<hash>/bilde/<hash-av-forsidebildet>-deling.jpg`, med `Cache-Control: private` og samme domenekrav som forsidebildet. Et nytt forsidebilde gir ny adresse, og den gamle slutter å virke.
- **Bare fra opplastede bilder:** er forsidebildet bare en lenke til et bilde et annet sted, får siden ingen `og:image` – serveren henter aldri bilder fra andre nettsteder.

Arrangementssiden (`/<hash>`) har taggene `og:type`, `og:site_name`, `og:title` (arrangementets tittel), `og:url` og – når det finnes et opplastet bilde – `og:image` med type, bredde og høyde, samt `twitter:card` (`summary_large_image` med bilde, ellers `summary`). Taggene må stå i HTML-en fra serveren, fordi tjenestene som lager forhåndsvisninger ikke kjører JavaScript. Avmeldings- og billettsidene er personlige og har ingen delingstagger.

**Merk:** `robots.txt` har `Disallow: /`. Noen tjenester respekterer det også når de lager forhåndsvisninger (X/Twitter og LinkedIn gjør det) og viser da ingen forhåndsvisning. Andre, som iMessage, henter siden direkte fra telefonen og bryr seg ikke om `robots.txt`.

---

## Kalender, sted og Wallet

### Kalenderfil

`/<hash>/kalender.ics` og vedlegget i e-posten følger iCalendar (RFC 5545):

- Tidene er i UTC, så ingen tidssoneblokk trengs, og sommertid blir riktig.
- UID er fast og SEQUENCE øker ved hver endring, så en ny import oppdaterer avtalen i stedet for å lage en kopi.
- Tekst escapes, og linjer brettes ved 75 byte uten å dele «æøå».
- Med kartpunkt kommer `GEO` og Apples `X-APPLE-STRUCTURED-LOCATION` (kart og reisetid i Apple Kalender) med.
- Et avlyst arrangement får `STATUS:CANCELLED` og «AVLYST:» foran tittelen.
- Filen inneholder **bare offentlig informasjon**, aldri billett- eller avmeldingslenker. Kalendere deles ofte med familie og kolleger.

Android har ingen innebygd import av .ics fra e-post, så det finnes også en «Google Kalender»-lenke.

### Sted fra Kartverket

Stedsfeltet i skjemaet søker hos Kartverket mens man skriver, via appens egen proxy (`/api/admin/places`). Nettleseren snakker aldri med Kartverket direkte. Oppslaget går til to åpne tjenester uten nøkkel:

| Søk | Kartverket |
|---|---|
| Adresse, f.eks. «Osloveien 15» | `ws.geonorge.no/adresser/v1/sok` |
| Matrikkel, f.eks. `5001/5/422` (kommunenr/gnr/bnr) | Samme tjeneste, med `kommunenummer`, `gardsnummer` og `bruksnummer` |
| Stedsnavn, f.eks. «Oppdal» | `ws.geonorge.no/stedsnavn/v1/navn` |

Adresser vises først, deretter stedsnavn. Eksakte treff kommer først, deretter tettsteder og bygninger, og til slutt fjell og annet. Koordinatene er i EUREF89 (EPSG:4258), som i praksis er det samme som WGS84. Svarer ikke Kartverket innen 10 sekunder, kan stedet skrives inn fritt. Oppslaget dekker bare Norge. Et valgt kartpunkt gir:

- **Veibeskrivelse** på arrangementssiden, billetten og i e-posten: Apple Kart på iPhone, iPad og Mac, ellers Google Maps. Uten kartpunkt søkes det på stedsteksten.
- **Wallet-kort som dukker opp av seg selv** nær stedet (se under), og kart i kalenderen.

### Apple Wallet

Kortet (`.pkpass`) har QR-koden, navnet, tid og sted, og på baksiden lenker til billetten, arrangementet og veibeskrivelse. Flere billetter lastes ned som én `.pkpasses`, så hele familien legges til med ett trykk (iOS 15+).

- **Tid:** `relevantDates` (og `relevantDate` for eldre iOS) gjør at kortet vises på låseskjermen fra tre timer før start til slutt.
- **Sted:** `locations` med kartpunktet gjør at kortet vises når telefonen er i nærheten av stedet.
- **`semantics`** (arrangementsnavn, tid, sted og koordinater) brukes av iOS til forslag, kart og veibeskrivelse.

Oppsett (krever Apple Developer Program):

1. *Certificates, Identifiers & Profiles → Identifiers → Pass Type IDs*: lag en id, f.eks. `pass.no.domain.arrangement`.
2. Lag et sertifikat for den (*Create Certificate*), last det ned, åpne det i Nøkkelring og eksporter sertifikat og nøkkel som `.p12` med passord.
3. Last ned Apples mellomsertifikat *Worldwide Developer Relations – G4* fra <https://www.apple.com/certificateauthority/>.
4. Legg filene i `./secrets` og sett `APPLE_WALLET_*` i `.env` (se `.env.example`). Team ID står øverst til høyre i utviklerkontoen.

Kortet signeres med PKCS#7 (SHA-256), med både kortsertifikatet og mellomsertifikatet. Ved oppstart sjekkes det at filene kan leses, og det varsles hvis sertifikatet er utløpt.

### Google Wallet

«Lagre i Google Wallet» er en lenke med en signert JWT (RS256). Den inneholder både arrangementet og billettene, så Google oppretter dem første gang noen lagrer, og appen trenger ingen egne kall mot Google. `dateTime` gjør at Google Wallet varsler når arrangementet nærmer seg, og `venue` viser stedet. Veibeskrivelsen er en lenke på kortet, fordi Google ikke lenger bruker kartpunkter til varsler.

Oppsett:

1. Opprett en utstederkonto i [Google Pay & Wallet Console](https://pay.google.com/business/console) og noter *Issuer ID*.
2. Lag en tjenestekonto i Google Cloud med Google Wallet API slått på, og last ned nøkkelfilen (JSON).
3. Legg tjenestekontoen til som bruker i Wallet Console.
4. Legg nøkkelfilen i `./secrets` og sett `GOOGLE_WALLET_*` i `.env`.

Til Google har godkjent kontoen for produksjon, kan bare testbrukerne du legger til i Wallet Console lagre kortene.

**Brytere:** Wallet-bryterne er grået ut i skjemaet («ikke satt opp på serveren») når tjenesten ikke er satt opp; den lagrede verdien beholdes. Mangler en fil eller variabel, slås Wallet av med en advarsel i loggen, og resten virker som før. Ved oppstart står det alltid i loggen om Apple Wallet og Google Wallet er i bruk.

---

## Arrangementets livsløp

### Første e-post

Når et arrangement opprettes, får arrangøren én e-post med alt som trengs senere:

- påmeldingslenken;
- **admin-lenken**, som bare finnes her, fordi appen lagrer bare en hash av nøkkelen;
- **dørvaktlenken**;
- **lenken for å avlyse**;
- når **rapporten** kommer;
- om **etteranmelding** er tillatt;
- datoen da **alle data slettes**.

**Tjenesteadministratoren** (`ADMIN_EMAIL`, gjerne flere adresser skilt med komma) får en kopi med de samme lenkene, pluss arrangørens navn og e-post og hvem som opprettet arrangementet via Cloudflare Access. Det er en ekstra sikkerhet: det finnes ingen oversikt over alle arrangementer, men administratoren vet om hvert eneste ett og kan avlyse eller slette det. Administratoren får også kvittering når et arrangement avlyses.

### Underveis

- Arrangøren får e-post for hver påmelding og avmelding.
- **Etteranmelding:** Bryteren «Tillat påmelding etter fristen» holder påmeldingen åpen etter fristen og fram til arrangementet er over (slutttidspunktet, eller starten hvis det ikke har noe slutttidspunkt). Hver slik påmelding kommer til arrangøren med emnet «Etteranmelding: …». Den merkes også i admin-listen og i CSV-filen. Uten bryteren stenger påmeldingen ved fristen.

### Rapport ved påmeldingsfristen

Når fristen er nådd (satt frist, ellers når arrangementet starter), får arrangøren en rapport med:

- antall personer og påmeldinger;
- alle navn med e-post, eller hvem som meldte dem på;
- CSV med alle svar, vedlagt;
- dørvaktlenken;
- datoen da dataene slettes.

Rapporten sendes én gang. Flyttes fristen fram i tid, sendes en ny ved den nye fristen. Svikter e-posten, prøves den igjen i opptil to døgn. Avlyste arrangementer får ingen rapport.

### Avlysning

«Avlys arrangement» ligger på admin-siden og som lenke i den første e-posten. Arrangøren kan skrive en melding og velge om de påmeldte skal få e-post. Hver påmelding får da én e-post med meldingen, og svar går til arrangøren. Etter avlysningen:

- påmeldingen er stengt;
- billettene gir «Avlyst» i døra;
- kalenderfilen blir `CANCELLED`;
- arrangøren og tjenesteadministratoren får kvittering.

Avlysningen kan oppheves (uten e-post), for eksempel etter et feiltrykk.

### Sletting

Alle data om et arrangement slettes automatisk `DELETE_AFTER_DAYS` dager (standard 30) etter at det er over, det vil si slutttidspunktet, eller starten hvis det ikke har noe slutttidspunkt. Det gjelder påmeldinger, navn, e-post, svar og innsjekkinger, og også avlyste arrangementer. Datoen står i den første e-posten, i rapporten og på admin-siden.

SQLite kjøres med `secure_delete`, så slettede data overskrives i databasefilen i stedet for å bli liggende i ledige sider. To steder ligger kopier utenfor appens kontroll:

- **sikkerhetskopier du selv har tatt**;
- **e-postloggen hos Resend** (se Resends innstillinger for hvor lenge den lagres).

Vedlikeholdet, altså rapporter og sletting, kjøres ved oppstart og deretter hvert tiende minutt.

---

## Sette opp Resend

1. Opprett konto på <https://resend.com>.
2. **Domains → Add Domain**: legg til `domain.no` (eller et underdomene som `mail.domain.no`). Med et engelsk nettsted på `events.domain.com` legges også `domain.com` til. Resend viser noen DNS-poster (SPF/MX og DKIM, gjerne også DMARC) som du legger inn hos Cloudflare DNS. Vent til domenet står som *Verified*.
3. **API Keys → Create API Key** med tilgangen *Sending access*. Sett den som `RESEND_API_KEY`.
4. Sett `EMAIL_FROM` til en adresse på det verifiserte domenet, f.eks. `Påmelding <arrangement@domain.no>`.

Svar på e-postene går dit det gir mening (feltet `reply_to`):

| E-post | Til | Svar går til |
|---|---|---|
| Bekreftelse på påmelding (alle personene) | Den som meldte på | Arrangøren |
| Ny påmelding (alle personene) | Arrangøren | Den som meldte på |
| Bekreftelse: vedlegg | Kalenderfil (.ics) og PDF-billett, etter arrangementets brytere | – |
| Arrangementet er opprettet (admin-, dørvakt- og avlys-lenke) | Arrangøren, og kopi til `ADMIN_EMAIL` | – |
| Etteranmelding | Arrangøren | Den som meldte på |
| Rapport ved påmeldingsfristen (med CSV) | Arrangøren | – |
| Avlyst (med arrangørens melding) | Hver påmelding | Arrangøren |
| Arrangementet er avlyst (kvittering) | Arrangøren og `ADMIN_EMAIL` | – |
| Avmelding (kvittering og varsel) | Gjesten og arrangøren | Hverandre |

Hvis Resend feiler, blir påmeldingen likevel lagret. Feilen logges, og gjesten får beskjed om at bekreftelsen ikke kom frem.

---

## Utseende

Alt settes i `.env` – se `.env.example` for hele lista med forklaringer. Ugyldige verdier (f.eks. en farge med skrivefeil) ignoreres, og appen skriver en advarsel i loggen ved oppstart. Med [flere nettsteder](#flere-nettsteder) kan hver variabel settes per nettsted med prefiks, f.eks. `SITE_NET_COLOR_ACCENT`.

| Variabel | Hva |
|---|---|
| `SITE_NAME` | Navnet – øverst (hvis ingen logo), i fanetittel, bunntekst og e-poster |
| `LOGO_URL`, `LOGO_HEIGHT` | Logo øverst på alle sider og i e-postene |
| `FAVICON_URL` | Ikon i nettleserfanen |
| `COLOR_ACCENT`, `COLOR_ACCENT_TEXT` | Knapper og lenker, og teksten på knappene |
| `COLOR_BACKGROUND`, `COLOR_SURFACE` | Sidebakgrunn, og bakgrunn på kort og skjema |
| `COLOR_TEXT`, `COLOR_MUTED`, `COLOR_BORDER` | Brødtekst, hjelpetekst, linjer |
| `COLOR_SUCCESS`, `COLOR_HIGHLIGHT` | «Påmelding åpen»/bekreftelser, detaljer i båndet |
| `FONT_HEADING`, `FONT_BODY` | Fonter fra Google Fonts, f.eks. `Playfair Display:wght@600` |
| `GOOGLE_FONTS` | `false` = ikke hent fonter fra Google (personvern) |
| `RADIUS` | Hjørneradius i piksler (0 = skarpe hjørner) |
| `SHOW_BAND` | Det vevde båndet øverst (`true`/`false`) |
| `FOOTER_TEXT`, `PRIVACY_URL` | Bunntekst og lenke til personvernerklæring |
| `CUSTOM_CSS_URL` | Eget stilark for alt annet |

**Egne filer:** Legg logo, favicon eller stilark i mappen `branding/`. De blir tilgjengelige som `/assets/custom/<filnavn>` – både lokalt og i Docker (mappen monteres inn). Eksempel: `LOGO_URL=/assets/custom/logo.svg`. Logoen brukes også i PDF-billetten og e-postene, og må da være PNG, JPEG eller SVG.

**Logoen i e-postene** bygges inn i selve e-posten som et PNG-bilde (vedlegg med Content-ID, vist med `src="cid:logo"`), ikke som en lenke til bildet på nettstedet. En lenke virker dårlig i e-post: Gmail, Outlook og de fleste andre viser ikke SVG i det hele tatt, mange klienter (bl.a. Outlook) viser ikke bilder fra nettet før mottakeren trykker «Vis bilder», og bildet må kunne hentes fra internett (ikke fra localhost, LAN eller bak Cloudflare Access). PNG-en lages én gang ved oppstart fra `LOGO_URL` – SVG tegnes skarpt i riktig størrelse, i dobbel oppløsning for skjermer med høy pikseltetthet – med høyden `LOGO_HEIGHT` og maks 480 piksler bred. Bredde og høyde står både som attributter og i `style`, fordi Outlook for Windows bare ser på attributtene. Kan logoen ikke leses (f.eks. WebP), står lenken til den i e-posten som før, og loggen sier fra ved oppstart.

Nyanser som hover-farger og lyse bakgrunner på meldinger regnes ut fra grunnfargene med CSS `color-mix()`, så hele siden følger med når du bytter `COLOR_ACCENT`.

### Skins per arrangement

Variablene over gir nettstedets tema. I tillegg kan arrangøren velge et **utseende (skin)** for hvert arrangement i skjemaet:

- Standard
- Lys
- Mørk
- Glass
- Glød
- Fjord
- Høy kontrast

Skinnen legges oppå temaet og gjelder sidene gjestene og dørvaktene ser. Admin-sidene, e-postene, PDF og Wallet beholder nettstedets tema.

**Egne skins:** Eieren legger en CSS-fil i mappen `./skins`, som i Docker er montert som `/app/skins`, og starter appen på nytt. Hvordan en skin lages, hvilke variabler som finnes, og hva som er lov (fonter, bilder), står i [docs/skins.md](docs/skins.md).

---

## Sikkerhet og personvern

- **Ingen oversikt over arrangementer**, `robots.txt` med `Disallow: /` og `X-Robots-Tag: noindex`.
- **Lukket uten lenke:** forsiden, ukjente adresser og ugyldige lenker gir alle det samme nakne `404 Not Found`. `OPTIONS` besvares også med 404, så det ikke røper hvilke adresser som finnes.
- **Hemmelige nøkler** lagres bare som SHA-256-hash og sammenlignes i konstant tid.
- **Nettstedet og admin-vertsnavnet** avgjøres av `Host`-headeren, ikke `X-Forwarded-Host` (som en klient kan sette selv).
- **LAN-porten** (`LAN_PORT`) er betrodd fordi forespørselen kom inn på den lytteren – ingen header, query eller informasjonskapsel kan gjøre en forespørsel på `PORT` betrodd.
- **`Referrer-Policy: no-referrer`**, slik at arrangementets adresse ikke lekker til eksterne nettsteder, f.eks. der forsidebildet ligger.
- **Content-Security-Policy** tillater bare egne skript, og all brukertekst settes som tekst i DOM-en (aldri `innerHTML`). Tekst i e-postene og i temaet HTML-escapes, og farger/fonter fra `.env` valideres før de settes inn i CSS.
- **Avmelding krever et klikk på en knapp.** Mange e-posttjenester åpner lenker automatisk for å sjekke dem for virus, og det skal ikke melde noen av.
- **Plassene kan ikke overbookes.** Påmeldingen teller og lagrer i én `BEGIN IMMEDIATE`-transaksjon (testet med 10 samtidige påmeldinger til 3 plasser, og 6 samtidige grupper på 2 til 5 plasser). En gruppe får plass samlet eller ikke i det hele tatt – det blir aldri halve påmeldinger.
- **Spam-vern:** rate limiting per klient-IP (30 påmeldinger per 10 min) og et skjult honningkrukke-felt som roboter fyller ut.
- **CSV-eksporten** nøytraliserer celler som begynner med `= + - @`, slik at Excel ikke tolker dem som formler.
- Avmelding og sletting fjerner personopplysningene helt fra databasen (`secure_delete`), og alt slettes automatisk 30 dager etter arrangementet.
- **Billettlenker** er signert med HMAC (128 bit) og kan ikke forfalskes eller gjettes. Innsjekking krever dørvaktinnlogging, en `POST` fra siden (aldri bare en åpnet lenke) og samme `Origin` som nettstedet (CSRF-vern i tillegg til `SameSite=Lax`).
- **Dørvakter** ser bare navn og status, og dørvaktlenken kan byttes når som helst.
- **Kalenderfiler** inneholder aldri billett- eller avmeldingslenker.

---

## Datamodell

```
meta            Hemmeligheten billett-, påmeldings- og dørvaktnøklene avledes fra
events          Arrangementet (nettsted, tittel, tid, sted med kartpunkt, kapasitet, felter, brytere,
                skin, etteranmelding, avlysning, dørvaktversjon, når rapporten ble sendt …)
 └─ bookings    Én påmelding: kontaktperson, påmeldingsnummer, etteranmelding
     └─ registrations   Én rad per gjest: navn, valgfri e-post, svar, billettnummer og innsjekking
```

Antall påmeldte er antall rader i `registrations`. Hvis alle personene i en påmelding meldes av eller fjernes, slettes også påmeldingen, og avmeldingslenken slutter å virke.

Databasen oppgraderes automatisk ved oppstart (`PRAGMA user_version`):

| Versjon | Endring |
|---|---|
| 1 | Arrangementer og påmeldinger (én person per påmelding) |
| 2 | Påmeldinger med flere personer (`bookings`). Eksisterende påmeldinger beholdes, og avmeldingslenker som allerede er sendt ut, virker fortsatt. |
| 3 | Nettsted per arrangement (`events.site`). Eksisterende arrangementer havner på hovednettstedet (`main`). |
| 4 | Billetter, innsjekking, kartpunkt, brytere, etteranmelding, skin og avlysning. Eksisterende påmeldinger får billettnummer, og arrangementer med passert frist får ingen rapport ved oppgraderingen. |
| 5 | Dørkode per person (eksisterende påmeldinger får en) og tabellen `event_images` for opplastede bilder. |
| 6 | Bryter for selvavmelding (`events.self_cancel_enabled`, på). Den tilfeldige avmeldingsnøkkelen (`bookings.cancel_token_hash`) fjernes – avmeldingsnøklene avledes nå fra påmeldings- og billettnummeret. `bookings` bygges opp på nytt med de samme id-ene. |
| 7 | Delingsbildet (`event_images.og_data`). Eksisterende forsidebilder får det ved første vedlikehold etter oppgraderingen. |

Migreringene kjøres med fremmednøkler slått av, og hver migrering kjører `PRAGMA foreign_key_check` før den lagres (slik SQLite anbefaler for ombygging av tabeller). Ellers ville `DROP TABLE bookings` i versjon 6 slettet alle deltakerne via `ON DELETE CASCADE`.

## Prosjektstruktur

```
src/
  server.js      Starter serveren (PORT, og den betrodde LAN-lytteren når LAN_PORT er satt)
  app.js         Ruter: sider, offentlig API og admin-API bak admin-porten
  cfAccess.js    Verifisering av Cloudflare Access-token (JWT)
  sites.js       Nettsteder fra miljøvariabler (hovednettsted + SITE_<ID>_*, arv)
  theme.js       Utseende fra miljøvariabler (validering, temastilark, topp og bunn)
  views.js       Fletter tema og tekst inn i HTML-sidene, per nettsted
  db.js          SQLite: tabeller, migreringer og spørringer
  validation.js  Validering av arrangementer og påmeldinger, og påmeldingsstatus
  email.js       Resend-klient og e-postmaler
  ids.js         Tilfeldige lenker, nøkler og billettnumre, hashing
  tokens.js      Signerte billett-, påmeldings- og dørvaktnøkler (HMAC)
  tickets.js     Billettsider, PDF, Wallet, kalender og innsjekking (sider og API)
  qr.js          QR-koder (SVG og rutenett til PDF)
  pdf.js         PDF-billett (billettform med logo, QR-kode og dørkode)
  logo.js        Logoen til PDF-billetten og e-postene (fra branding/ eller https; PNG, JPEG, SVG)
  emailLogo.js   Logoen bygget inn i e-postene som PNG (Content-ID)
  calendar.js    Kalenderfil (.ics) og Google Kalender-lenke
  appleWallet.js Apple Wallet-kort (.pkpass/.pkpasses) med PKCS#7-signatur
  googleWallet.js Google Wallet-lenke (JWT)
  walletConfig.js Sertifikater og nøkler til Wallet fra filer
  zip.js, png.js Minimal ZIP-skriver og PNG-koder (til Wallet-kortene)
  places.js      Stedsoppslag mot Kartverket og kartlenker
  images.js      Opplastede bilder: filtype, grenser og fjerning av metadata
  ogImage.js     Delingsbildet (og:image, 1200 × 630 JPEG) laget fra det opplastede bildet (sharp)
  skins.js       Innebygde og egne skins
  filename.js    Filnavn til vedlegg og nedlastinger
  csv.js         CSV-eksport
  format.js      Datoer og svar på nettstedets språk
  html.js        HTML-escaping
  rateLimit.js   Enkel rate limiting
  config.js      Miljøvariabler
  version.js     Versjonsnummeret (år.måned.dag.løpenummer) fra VERSION
scripts/
  bump-version.js  `npm run bump`: øker versjonsnummeret i VERSION
VERSION          Versjonsnummeret som vises nederst til høyre på sidene
views/           HTML-sidene (med plassholdere for tema og tekst)
public/assets/   CSS og JavaScript for frontend
  i18n/          Ordbøkene (nb.js, en.js), oversetter og datoformatering – delt med serveren
  skins/         De innebygde skinnene
branding/        Egne filer (logo o.l.), serveres som /assets/custom/
skins/           Eierens egne skins (se docs/skins.md)
secrets/         Sertifikater og nøkler til Wallet (holdes utenfor git)
docs/            Dokumentasjon (skins)
test/            Tester (node:test)
```

### API

| Metode | Sti | Tilgang |
|---|---|---|
| `GET` | `/api/events/:slug` | Offentlig. Ukjent arrangement gir naken `404` |
| `POST` | `/api/events/:slug/registrations` | Offentlig. Body: `{ name, email, answers, guests: [{ name, email?, answers }] }`. Svaret har `links`: `tickets`, `apple`, `google`, `pdf`, `ics`, `googleCalendar` og `cancel` (`null` når av) |
| `POST` | `/api/events/:slug/cancel/lookup` | Avmeldingsnøkkel i body. Gir personene nøkkelen kan melde av, og `personal` (én persons egen lenke). `403` når avmelding er slått av |
| `POST` | `/api/events/:slug/cancel` | Avmeldingsnøkkel i body. `ids` (valgfritt) velger hvem; uten `ids` meldes alle nøkkelen gjelder av. `403` når avmelding er slått av |
| `GET` | `/api/admin/config` | Admin-porten. Gir bl.a. nettstedene som kan velges |
| `POST` | `/api/admin/events` | Admin-porten (krever Cloudflare Access). `site` velger nettsted (standard hovednettstedet) |
| `GET` / `PUT` / `DELETE` | `/api/admin/events/:slug` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `DELETE` | `/api/admin/events/:slug/registrations/:id` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `GET` | `/api/admin/events/:slug/registrations.csv` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `POST` / `DELETE` | `/api/admin/events/:slug/registrations/:id/checkin` | Admin-porten + admin-nøkkel. Sjekk inn / angre |
| `POST` | `/api/admin/events/:slug/scanner/rotate` | Admin-porten + admin-nøkkel. Ny dørvaktlenke |
| `POST` / `DELETE` | `/api/admin/events/:slug/cancel` | Admin-porten + admin-nøkkel. Avlys (`{ notify, message }`) / opphev |
| `GET` | `/api/admin/places?q=` | Admin-porten. Stedsoppslag hos Kartverket |
| `PUT` / `DELETE` | `/api/admin/events/:slug/image` | Admin-porten + admin-nøkkel. Last opp forsidebilde (selve bildet som body, `Content-Type: image/…`) / fjern. Svaret har `uploadedImage` og `ogImage` (delingsbildet) |
| `GET` | `/api/tickets/:nøkkel`, `/api/bookings/:nøkkel` | Billettlenken. Billetten(e), lenker og om telefonen er dørvakt |
| `POST` | `/api/events/:slug/scanner/login` | Dørvaktnøkkel i body. Setter informasjonskapselen |
| `GET` | `/api/events/:slug/scanner`, `…/scanner/search?q=` | Dørvakt. Status og liste for bruk uten nett; navnesøk |
| `POST` | `/api/events/:slug/scanner/checkin`, `…/scanner/undo` | Dørvakt. `{ token }`, `{ code }` (dørkode eller billettnummer) eller `{ id }`; angre med `{ id }` |

*Admin-porten* = riktig vertsnavn (hvis `ADMIN_HOST` er satt) og gyldig Cloudflare Access-token (hvis `CF_ACCESS_*` er satt).

---

## Mulige utvidelser

- Oversikt over alle arrangementer på `/admin` for den som er logget inn via Access
- Venteliste når arrangementet er fullt
- Påminnelse på e-post dagen før
- Gjest kan endre svarene sine, eller legge til personer i en eksisterende påmelding
- Felter som bare spørres én gang per påmelding (f.eks. telefon til kontaktpersonen), ikke per person
- Oppdatering av Wallet-kort som allerede er lagt til (Apples push-tjeneste og Googles API)
- Betaling (f.eks. Vipps eller Stripe)
