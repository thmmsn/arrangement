# Booking – enkelt påmeldingssystem

Et lite og enkelt alternativ til Hoopla for påmelding til arrangementer:

- **Arrangementer kan bare nås via lenke** – `booking.domain.com/<hash>`. Det finnes ingen oversikt, og søkemotorer blir bedt om å holde seg unna.
- **Påmelding med navn, e-post og egendefinerte felter** (kort tekst, lang tekst, telefon, tall, nedtrekksliste, avkrysning).
- **Én påmelding = én gjest.** Skal flere være med, melder man på én om gangen.
- **Antall påmeldte vises** på arrangementssiden (kan skrus av), med ledige plasser hvis det er et tak.
- **E-post via [Resend](https://resend.com)**: bekreftelse til gjesten, varsel til arrangøren, admin-lenke ved opprettelse og kvittering ved avmelding.
- **Admin-side per arrangement** via en hemmelig lenke: liste over påmeldte, CSV-eksport til Excel, redigering, stenging og sletting.

Backend: Node.js, Express og SQLite. Frontend: ren HTML, CSS og JavaScript uten byggesteg.

---

## Lenkene

| Lenke | Hvem | Hva |
|---|---|---|
| `/<hash>` | Alle som får lenken | Arrangementsside med påmelding |
| `/<hash>/admin#<nøkkel>` | Arrangøren | Påmeldte, redigering, CSV, stenging, sletting |
| `/<hash>/avmelding#<nøkkel>` | Gjesten (fra e-posten) | Avmelding |
| `/ny` | Den som kjenner `ADMIN_PASSWORD` | Opprett nytt arrangement |

`<hash>` er 12 tilfeldige tegn fra et alfabet på 31 tegn (små bokstaver og tall, uten `0 o 1 l i`, som lett forveksles). Antall mulige lenker er

$$31^{12} \approx 7{,}9 \cdot 10^{17} \approx 2^{59{,}4}$$

Selv med 1000 gjett i sekundet tar det i snitt $\frac{2^{59{,}4}}{2 \cdot 1000 \cdot N}$ sekunder å treffe ett av $N$ arrangementer. Med $N = 1000$ er det rundt $4 \cdot 10^{11}$ sekunder, altså over 12 000 år.

Nøklene etter `#` sendes **aldri** til serveren av nettleseren. De havner derfor ikke i serverlogger, proxy-logger eller `Referer`-headere. JavaScript på siden leser nøkkelen og sender den i `Authorization`-headeren. I databasen lagres bare SHA-256-hashen av nøklene.

---

## Kom i gang lokalt

Krever Node.js 22.9 eller nyere.

```bash
npm install
cp .env.example .env      # sett minst ADMIN_PASSWORD
npm run dev               # starter på http://localhost:3000 og laster på nytt ved endringer
```

1. Gå til <http://localhost:3000/ny>, skriv inn `ADMIN_PASSWORD` og opprett et arrangement.
2. Du får en påmeldingslenke og en administrasjonslenke.
3. Uten `RESEND_API_KEY` skrives e-postene til terminalen, så du ser nøyaktig hva som ville blitt sendt (inkludert avmeldingslenken).

Kjør testene:

```bash
npm test
```

---

## Sette opp Resend

1. Opprett konto på <https://resend.com>.
2. **Domains → Add Domain**: legg til `domain.com` (eller et underdomene som `mail.domain.com`). Resend viser noen DNS-poster (SPF/MX og DKIM, gjerne også DMARC) som du legger inn hos DNS-leverandøren. Vent til domenet står som *Verified*.
3. **API Keys → Create API Key** med tilgangen *Sending access*. Sett den som `RESEND_API_KEY`.
4. Sett `EMAIL_FROM` til en adresse på det verifiserte domenet, f.eks. `Påmelding <booking@domain.com>`.

Svar på e-postene går dit det gir mening (feltet `reply_to`):

| E-post | Til | Svar går til |
|---|---|---|
| Bekreftelse på påmelding | Gjesten | Arrangøren |
| Ny påmelding | Arrangøren | Gjesten |
| Arrangementet er opprettet (med admin-lenke) | Arrangøren | – |
| Avmelding (kvittering og varsel) | Gjesten og arrangøren | Hverandre |

Hvis Resend feiler, blir påmeldingen likevel lagret. Feilen logges, og gjesten får beskjed om at bekreftelsen ikke kom frem.

---

## Produksjon

### Konfigurasjon

| Variabel | Standard | Beskrivelse |
|---|---|---|
| `BASE_URL` | `http://localhost:PORT` | Offentlig adresse, brukes i lenkene i e-postene, f.eks. `https://booking.domain.com` |
| `PORT` | `3000` | Porten serveren lytter på |
| `ADMIN_PASSWORD` | *(tom)* | Kreves for å opprette arrangementer. Tom betyr at oppretting er slått av |
| `RESEND_API_KEY` | *(tom)* | Tom betyr at e-poster logges i stedet for å sendes |
| `EMAIL_FROM` | `Påmelding <booking@example.com>` | Avsender, må være på et domene verifisert i Resend |
| `DATABASE_PATH` | `data/booking.db` | SQLite-fil |
| `TIME_ZONE` | `Europe/Oslo` | Tidssonen tider vises og tolkes i |
| `TRUST_PROXY` | *(av)* | Sett til `1` bak én reverse proxy, så rate limiting ser gjestens ekte IP |

### Med Docker

```bash
docker build -t booking .
docker run -d --name booking -p 3000:3000 \
  -v booking-data:/data \
  -e BASE_URL=https://booking.domain.com \
  -e ADMIN_PASSWORD='et-langt-passord' \
  -e RESEND_API_KEY=re_xxx \
  -e EMAIL_FROM='Påmelding <booking@domain.com>' \
  -e TRUST_PROXY=1 \
  booking
```

### DNS og HTTPS

Pek `booking.domain.com` (en A- eller CNAME-post) mot serveren, og legg en reverse proxy med HTTPS foran. Med [Caddy](https://caddyserver.com) er det to linjer, og sertifikatet ordnes automatisk:

```
booking.domain.com {
    reverse_proxy localhost:3000
}
```

Husk `TRUST_PROXY=1` når appen står bak en proxy.

Appen passer også godt på plattformer som Fly.io, Railway og Render. Sørg for at `DATABASE_PATH` peker til en **persistent disk/volum**, ellers forsvinner påmeldingene ved ny deploy.

### Sikkerhetskopi

SQLite-databasen er én fil. Ta en trygg kopi mens appen kjører:

```bash
sqlite3 data/booking.db ".backup 'backup-$(date +%F).db'"
```

---

## Sikkerhet og personvern

- **Ingen oversikt over arrangementer**, `robots.txt` med `Disallow: /` og `X-Robots-Tag: noindex`.
- **Hemmelige nøkler** lagres bare som SHA-256-hash og sammenlignes i konstant tid.
- **`Referrer-Policy: no-referrer`**, slik at arrangementets adresse ikke lekker til eksterne nettsteder, f.eks. der forsidebildet ligger.
- **Content-Security-Policy** tillater bare egne skript, og all brukertekst settes som tekst i DOM-en (aldri `innerHTML`). Tekst i e-postene HTML-escapes.
- **Avmelding krever et klikk på en knapp.** Mange e-posttjenester åpner lenker automatisk for å sjekke dem for virus, og det skal ikke melde noen av.
- **Plassene kan ikke overbookes.** Påmeldingen teller og lagrer i én `BEGIN IMMEDIATE`-transaksjon (testet med 10 samtidige påmeldinger til 3 plasser).
- **Spam-vern:** rate limiting per IP (30 påmeldinger per 10 min) og et skjult honningkrukke-felt som roboter fyller ut.
- **CSV-eksporten** nøytraliserer celler som begynner med `= + - @`, slik at Excel ikke tolker dem som formler.
- Avmelding og sletting fjerner personopplysningene helt fra databasen.

---

## Prosjektstruktur

```
src/
  server.js      Starter serveren
  app.js         Ruter: sider og API
  db.js          SQLite: tabeller, migreringer og spørringer
  validation.js  Validering av arrangementer og påmeldinger, og påmeldingsstatus
  email.js       Resend-klient og e-postmaler
  ids.js         Tilfeldige lenker og nøkler, hashing
  csv.js         CSV-eksport
  format.js      Datoformatering (norsk)
  rateLimit.js   Enkel rate limiting
  config.js      Miljøvariabler
views/           HTML-sidene
public/assets/   CSS og JavaScript for frontend
test/            Tester (node:test)
```

### API

| Metode | Sti | Tilgang |
|---|---|---|
| `GET` | `/api/events/:slug` | Offentlig |
| `POST` | `/api/events/:slug/registrations` | Offentlig |
| `POST` | `/api/events/:slug/cancel/lookup` | Avmeldingsnøkkel i body |
| `POST` | `/api/events/:slug/cancel` | Avmeldingsnøkkel i body |
| `POST` | `/api/events` | `X-Admin-Password` |
| `GET` / `PUT` / `DELETE` | `/api/events/:slug/admin` | `Authorization: Bearer <admin-nøkkel>` |
| `DELETE` | `/api/events/:slug/admin/registrations/:id` | `Authorization: Bearer <admin-nøkkel>` |
| `GET` | `/api/events/:slug/admin/registrations.csv` | `Authorization: Bearer <admin-nøkkel>` |

### Tilpasse utseendet

Farger og fonter ligger som variabler øverst i `public/assets/css/style.css` (`--accent`, `--bg`, `--serif` osv.).

---

## Mulige utvidelser

- Venteliste når arrangementet er fullt
- Påminnelse på e-post dagen før
- Gjest kan endre svarene sine
- Opplasting av forsidebilde (i dag er det en lenke)
- Betaling (f.eks. Vipps eller Stripe)
