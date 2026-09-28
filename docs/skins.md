# Skins – utseende per arrangement

En *skin* er et ferdig utseende som arrangøren velger for hvert arrangement i skjemaet
(«Utseende»). Den legges oppå nettstedets tema (logo, fonter og farger fra `.env`) og gjelder
alle sidene gjestene ser for arrangementet:

- påmeldingssiden
- avmeldingssiden
- billettene (`/t/…` og `/b/…`)
- dørvaktsiden (`/…/skanner`)

Admin-sidene, e-postene, PDF-billetten og Wallet-kortene bruker alltid nettstedets eget tema, slik
at de ser like ut uansett hvilken skin som er valgt.

## Innebygde skins

| Id         | Navn         | Kjennetegn                                                        |
|------------|--------------|-------------------------------------------------------------------|
| *(ingen)*  | Standard     | Nettstedets eget tema, uendret                                    |
| `light`    | Lys          | Rent og lyst med nøytrale gråtoner; aksentfargen beholdes         |
| `dark`     | Mørk         | Mørk bakgrunn og lys tekst                                        |
| `glass`    | Glass        | Fargerik bakgrunn og halvgjennomsiktige, «frostede» kort          |
| `glow`     | Glød         | Mørk, med neonaktig glød rundt knapper, kort og overskrifter      |
| `fjord`    | Fjord        | Kjølig blågrått og sjøblått                                       |
| `contrast` | Høy kontrast | Svart på hvitt, tydelige rammer og større tekst, for best lesbarhet |

Filene ligger i `public/assets/skins/`. Se gjerne i dem når du skal lage en egen.

## Legge til en egen skin

1. Lag en CSS-fil i mappen `skins/` ved siden av `docker-compose.yml`, for eksempel
   `skins/sommer.css`. Filnavnet uten `.css` blir id-en som lagres på arrangementet. Det kan bare
   inneholde små bokstaver (a–z), tall og bindestrek, og kan være maks 40 tegn.
2. Start containeren på nytt, så skinnen blir lest inn:
   ```sh
   docker compose up -d --force-recreate arrangement
   ```
   Mappen er montert inn som `/app/skins` (se `docker-compose.yml`). Kjører du uten Docker, leses
   `skins/` i prosjektmappen.
3. Skinnen dukker opp i skjemaet under «Utseende», med navnet og fargene fra toppen av filen.

En egen skin med samme id som en innebygd (for eksempel `skins/dark.css`) erstatter den innebygde.

Ugyldige filer hoppes over, og årsaken står i loggen ved oppstart (`docker compose logs arrangement`).
Det gjelder feil filnavn, filer større enn 200 kB og `@import` fra adresser nettleseren blokkerer.

### Toppen av filen

Øverst i filen står en kommentar med navn og fargene som vises i velgeren:

```css
/*
  name: Sommer
  name.en: Summer
  preview: #fff8e7 #ffffff #3b2f1e #e07a1f
*/
```

- `name`: navnet i skjemaet.
- `name.en`: navnet når admin er på engelsk (`SITE_LANG=en`). Kan sløyfes; da brukes `name`.
- `preview`: opptil fem farger i formatet `#rgb`, `#rgba`, `#rrggbb` eller `#rrggbbaa`. Vanligst
  er fire: bakgrunn, kort, tekst og aksent. Andre verdier ignoreres.

### Variablene

En skin endrer først og fremst CSS-variablene i `public/assets/css/style.css`:

| Variabel         | Brukes til                                            |
|------------------|-------------------------------------------------------|
| `--bg`           | Sidebakgrunn                                          |
| `--surface`      | Kort, skjema og felter                                |
| `--ink`          | Brødtekst                                             |
| `--muted`        | Hjelpetekst og etiketter                              |
| `--line`         | Linjer og rammer                                      |
| `--accent`       | Knapper, lenker og detaljer                           |
| `--accent-ink`   | Tekst på knapper i aksentfargen                       |
| `--green`        | «Påmelding åpen» og bekreftelser                      |
| `--gold`         | Detaljer i det vevde båndet øverst                    |
| `--error`        | Feilmeldinger                                         |
| `--input-border` | Rammen rundt felter                                   |
| `--radius`       | Hjørneradius på kort, knapper og felter (f.eks. `12px`) |
| `--serif`, `--sans` | Fontene for overskrifter og brødtekst              |

Nyansene `--accent-dark`, `--accent-soft`, `--green-soft` og `--tint` regnes ut fra
grunnfargene, så de følger med automatisk.

Er skinnen mørk, bør du også sette `color-scheme: dark;` i `:root`. Da blir nettleserens egne
kontroller (rullefelt, datovelgere) mørke.

Utover variablene kan du style klassene direkte, for eksempel `.card`, `.btn`, `.badge`, `.band`
(båndet øverst), `.ticket-card` (billetten) og `.scan-result` (dørvaktens grønne, gule og røde
skjerm). Se `glass.css` og `glow.css` for eksempler på skygger, uskarphet og bakgrunnsgradienter.

### Et komplett eksempel

```css
/*
  name: Sommer
  name.en: Summer
  preview: #fff8e7 #ffffff #3b2f1e #e07a1f
*/
:root {
  --bg: #fff8e7;
  --surface: #ffffff;
  --ink: #3b2f1e;
  --muted: #7a6a55;
  --line: #f0e2c4;
  --accent: #e07a1f;
  --accent-ink: #ffffff;
  --gold: #f4c542;
  --radius: 14px;
}
.card { box-shadow: 0 6px 20px rgb(224 122 31 / 0.12); }
```

### Fonter og bilder

- **Fonter:** Nettleseren laster bare stilark fra appen selv og fra Google Fonts, fordi
  Content-Security-Policy tillater bare disse. En font fra Google Fonts hentes slik:
  ```css
  @import url("https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap");
  :root { --sans: 'Poppins', system-ui, sans-serif; }
  ```
  Med `GOOGLE_FONTS=false` blokkeres også Google Fonts. Legg da fontfilen i `./branding` og bruk
  `@font-face { src: url('/assets/custom/min-font.woff2'); }`.
- **Bilder:** Bilder kan komme fra `/assets/custom/…` (mappen `./branding`) eller fra en
  `https://`-adresse, for eksempel `background-image: url('/assets/custom/sommer.jpg');`.

### Hva som ikke skal endres

QR-koden på billetten vises alltid svart på hvitt, også i mørke skins. Det er med vilje, for
kameraer leser den best slik. Ikke overstyr `.ticket-qr`.

### Hurtigbuffer

Adressen til skin-filen inneholder en hash av innholdet, for eksempel
`/assets/skins/sommer-3f2a9c1b7d4e.css`. Nettlesere kan derfor ta vare på filen for alltid. En
endret fil får ny adresse ved neste omstart, så gjestene ser endringen med én gang.
