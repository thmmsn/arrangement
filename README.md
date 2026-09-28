# Booking – enkelt påmeldingssystem

Et lite og enkelt alternativ til Hoopla for påmelding til arrangementer:

- **Arrangementer kan bare nås via lenke** – `booking.domain.com/<hash>`. Det finnes ingen oversikt, og søkemotorer blir bedt om å holde seg unna.
- **Påmelding med navn, e-post og egendefinerte felter** (kort tekst, lang tekst, telefon, tall, nedtrekksliste, avkrysning).
- **Den som melder på kan legge til flere personer** i samme skjema. Hver person er én gjest og tar én plass, og hver person svarer på de egendefinerte feltene (f.eks. allergier). Arrangøren bestemmer hvor mange som kan meldes på om gangen (standard 10, 1 = bare seg selv).
- **Antall påmeldte vises** på arrangementssiden (kan skrus av), med ledige plasser hvis det er et tak.
- **E-post via [Resend](https://resend.com)**: én bekreftelse til den som meldte på (med alle personene), ett varsel til arrangøren, admin-lenke ved opprettelse og kvittering ved avmelding.
- **Avmelding per person**: avmeldingslenken lar deg velge hvem i påmeldingen som skal meldes av.
- **All administrasjon under `/admin`** – enkelt å skjule bak Cloudflare Access, på eget subdomene eller egen sti.
- **Utseendet styres med miljøvariabler**: navn, logo, farger, fonter, hjørneradius og tekster.
- **Flere domener, én database og én admin**: hvert domene er et *nettsted* med eget språk (norsk eller engelsk), tema, avsender og base-URL.
- **Helt lukket uten lenke**: forsiden og alle ukjente adresser svarer bare `404 Not Found` – uten logo, navn eller språk.
- **Mobilbillett med QR-kode** per person, med billettnummer, PDF-billett i e-posten, **Apple Wallet** og **Google Wallet** – som Hoopla.
- **Innsjekking i døra**: en egen dørvaktlenke. Dørvakten kan skanne QR-koden med vanlig kamera på iPhone, bruke skanneren på siden, taste inn billettnummeret eller søke på navn. Det gir grønt, gult eller rødt svar med «Angre», og innsjekking virker også uten nett.
- **Kalenderfil (.ics)** til deltakerne, og lenke til Google Kalender.
- **Sted fra Kartverket** (adresse, stedsnavn eller gnr/bnr) med kartpunkt, som gir **veibeskrivelse** på sidene, i e-posten og i Wallet. Wallet-kortet dukker opp av seg selv når tiden nærmer seg og man er i nærheten.
- **Brytere per arrangement**: billett, kalender, PDF og Wallet er på som standard og kan slås av hver for seg.
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
| `/<hash>/avmelding#<nøkkel>` | Den som meldte på (lenke i e-posten) | Avmelding av hele eller deler av påmeldingen |
| `/admin/ny` | Administrator | Opprett nytt arrangement |
| `/admin/<hash>#<nøkkel>` | Arrangøren (lenke i e-posten) | Påmeldte, innsjekking, dørvaktlenke, redigering, CSV, stenging, avlysning, sletting |
| `/admin/<hash>/avlys#<nøkkel>` | Arrangøren og tjenesteadministratoren (lenke i e-posten) | Samme side, åpnet på «Avlys arrangement» |
| `/b/<nøkkel>` | Den som meldte på (lenke i e-posten) | Alle billettene i påmeldingen, med Wallet, PDF og kalender |
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

- **booking** – appen. Databasen ligger i volumet `booking-data`, så den overlever nye versjoner.
- **cloudflared** – kobler seg *ut* til Cloudflare. Ingen porter åpnes på serveren; appen kan bare nås gjennom tunnelen.

### 1. Opprett tunnelen

1. Cloudflare-dashbordet → **Zero Trust → Networks → Tunnels → Create a tunnel** → velg *Cloudflared* → gi den et navn.
2. Velg *Docker* som miljø og kopier tokenet (den lange strengen etter `--token`). Sett det som `TUNNEL_TOKEN` i `.env`.
3. Under **Public Hostname** legger du til:

   | Hostname | Service |
   |---|---|
   | `booking.domain.com` | `HTTP` → `booking:3000` |
   | `booking.domain.net` *(ett per ekstra nettsted, se [Flere nettsteder](#flere-nettsteder))* | `HTTP` → `booking:3000` |
   | `booking-admin.domain.com` *(hvis du bruker eget admin-vertsnavn)* | `HTTP` → `booking:3000` |

   `booking` er navnet på app-containeren i `docker-compose.yml`, så cloudflared finner den direkte.

### 2. Fyll inn `.env` og start

```bash
cp .env.example .env
nano .env                       # DOMAIN, TUNNEL_TOKEN, RESEND_API_KEY, EMAIL_FROM, …
docker compose up -d --build
docker compose logs -f booking  # se at alt starter, og eventuelle advarsler
```

Etter endringer i `.env`: kjør `docker compose up -d` på nytt, så startes appen med de nye verdiene. Ny versjon av koden: `git pull && docker compose up -d --build`.

Noen innstillinger er låst i `docker-compose.yml` med vilje, uansett hva `.env` sier: databasen ligger alltid i volumet (`/data/booking.db`), klient-IP leses fra Cloudflares `cf-connecting-ip`, og appen får ikke se `TUNNEL_TOKEN`.

### 3. Skjul administrasjonen bak Cloudflare Access

All administrasjon ligger under `/admin` (sider) og `/api/admin` (API). Resten – arrangementssider, påmelding og avmelding – er offentlig. Velg én av to måter:

**A. Eget subdomene (anbefalt)** – enklest å få riktig:

1. Sett `ADMIN_HOST=booking-admin.domain.com` i `.env`. Da finnes `/admin` og `/api/admin` *bare* på det vertsnavnet; på `booking.domain.com` gir de 404. Admin-lenkene i e-postene peker dit.
2. Legg til vertsnavnet i tunnelen (se over).
3. **Zero Trust → Access → Applications → Add an application → Self-hosted**, domene `booking-admin.domain.com` (hele), og en policy som slipper inn deg (og eventuelle arrangører), f.eks. *Emails* med innlogging via engangskode.

> Bruk ett nivå under domenet (`booking-admin.domain.com`), ikke `admin.booking.domain.com` – Cloudflares gratis sertifikat dekker bare ett nivå.

Med flere nettsteder er A det klart beste valget: ellers finnes `/admin` på hvert eneste offentlige domene, og hvert domene trenger sin egen Access-regel. Uten `ADMIN_HOST` skriver appen en advarsel ved oppstart.

**B. Samme domene, egne stier:** Lag én Access-applikasjon for `booking.domain.com` med **to** stier: `admin` og `api/admin`. Glemmer du `api/admin`, er selve dataene ubeskyttet av Access – derfor anbefales C i tillegg.

**C. La appen verifisere Access (påkrevd, i tillegg til A eller B):**

Sett `CF_ACCESS_TEAM_DOMAIN` (Zero Trust → Settings → Custom Pages → *Team domain*) og `CF_ACCESS_AUD` (applikasjonens *Application Audience (AUD) Tag*). Da sjekker appen selv signaturen på Access-tokenet Cloudflare sender med hver forespørsel, og avviser alt til `/admin` og `/api/admin` som ikke har passert Access. En feilkonfigurert Access-regel kan dermed ikke gjøre admin offentlig.

Access er den eneste innloggingen – det finnes ikke noe passord. Uten C er oppretting av arrangementer derfor slått av, slik at en glemt innstilling aldri gjør det mulig for hvem som helst å opprette arrangementer og sende e-post i ditt navn. For lokal utvikling uten Access finnes `ADMIN_NO_AUTH=true`, som appen varsler tydelig om ved oppstart, og som ikke har noen virkning når Access er satt opp.

**Arrangører:** Admin-lenken per arrangement (`/admin/<hash>#<nøkkel>`) krever fortsatt sin egen nøkkel. Med Access må arrangørene i tillegg slippes inn av Access-policyen – legg til e-postadressene deres der, eller behold administrasjonen for deg selv.

### Lagene som beskytter administrasjonen

| Lag | Beskytter mot |
|---|---|
| Cloudflare Access (innlogging) | Alle som ikke er på lista di |
| `ADMIN_HOST` | At admin i det hele tatt finnes på det offentlige domenet |
| Appens egen Access-sjekk (`CF_ACCESS_*`) | Feilkonfigurerte Access-regler |
| Admin-nøkkel per arrangement | At én arrangør ser andres arrangementer |
| Oppretting slått av uten Access | At en glemt innstilling åpner for oppretting |
| Rate limiting per ekte klient-IP | Masseoppretting og spam (maks 20 nye arrangementer per 15 min) |

### Sikkerhetskopi

SQLite-databasen er én fil i volumet. Ta en trygg kopi mens appen kjører:

```bash
docker compose exec booking node -e "require('better-sqlite3')('/data/booking.db').backup('/data/backup.db').then(() => console.log('ok'))"
docker compose cp booking:/data/backup.db ./backup-$(date +%F).db
```

### Uten Docker eller Cloudflare

Appen er en vanlig Node-server (`npm start`) og kan kjøres bak hvilken som helst reverse proxy (nginx, Caddy …). Sett da `TRUST_PROXY=1` (ikke `CLIENT_IP_HEADER`) og `DATABASE_PATH` til en fil på en persistent disk.

---

## Flere nettsteder

Samme app, database og admin kan betjene flere offentlige domener samtidig. Hvert domene er et **nettsted** med eget språk, tema, avsenderadresse og egen base-URL. Hvert arrangement hører til ett nettsted.

### Oppsett – eksempel med to domener

```ini
# Hovednettstedet: dagens variabler, uendret
DOMAIN=booking.domain.com
SITE_LANG=nb
SITE_NAME=Påmelding
LOGO_URL=/assets/custom/logo.svg
EMAIL_FROM=Påmelding <booking@domain.com>
COLOR_ACCENT=#8b2e2a

# Et ekstra nettsted med prefikset SITE_NET_
SITE_NET_DOMAIN=booking.domain.net
SITE_NET_LANG=en
SITE_NET_SITE_NAME=Registration
SITE_NET_LOGO_URL=/assets/custom/logo-en.svg
SITE_NET_EMAIL_FROM=Registration <booking@domain.net>
# SITE_NET_COLOR_ACCENT er ikke satt → arves fra hovednettstedet (#8b2e2a)

# Anbefalt: admin på eget vertsnavn, så /admin ikke finnes på noen av de offentlige domenene
ADMIN_HOST=booking-admin.domain.com
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

Hver person i en påmelding får en billett med QR-kode og et billettnummer, for eksempel `K7HQ-2MXP-R9`. Bekreftelses-e-posten har en knapp til siden med alle billettene i påmeldingen (`/b/…`). Der kan man bla mellom billettene (1 / 3), laste ned PDF, legge dem i Apple Wallet eller Google Wallet og legge arrangementet i kalenderen. PDF-billetten (én side per person) og kalenderfilen ligger også ved e-posten. Etter påmeldingen vises knappen «Vis billettene» med én gang.

**QR-koden er en lenke:** `https://booking.domain.com/t/<billettnummer><signatur>`. Da kan den skannes med vanlig kamera på alle telefoner. Signaturen er

$$\text{signatur} = \mathrm{HMAC\text{-}SHA256}(\text{hemmelighet},\ \texttt{ticket:} \,\|\, \text{nummer})$$

forkortet til 128 bit. Hemmeligheten lages tilfeldig i databasen første gang appen starter. Serveren lagrer bare nummeret og regner ut lenken på nytt når den trengs (e-post, PDF, Wallet). En lekket database gir dermed ikke billettlenkene. En falsk eller endret lenke gir den nakne 404-en. Påmeldingslenken (`/b/…`) signeres med et annet formål, så den ene kan aldri brukes som den andre.

Billettlenken gir bare rett til å *se* billetten, altså navnet og arrangementet. Innsjekking krever i tillegg at telefonen er logget inn som dørvakt.

### Dørvaktlenken

På admin-siden og i den første e-posten til arrangøren står en **dørvaktlenke** (`/<hash>/skanner#<nøkkel>`). Arrangøren deler den med dem som skal stå i døra.

1. Dørvakten åpner lenken én gang og skriver eventuelt navnet sitt. Telefonen får en informasjonskapsel for arrangementet. Den er `HttpOnly`, `SameSite=Lax` og gyldig til to døgn etter at arrangementet er over. Nøkkelen fjernes fra adresselinjen.
2. **Med vanlig kamera** (iPhone eller Android): QR-koden åpner billetten, siden ser at telefonen tilhører en dørvakt og sjekker gjesten inn. Skjermen blir grønn («Sjekket inn»), gul («Allerede sjekket inn 18:02 av Kari») eller rød («Ugyldig billett», «Feil arrangement» eller «Avlyst»), med lyd og vibrasjon. «Angre» retter et feiltrykk.
3. **Skanneren på siden** (`/<hash>/skanner`) bruker kameraet direkte. Den bruker nettleserens innebygde QR-leser når den finnes, ellers [jsQR](https://github.com/cozmo/jsQR). Siden har også felt for **billettnummeret** og **søk på navn** (minst to tegn, maks ti treff) for gjester uten billett på telefonen.
4. **Hele familien på én gang:** etter en innsjekking vises de andre i samme påmelding med en «Sjekk inn»-knapp.

Innsjekkingen skjer alltid med en `POST` fra siden, aldri bare ved at lenken åpnes. E-postprogrammer og forhåndsvisninger åpner nemlig lenker av seg selv. Den er også atomisk (`UPDATE … WHERE checked_in_at IS NULL`), så to dørvakter som skanner samme billett samtidig aldri begge får «Sjekket inn».

**Dørvaktmodus:** dørvakten ser bare navn, hvem som meldte på og status, aldri e-post, telefonnummer eller svar på skjemaet.

**Uten nett:** skannersiden har en liste med navn og SHA-256-hasher av alle billettlenker og -numre. Forsvinner nettet, kjenner siden igjen en ekte billett selv og legger innsjekkingen i kø. Køen sendes, med riktig tidspunkt, så snart nettet er tilbake. Hashene kan ikke brukes til å lage billetter.

**Ny dørvaktlenke:** «Lag ny lenke» på admin-siden gjør den gamle ugyldig og logger ut alle telefoner som brukte den. Nøkkelen er avledet av arrangementet og et versjonsnummer, så den kan alltid vises på nytt.

På admin-siden er det en kolonne «Innsjekket» med tidspunkt og dørvakt, «Sjekk inn» og «Angre», og en teller. CSV-eksporten har kolonnene «Etteranmelding» og «Innsjekket».

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

1. *Certificates, Identifiers & Profiles → Identifiers → Pass Type IDs*: lag en id, f.eks. `pass.no.domain.booking`.
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

**Brytere:** Wallet-bryterne vises i skjemaet bare når tjenesten er satt opp. Mangler en fil eller variabel, slås Wallet av med en advarsel i loggen, og resten virker som før.

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
2. **Domains → Add Domain**: legg til `domain.com` (eller et underdomene som `mail.domain.com`). Resend viser noen DNS-poster (SPF/MX og DKIM, gjerne også DMARC) som du legger inn hos Cloudflare DNS. Vent til domenet står som *Verified*.
3. **API Keys → Create API Key** med tilgangen *Sending access*. Sett den som `RESEND_API_KEY`.
4. Sett `EMAIL_FROM` til en adresse på det verifiserte domenet, f.eks. `Påmelding <booking@domain.com>`.

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

**Egne filer:** Legg logo, favicon eller stilark i mappen `branding/`. De blir tilgjengelige som `/assets/custom/<filnavn>` – både lokalt og i Docker (mappen monteres inn). Eksempel: `LOGO_URL=/assets/custom/logo.svg`.

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
 └─ bookings    Én påmelding: kontaktperson, påmeldingsnummer, avmeldingsnøkkel (hash), etteranmelding
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

## Prosjektstruktur

```
src/
  server.js      Starter serveren
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
  pdf.js         PDF-billett
  calendar.js    Kalenderfil (.ics) og Google Kalender-lenke
  appleWallet.js Apple Wallet-kort (.pkpass/.pkpasses) med PKCS#7-signatur
  googleWallet.js Google Wallet-lenke (JWT)
  walletConfig.js Sertifikater og nøkler til Wallet fra filer
  zip.js, png.js Minimal ZIP-skriver og PNG-koder (til Wallet-kortene)
  places.js      Stedsoppslag mot Kartverket og kartlenker
  skins.js       Innebygde og egne skins
  filename.js    Filnavn til vedlegg og nedlastinger
  csv.js         CSV-eksport
  format.js      Datoer og svar på nettstedets språk
  html.js        HTML-escaping
  rateLimit.js   Enkel rate limiting
  config.js      Miljøvariabler
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
| `POST` | `/api/events/:slug/registrations` | Offentlig. Body: `{ name, email, answers, guests: [{ name, email?, answers }] }` |
| `POST` | `/api/events/:slug/cancel/lookup` | Avmeldingsnøkkel i body. Gir personene i påmeldingen |
| `POST` | `/api/events/:slug/cancel` | Avmeldingsnøkkel i body. `ids` (valgfritt) velger hvem; uten `ids` meldes alle av |
| `GET` | `/api/admin/config` | Admin-porten. Gir bl.a. nettstedene som kan velges |
| `POST` | `/api/admin/events` | Admin-porten (krever Cloudflare Access). `site` velger nettsted (standard hovednettstedet) |
| `GET` / `PUT` / `DELETE` | `/api/admin/events/:slug` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `DELETE` | `/api/admin/events/:slug/registrations/:id` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `GET` | `/api/admin/events/:slug/registrations.csv` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `POST` / `DELETE` | `/api/admin/events/:slug/registrations/:id/checkin` | Admin-porten + admin-nøkkel. Sjekk inn / angre |
| `POST` | `/api/admin/events/:slug/scanner/rotate` | Admin-porten + admin-nøkkel. Ny dørvaktlenke |
| `POST` / `DELETE` | `/api/admin/events/:slug/cancel` | Admin-porten + admin-nøkkel. Avlys (`{ notify, message }`) / opphev |
| `GET` | `/api/admin/places?q=` | Admin-porten. Stedsoppslag hos Kartverket |
| `GET` | `/api/tickets/:nøkkel`, `/api/bookings/:nøkkel` | Billettlenken. Billetten(e), lenker og om telefonen er dørvakt |
| `POST` | `/api/events/:slug/scanner/login` | Dørvaktnøkkel i body. Setter informasjonskapselen |
| `GET` | `/api/events/:slug/scanner`, `…/scanner/search?q=` | Dørvakt. Status og liste for bruk uten nett; navnesøk |
| `POST` | `/api/events/:slug/scanner/checkin`, `…/scanner/undo` | Dørvakt. `{ token }`, `{ code }` eller `{ id }`; angre med `{ id }` |

*Admin-porten* = riktig vertsnavn (hvis `ADMIN_HOST` er satt) og gyldig Cloudflare Access-token (hvis `CF_ACCESS_*` er satt).

---

## Mulige utvidelser

- Oversikt over alle arrangementer på `/admin` for den som er logget inn via Access
- Venteliste når arrangementet er fullt
- Påminnelse på e-post dagen før
- Gjest kan endre svarene sine, eller legge til personer i en eksisterende påmelding
- Felter som bare spørres én gang per påmelding (f.eks. telefon til kontaktpersonen), ikke per person
- Egen bekreftelse til personer som er lagt til med e-postadresse
- Opplasting av forsidebilde (i dag er det en lenke) – står i kø
- Kort dørkode på 4–5 bokstaver for raskere manuell innskriving – til vurdering
- Oppdatering av Wallet-kort som allerede er lagt til (Apples push-tjeneste og Googles API)
- Betaling (f.eks. Vipps eller Stripe)
