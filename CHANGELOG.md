# Endringslogg

Hva som er nytt i hver versjon, nyeste først. Versjonsnummeret står nederst til høyre på alle sidene og i oppstartsloggen («Arrangement 2026.10.8.2 kjører …»). Formatet er `år.måned.dag.løpenummer` (se README, «Versjonsnummer»).

Ny versjon av koden tas i bruk med:

```sh
git pull && docker compose up -d --build
```

Hver versjon under har et avsnitt **Oppgradering** når noe må gjøres i tillegg.

---

## 2026.10.8.5 – 8. oktober 2026

### Nytt: «Administrer» på hvert arrangement i oversikten

Hvert arrangement i oversikten (`/admin`) har knappen «Administrer», som åpner admin-siden for arrangementet – med påmeldte, CSV, innsjekking, dørvaktlenke, korte lenker, redigering, avlysning og sletting. Admin-siden viser «← Alle arrangementer» som vei tilbake.

Admin-nøklene lagres bare som hash, så arrangørenes lenker kan ikke lages på nytt. I stedet gir **tilgangen til oversikten nå også tilgang til admin-siden for hvert arrangement**, med de måtene du har valgt i `OVERVIEW_AUTH`:

- **Nøkkel:** oversiktsnøkkelen følger med i lenken (`/admin/<hash>#<OVERVIEW_KEY>`).
- **Passord:** informasjonskapselen fra innloggingen sendes nå til hele `/api/admin` (før bare `/api/admin/overview`). «Logg ut» sletter begge.
- **Access, LAN og `none`:** virker uten nøkkel i lenken.
- **Bare der oversikten finnes:** med `ADMIN_HOST` gir oversikts-tilgangen ingenting på de offentlige domenene – der krever admin-siden fortsatt arrangementets egen nøkkel.
- **Arrangørens egen admin-lenke** virker som før, overalt.

**Merk:** den som har tilgang til oversikten, kan nå se deltakerlistene og endre eller slette alle arrangementene. Med `OVERVIEW_AUTH=none` gjelder det alle som når `/admin`.

### Oppgradering

- **Ingenting må gjøres.** Er du logget inn med passord fra 2026.10.8.4, virker oversikten som før; logg inn på nytt for at «Administrer» skal slippe deg inn med passordet (informasjonskapselen fikk ny sti).

---

## 2026.10.8.4 – 8. oktober 2026

### Endret: du velger selv hvordan oversikten beskyttes

I 2026.10.8.3 krevde oversikten (`/admin`) alltid nøkkelen. Nå velger eieren selv, med `OVERVIEW_AUTH` – en liste skilt med komma, der én av måtene holder:

| `OVERVIEW_AUTH` | Slik kommer man inn | Trenger |
|---|---|---|
| `key` | Lenken `/admin#<nøkkel>` | `OVERVIEW_KEY` |
| `password` | Brukernavn og passord i et skjema på siden, husket i `OVERVIEW_SESSION_DAYS` dager (standard 30), med «Logg ut» | `OVERVIEW_PASSWORD`, og eventuelt `OVERVIEW_USER` |
| `access` | Innlogget via Cloudflare Access | `CF_ACCESS_TEAM_DOMAIN` og `CF_ACCESS_AUD` |
| `lan` | Alt som kommer inn på LAN-porten | `LAN_PORT` |
| `none` | Ingen innlogging | – |

- **Uten `OVERVIEW_AUTH`** brukes det som er satt opp: nøkkel når `OVERVIEW_KEY` er satt, passord når `OVERVIEW_PASSWORD` er satt.
- **Appen avviser ikke det den synes er svakt.** En kort nøkkel (under 32 tegn) eller et kort passord (under 12 tegn) virker, og loggen gir bare et råd. `none` er et lovlig valg, og loggen sier tydelig hva det betyr. Bare det som ikke kan virke – f.eks. `access` uten `CF_ACCESS_*` – ignoreres med en advarsel.
- **Passordinnloggingen:** brukernavn og passord sammenlignes samlet, så svaret aldri røper hvilket som var feil. Informasjonskapselen er en HMAC av brukernavn og passord – ikke selve passordet – og sendes bare til oversikts-API-et (`HttpOnly`, `SameSite=Strict`, `Secure` på https). Nytt passord logger ut alle. Høyst 10 forsøk per 15 minutter per IP-adresse.
- **Med `ADMIN_HOST`** finnes oversikten fortsatt bare på admin-vertsnavnet (og LAN-porten), uansett valg.
- **Oppstartsloggen** sier hvordan oversikten er beskyttet.

### Oppgradering

- **Med `OVERVIEW_KEY` fra 2026.10.8.3:** ingenting må gjøres – nøkkelen virker som før. Det eneste som har endret seg, er at en kort nøkkel nå godtas (med et råd i loggen) i stedet for å bli ignorert.
- **For brukernavn og passord:** sett `OVERVIEW_USER` og `OVERVIEW_PASSWORD` i `.env` og kjør `docker compose up -d`. Vil du ha både nøkkel og passord, virker begge når begge er satt.

---

## 2026.10.8.3 – 8. oktober 2026

### Nytt: oversikt over alle arrangementer

`/admin#<nøkkel>` viser alle arrangementene som finnes, for deg som drifter tjenesten:

- **Tall øverst:** aktive arrangementer, påmeldte til dem, hvor mange som er åpne for påmelding, og hvor mange som er avlyst.
- **Kommende og pågående,** tidligste først: tittel (lenke til arrangementssiden), sted, korte lenker, tid, nettsted, påmeldte (`6 av 40`, påmeldinger og innsjekkede), status og arrangør.
- **Avsluttet** (sammenslått): arrangementer som er over, med datoen alle data slettes.
- **Søk** i tittel, sted, arrangør, nettsted og lenker, og **«Oppdater»** for ferske tall.
- **På mobil** blir hver rad et eget kort.

Oversikten viser **ingen opplysninger om gjestene** – bare antall – og **ingen admin-lenker**: admin-nøklene lagres bare som hash og står bare i e-posten til arrangøren (og `ADMIN_EMAIL`).

**Tilgang:** den nye innstillingen `OVERVIEW_KEY` (samme krav som `CREATE_KEY`: minst 32 tegn, lag den med `openssl rand -hex 32`). Nøkkelen kreves **alltid** – også på LAN-porten, med Cloudflare Access og med `ADMIN_NO_AUTH`. Med `ADMIN_HOST` finnes oversikten bare på admin-vertsnavnet (og LAN-porten); på de offentlige domenene gir den den nakne `404`-en. Cloudflare Access kan legges foran som et ekstra lag – helst på hele admin-vertsnavnet, se README, «Oversikt over alle arrangementer».

### Oppgradering

- **Ingenting må gjøres.** Uten `OVERVIEW_KEY` finnes ikke oversikten, og `/admin` sender videre til `/admin/ny` som før.
- **For å slå den på:** sett `OVERVIEW_KEY` i `.env`, kjør `docker compose up -d`, og åpne `https://<ADMIN_HOST>/admin#<nøkkel>`.

---

## 2026.10.8.2 – 8. oktober 2026

Tre nye funksjoner – e-post via flere tjenester, personvern og databehandleravtaler i bunnteksten, og korte lenker (alias) – og to feilrettinger.

### Nytt: e-post via Cloudflare, Microsoft 365 og SMTP

E-posten kan nå sendes på fire måter, ikke bare med Resend. Innstillingen `MAIL_PROVIDER` velger tjenesten:

| `MAIL_PROVIDER` | Tjeneste | Merk |
|---|---|---|
| `cloudflare` | Cloudflare Email Service (REST-API) | Krever Workers Paid. I åpen beta. `CLOUDFLARE_EMAIL_TOKEN` og `CLOUDFLARE_ACCOUNT_ID`. |
| `microsoft` | Microsoft 365 via Microsoft Graph | Sender fra en delt postkasse, uten kopi i Sendte elementer. `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_ID` og `MICROSOFT_CLIENT_SECRET`. |
| `smtp` | Vanlig SMTP (nodemailer) | Slik kopimaskiner sender: Microsoft 365 på kontorets faste IP, uten innlogging. `SMTP_HOST`, `SMTP_PORT`, og eventuelt `SMTP_USER`/`SMTP_PASSWORD`. STARTTLS kreves som standard. |
| `resend` | Resend (REST-API) | Som før. |

- **Reserve:** flere tjenester skilt med komma prøves i rekkefølge. Med `MAIL_PROVIDER=cloudflare,microsoft` sendes e-posten med Microsoft 365 hvis Cloudflare feiler, og loggen sier fra.
- **Avvist avsender:** godtar ikke tjenesten avsenderen (domenet er ikke verifisert, eller postkassen finnes ikke), sendes e-posten på nytt fra hovednettstedets avsender. Det gjaldt før bare Resend, nå alle tjenestene.
- **Ingen stille feil:** er `MAIL_PROVIDER` satt, men innstillinger mangler, sier oppstartsloggen hva som mangler, og e-post sendes ikke. Gjesten får beskjed om at bekreftelsen ikke kom frem, i stedet for at appen later som e-posten er sendt.
- **Sjekk ved oppstart:** innloggingen (Microsoft 365) og tilkoblingen (SMTP) prøves med en gang, så feil oppsett vises før noen melder seg på.
- **Test-e-post:** `npm run test-email -- deg@domene.no` (i Docker: `docker compose exec arrangement node scripts/test-email.js deg@domene.no`) sender én e-post gjennom hver tjeneste og fra hvert nettsteds avsender.

Fremgangsmåten for hver tjeneste står i README, «Sette opp e-post».

### Nytt: personvern og databehandleravtaler

Bunnteksten kan få lenken «Personvern og databehandling». Den åpner et vindu over siden med eierens egen tekst: hvem som er behandlingsansvarlig, hvilke opplysninger som lagres og hvor lenge, og hvilke databehandlere det er inngått databehandleravtale med. Overskriften og «Lukk» står fast, teksten imellom kan rulles – også på mobil – og siden bak ligger stille mens vinduet er åpent. Esc eller et klikk utenfor lukker det.

1. `cp docs/personvern.eksempel.html branding/personvern.html` – eksempelet beskriver hva appen faktisk lagrer og hvilke tjenester den bruker, med ett avsnitt per e-posttjeneste (Resend, Cloudflare, Microsoft 365 og SMTP). Behold den eller de som står i `MAIL_PROVIDER`, fyll inn alt i `[hakeparenteser]`, og få teksten kontrollert; det er et utgangspunkt, ikke juridisk rådgivning.
2. Sett `LEGAL_FILE=personvern.html` (og eventuelt `LEGAL_TITLE=…` for en annen lenketekst).
3. Start appen på nytt.

Hvert nettsted kan ha sin egen fil (`SITE_<ID>_LEGAL_FILE`). Som `FOOTER_TEXT` arves innstillingen bare til nettsteder med samme språk. En fil som mangler, er tom eller er over 256 kB, gir en advarsel i loggen og ingen lenke. Innhold som sidenes sikkerhetsregler (CSP) stopper – `<script>`, `style="…"`, `onclick="…"` – varsles ved oppstart. **Merk:** filer i `branding/` er offentlige på `/assets/custom/<filnavn>`.

### Nytt: korte lenker (alias)

Arrangøren kan legge til lesbare adresser til arrangementet, f.eks. `arrangement.domain.no/julebord-2026`, på admin-siden under «Korte lenker (alias)». Hvert alias kan kopieres, åpnes og fjernes.

- **Mange per arrangement,** opptil 50.
- **Aliaset viser arrangementssiden direkte,** uten videresending, så adressefeltet beholder aliaset. Påmelding, avmeldingssiden og kalenderfilen virker også under aliaset.
- **Hash-lenken er fortsatt hovedlenken.** Den står i e-postene, på billettene og i forhåndsvisningen når lenken deles.
- **Navn:** 3–60 tegn, små bokstaver `a–z`, tall og bindestrek. «Julebord 2026» blir `julebord-2026`. Ikke `æ`, `ø` og `å`. `admin`, `api`, `assets` og `dorvakt` er reservert.
- **Ett navn, ett arrangement,** på tvers av alle nettstedene. Et navn som er i bruk, avvises.
- **Sletting:** aliasene slettes sammen med arrangementet, og navnet blir ledig igjen – `julebord` kan brukes til neste års julebord.
- **Personvern:** et alias er laget for å være lett å huske, og er dermed lett å gjette. Hash-en har $31^{12} \approx 7{,}9 \cdot 10^{17}$ muligheter; et alias som `julebord` kan treffes på første forsøk. Arrangementer som ikke skal være kjent utenfor de inviterte, bør bare deles med hash-lenken.

### Feilrettinger

- **E-post kunne gå tapt ved avlysning med mange påmeldte.** Alle e-postene ble sendt samtidig, og tjenesten avviste dem som kom over grensen for antall forespørsler (svar `429`), uten at de ble sendt på nytt. Nå sendes høyst tre e-poster samtidig, med alle tjenestene. Svarer Resend, Cloudflare eller Microsoft 365 likevel `429`, er ingenting sendt, og appen prøver opptil tre ganger til: etter ventetiden tjenesten ber om (`Retry-After`), ellers etter 1, 2 og 4 sekunder, og aldri mer enn 30 sekunder. Først da tar en eventuell reservetjeneste over.
- **Tegn i bunnteksten ble tolket.** Inneholdt `FOOTER_TEXT` tegnene `$&`, `` $` `` eller `$'`, eller en plassholder som `{{VERSION}}`, ble de byttet ut når siden ble laget. `FOOTER_TEXT="Pris 100$& · versjon {{VERSION}}"` ble vist som «Pris 100<!--SITE-FOOTER-->amp; · versjon 2026.10.8.1». Nå vises teksten nøyaktig slik den er skrevet.

### Oppgradering

- **Bygg Docker-bildet på nytt** (`docker compose up -d --build`). Versjonen har en ny avhengighet (nodemailer, for SMTP), og hjelpeskriptet for test-e-post er lagt inn i bildet.
- **Ingen endring i `.env` er nødvendig.** Uten `MAIL_PROVIDER` brukes Resend som før når `RESEND_API_KEY` er satt. Uten `LEGAL_FILE` får bunnteksten ingen ny lenke.
- **Databasen oppgraderes automatisk** ved oppstart (versjon 8: tabellen `event_aliases`). Eksisterende arrangementer har ingen alias, og alt annet er urørt.

---

## Tidligere versjoner

Disse versjonene kom før endringsloggen. Detaljene står i README og i git-historikken.

| Versjon | Dato | Endring |
|---|---|---|
| 2026.10.3.1 | 3. oktober 2026 | Forsiden kan sendes videre til et annet nettsted (`ROOT_REDIRECT`). Forsidebildet vises helt, uten beskjæring, som et heltebilde med tak bare på høyden. |
| 2026.9.28.5 | 28. september 2026 | Avsenderen følger domenet (arrangement.domene.no → arrangement@domene.no). |
| 2026.9.28.4 | 28. september 2026 | E-postene bygges med tabeller, så de ser riktige ut i Outlook for Windows. |
| 2026.9.28.3 | 28. september 2026 | Samme hash overalt: `/admin/<hash>#nøkkel` og `/dorvakt/<hash>#nøkkel`. Se README, «Oppgradering: samme hash overalt». |
| 2026.9.28.2 | 28. september 2026 | Logoen bygges inn i e-postene som PNG. Kopier-knappen kopierer direkte, også over vanlig HTTP. |
| 2026.9.28.1 | 28. september 2026 | Versjonsnummer nederst til høyre på sidene. |
