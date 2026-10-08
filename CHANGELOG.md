# Endringslogg

Hva som er nytt i hver versjon, nyeste først. Versjonsnummeret står nederst til høyre på alle sidene og i oppstartsloggen («Arrangement 2026.10.8.2 kjører …»). Formatet er `år.måned.dag.løpenummer` (se README, «Versjonsnummer»).

Ny versjon av koden tas i bruk med:

```sh
git pull && docker compose up -d --build
```

Hver versjon under har et avsnitt **Oppgradering** når noe må gjøres i tillegg.

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
