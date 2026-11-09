#!/usr/bin/env bash
# Synker påmeldingssystemet fra dette arbeidstreet til prod-verten og (re)starter det.
#
#   deploy/prod/deploy.sh
#
# Det er arbeidstreet som sendes, ikke HEAD og ikke GitHub. Verten har ikke git,
# så koden synkes over med rsync. Det .gitignore utelater (node_modules, .env,
# data, secrets), sendes ikke. Databasen ligger i volumet
# arrangement_arrangement-data og overlever hver deploy.
set -euo pipefail

HOST="root@172.17.2.19"
REMOTE_DIR="/root/arrangement"
HER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HER/../.." && pwd)"

echo "==> Sender $REPO"
echo "    $(git -C "$REPO" log -1 --format='%h %s')"
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  echo "    (arbeidstreet har endringer som ikke er committet, de sendes også)"
fi

echo "==> Synker til $HOST:$REMOTE_DIR"
# Verten har umask 027, så nye mapper kan ikke leses av node-brukeren (uid 1000)
# i containeren. skins er åpen for lesing, secrets eies av node og er lukket
# for alle andre.
ssh "$HOST" "mkdir -p $REMOTE_DIR/app $REMOTE_DIR/skins $REMOTE_DIR/secrets \
  && chmod 755 $REMOTE_DIR/skins \
  && chown 1000:1000 $REMOTE_DIR/secrets && chmod 700 $REMOTE_DIR/secrets"
rsync -az --delete --exclude ".git/" --exclude ".claude/" --filter=":- .gitignore" \
  "$REPO"/ "$HOST:$REMOTE_DIR/app/"
rsync -az --delete "$HER/branding/" "$HOST:$REMOTE_DIR/branding/"
rsync -az "$HER/docker-compose.yml" "$HOST:$REMOTE_DIR/docker-compose.yml"

# .env lages bare første gang og røres aldri etterpå. Resend-nøkkelen er den
# samme som kontaktskjemaet bruker.
echo "==> Kontrollerer .env"
ssh "$HOST" "cd $REMOTE_DIR && [ -f .env ] || {
  umask 077
  echo \"RESEND_API_KEY=\$(grep '^RESEND_API_KEY=' /root/arkitekt-2026/.env | cut -d= -f2-)\" > .env
  echo '    .env opprettet'
}"

echo "==> (Re)starter arrangement"
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d --build"

# Forsiden svarer alltid 404 (lukket domene uten lenke), så helsa leses på
# admin. Uten Access-token skal den gi 403, som viser at appen kjører og at
# Access-kontrollen er slått på.
echo "==> Helse"
sleep 3
ssh "$HOST" "docker exec arrangement node -e \"require('http').get({port: 3000, path: '/admin/ny', headers: {host: 'arrangement.arkitekt-thommesen.no'}}, r => console.log('    HTTP', r.statusCode))\""
