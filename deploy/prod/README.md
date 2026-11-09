# Prod på 172.17.2.19

Thommesen-oppsettet for arrangement. Det kjører som egen stack i
`/root/arrangement` på verten, ved siden av arkitekt-2026 og prosjekthotellet.

```bash
deploy/prod/deploy.sh
```

Skriptet synker arbeidstreet til `/root/arrangement/app`, legger
`docker-compose.yml` og `branding/` herfra i `/root/arrangement` og kjører
`docker compose up -d --build`. Hemmelighetene står i `.env` på verten og røres
ikke etter første deploy. `skins/` og `secrets/` (Apple og Google Wallet) ligger
bare på verten.

`docker-compose.yml` i roten av repoet er den generelle malen med egen
cloudflared, beskrevet i README. Prod bruker fila i denne mappen.
