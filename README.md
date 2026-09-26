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

Backend: Node.js, Express og SQLite. Frontend: ren HTML, CSS og JavaScript uten byggesteg.
Produksjon: `docker compose` med Cloudflare Tunnel – ingen åpne porter på serveren.

---

## Adressene

| Adresse | Hvem | Hva |
|---|---|---|
| `/<hash>` | Alle som får lenken | Arrangementsside med påmelding |
| `/<hash>/avmelding#<nøkkel>` | Den som meldte på (lenke i e-posten) | Avmelding av hele eller deler av påmeldingen |
| `/admin/ny` | Administrator | Opprett nytt arrangement |
| `/admin/<hash>#<nøkkel>` | Arrangøren (lenke i e-posten) | Påmeldte, redigering, CSV, stenging, sletting |

Gamle adresser fra før admin ble samlet (`/ny` og `/<hash>/admin#<nøkkel>`) sendes automatisk videre.

### Hvor vanskelig er lenkene å gjette?

`<hash>` er 12 tilfeldige tegn fra et alfabet på 31 tegn (små bokstaver og tall, uten `0 o 1 l i`, som lett forveksles). Antall mulige lenker er

$$31^{12} \approx 7{,}9 \cdot 10^{17} \approx 2^{59{,}4}$$

Selv med 1000 gjett i sekundet tar det i snitt $\frac{31^{12}}{2 \cdot 1000 \cdot N}$ sekunder å treffe ett av $N$ arrangementer. Med $N = 1000$ er det rundt $4 \cdot 10^{11}$ sekunder, altså over 12 000 år.

Admin-nøkkelen er 24 tilfeldige byte, altså $2^{192}$ muligheter – den kan ikke gjettes.

Nøklene etter `#` sendes **aldri** til serveren av nettleseren. De havner derfor ikke i serverlogger, proxy-logger eller `Referer`-headere. JavaScript på siden leser nøkkelen og sender den i `Authorization`-headeren. I databasen lagres bare SHA-256-hashen av nøklene.

---

## Kom i gang lokalt

Krever Node.js 22.9 eller nyere (og Python + C++-kompilator for `better-sqlite3`, som finnes på de fleste utviklermaskiner).

```bash
npm install
cp .env.example .env      # tøm DOMAIN, og sett ADMIN_PASSWORD
npm run dev               # starter på http://localhost:3000 og laster på nytt ved endringer
```

1. Gå til <http://localhost:3000/admin/ny>, skriv inn `ADMIN_PASSWORD` og opprett et arrangement.
2. Du får en påmeldingslenke og en administrasjonslenke.
3. Uten `RESEND_API_KEY` skrives e-postene til terminalen, så du ser nøyaktig hva som ville blitt sendt (inkludert avmeldingslenken).

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
└── branding/         ← valgfritt: logo, favicon, eget stilark
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

**B. Samme domene, egne stier:** Lag én Access-applikasjon for `booking.domain.com` med **to** stier: `admin` og `api/admin`. Glemmer du `api/admin`, er selve dataene ubeskyttet av Access – derfor anbefales C i tillegg.

**C. La appen verifisere Access (anbefalt i tillegg til A eller B):**

Sett `CF_ACCESS_TEAM_DOMAIN` (Zero Trust → Settings → Custom Pages → *Team domain*) og `CF_ACCESS_AUD` (applikasjonens *Application Audience (AUD) Tag*). Da sjekker appen selv signaturen på Access-tokenet Cloudflare sender med hver forespørsel, og avviser alt til `/admin` og `/api/admin` som ikke har passert Access. En feilkonfigurert Access-regel kan dermed ikke gjøre admin offentlig.

Med C kan `ADMIN_PASSWORD` stå tomt – Access er innloggingen. Settes det likevel, kreves det i tillegg.

**Arrangører:** Admin-lenken per arrangement (`/admin/<hash>#<nøkkel>`) krever fortsatt sin egen nøkkel. Med Access må arrangørene i tillegg slippes inn av Access-policyen – legg til e-postadressene deres der, eller behold administrasjonen for deg selv.

### Lagene som beskytter administrasjonen

| Lag | Beskytter mot |
|---|---|
| Cloudflare Access (innlogging) | Alle som ikke er på lista di |
| `ADMIN_HOST` | At admin i det hele tatt finnes på det offentlige domenet |
| Appens egen Access-sjekk (`CF_ACCESS_*`) | Feilkonfigurerte Access-regler |
| Admin-nøkkel per arrangement | At én arrangør ser andres arrangementer |
| `ADMIN_PASSWORD` (valgfritt med Access) | Oppretting av arrangementer uten Access |
| Rate limiting per ekte klient-IP | Gjetting av passord (maks 20 forsøk per 15 min) |

### Sikkerhetskopi

SQLite-databasen er én fil i volumet. Ta en trygg kopi mens appen kjører:

```bash
docker compose exec booking node -e "require('better-sqlite3')('/data/booking.db').backup('/data/backup.db').then(() => console.log('ok'))"
docker compose cp booking:/data/backup.db ./backup-$(date +%F).db
```

### Uten Docker eller Cloudflare

Appen er en vanlig Node-server (`npm start`) og kan kjøres bak hvilken som helst reverse proxy (nginx, Caddy …). Sett da `TRUST_PROXY=1` (ikke `CLIENT_IP_HEADER`) og `DATABASE_PATH` til en fil på en persistent disk.

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
| Arrangementet er opprettet (med admin-lenke) | Arrangøren | – |
| Avmelding (kvittering og varsel) | Gjesten og arrangøren | Hverandre |

Hvis Resend feiler, blir påmeldingen likevel lagret. Feilen logges, og gjesten får beskjed om at bekreftelsen ikke kom frem.

---

## Utseende

Alt settes i `.env` – se `.env.example` for hele lista med forklaringer. Ugyldige verdier (f.eks. en farge med skrivefeil) ignoreres, og appen skriver en advarsel i loggen ved oppstart.

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
| `HOME_TITLE`, `HOME_TEXT` | Forsiden |
| `FOOTER_TEXT`, `PRIVACY_URL` | Bunntekst og lenke til personvernerklæring |
| `CUSTOM_CSS_URL` | Eget stilark for alt annet |

**Egne filer:** Legg logo, favicon eller stilark i mappen `branding/`. De blir tilgjengelige som `/assets/custom/<filnavn>` – både lokalt og i Docker (mappen monteres inn). Eksempel: `LOGO_URL=/assets/custom/logo.svg`.

Nyanser som hover-farger og lyse bakgrunner på meldinger regnes ut fra grunnfargene med CSS `color-mix()`, så hele siden følger med når du bytter `COLOR_ACCENT`.

---

## Sikkerhet og personvern

- **Ingen oversikt over arrangementer**, `robots.txt` med `Disallow: /` og `X-Robots-Tag: noindex`.
- **Hemmelige nøkler** lagres bare som SHA-256-hash og sammenlignes i konstant tid.
- **Admin-vertsnavnet** sjekkes mot `Host`-headeren, ikke `X-Forwarded-Host` (som en klient kan sette selv).
- **`Referrer-Policy: no-referrer`**, slik at arrangementets adresse ikke lekker til eksterne nettsteder, f.eks. der forsidebildet ligger.
- **Content-Security-Policy** tillater bare egne skript, og all brukertekst settes som tekst i DOM-en (aldri `innerHTML`). Tekst i e-postene og i temaet HTML-escapes, og farger/fonter fra `.env` valideres før de settes inn i CSS.
- **Avmelding krever et klikk på en knapp.** Mange e-posttjenester åpner lenker automatisk for å sjekke dem for virus, og det skal ikke melde noen av.
- **Plassene kan ikke overbookes.** Påmeldingen teller og lagrer i én `BEGIN IMMEDIATE`-transaksjon (testet med 10 samtidige påmeldinger til 3 plasser, og 6 samtidige grupper på 2 til 5 plasser). En gruppe får plass samlet eller ikke i det hele tatt – det blir aldri halve påmeldinger.
- **Spam-vern:** rate limiting per klient-IP (30 påmeldinger per 10 min) og et skjult honningkrukke-felt som roboter fyller ut.
- **CSV-eksporten** nøytraliserer celler som begynner med `= + - @`, slik at Excel ikke tolker dem som formler.
- Avmelding og sletting fjerner personopplysningene helt fra databasen.

---

## Datamodell

```
events          Arrangementet (tittel, tid, kapasitet, maks per påmelding, felter …)
 └─ bookings    Én påmelding: kontaktperson (navn + e-post) og avmeldingsnøkkel
     └─ registrations   Én rad per gjest: navn, valgfri e-post og svar på feltene
```

Antall påmeldte er antall rader i `registrations`. Hvis alle personene i en påmelding meldes av eller fjernes, slettes også påmeldingen, og avmeldingslenken slutter å virke.

Databasen oppgraderes automatisk ved oppstart (`PRAGMA user_version`). En database fra første versjon, der hver påmelding var én person, migreres uten tap av data, og avmeldingslenker som allerede er sendt ut, virker fortsatt.

## Prosjektstruktur

```
src/
  server.js      Starter serveren
  app.js         Ruter: sider, offentlig API og admin-API bak admin-porten
  cfAccess.js    Verifisering av Cloudflare Access-token (JWT)
  theme.js       Utseende fra miljøvariabler (validering, theme.css, topp og bunn)
  views.js       Fletter temaet inn i HTML-sidene
  db.js          SQLite: tabeller, migreringer og spørringer
  validation.js  Validering av arrangementer og påmeldinger, og påmeldingsstatus
  email.js       Resend-klient og e-postmaler
  ids.js         Tilfeldige lenker og nøkler, hashing
  csv.js         CSV-eksport
  format.js      Datoformatering (norsk)
  html.js        HTML-escaping
  rateLimit.js   Enkel rate limiting
  config.js      Miljøvariabler
views/           HTML-sidene (med plassholdere for temaet)
public/assets/   CSS og JavaScript for frontend
branding/        Egne filer (logo o.l.), serveres som /assets/custom/
test/            Tester (node:test)
```

### API

| Metode | Sti | Tilgang |
|---|---|---|
| `GET` | `/api/events/:slug` | Offentlig |
| `POST` | `/api/events/:slug/registrations` | Offentlig. Body: `{ name, email, answers, guests: [{ name, email?, answers }] }` |
| `POST` | `/api/events/:slug/cancel/lookup` | Avmeldingsnøkkel i body. Gir personene i påmeldingen |
| `POST` | `/api/events/:slug/cancel` | Avmeldingsnøkkel i body. `ids` (valgfritt) velger hvem; uten `ids` meldes alle av |
| `GET` | `/api/admin/config` | Admin-porten |
| `POST` | `/api/admin/events` | Admin-porten + `X-Admin-Password` (hvis satt) |
| `GET` / `PUT` / `DELETE` | `/api/admin/events/:slug` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `DELETE` | `/api/admin/events/:slug/registrations/:id` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |
| `GET` | `/api/admin/events/:slug/registrations.csv` | Admin-porten + `Authorization: Bearer <admin-nøkkel>` |

*Admin-porten* = riktig vertsnavn (hvis `ADMIN_HOST` er satt) og gyldig Cloudflare Access-token (hvis `CF_ACCESS_*` er satt).

---

## Mulige utvidelser

- Oversikt over alle arrangementer på `/admin` for den som er logget inn via Access
- Venteliste når arrangementet er fullt
- Påminnelse på e-post dagen før
- Gjest kan endre svarene sine, eller legge til personer i en eksisterende påmelding
- Felter som bare spørres én gang per påmelding (f.eks. telefon til kontaktpersonen), ikke per person
- Egen bekreftelse til personer som er lagt til med e-postadresse
- Opplasting av forsidebilde (i dag er det en lenke)
- Betaling (f.eks. Vipps eller Stripe)
