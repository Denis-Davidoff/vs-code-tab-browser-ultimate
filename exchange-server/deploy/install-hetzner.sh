#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ $EUID == 0 ]] || { echo 'Run this script with sudo or from a root shell.' >&2; exit 1; }
staging=/home/deploy/exchange-staging
source_dir=/opt/exchange-server
stack=/etc/komodo/stacks/exchange-server
cd /tmp
test -f "$staging/source.tgz"
test -f "$staging/origin.pem"
test -f "$staging/origin.key"
test -f /etc/caddy/certs/cloudflare-origin-pull-ca.pem
test "$(openssl x509 -in "$staging/origin.pem" -noout -pubkey)" = "$(openssl pkey -in "$staging/origin.key" -pubout)"
openssl x509 -in "$staging/origin.pem" -noout -checkhost aibrowser.tools
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d ovla -Atc 'SELECT 1' >/dev/null

install -d -m 755 "$source_dir"
install -d -m 700 "$stack"
tar -xzf "$staging/source.tgz" --no-same-owner -C "$source_dir"
chown -R root:root "$source_dir"
install -m 600 "$source_dir/exchange-server/deploy/compose.yaml" "$stack/compose.yaml"

if [[ ! -f "$stack/.env" ]]; then
  existing=$(runuser -u postgres -- psql -X -d ovla -Atc "SELECT count(*) FROM pg_roles WHERE rolname IN ('exchange_owner','exchange_app')")
  schema_exists=$(runuser -u postgres -- psql -X -d ovla -Atc "SELECT count(*) FROM pg_namespace WHERE nspname='exchange'")
  [[ $existing == 0 && $schema_exists == 0 ]] || { echo 'Existing Exchange database objects found without credentials; stopping.' >&2; exit 1; }
  owner_password=$(openssl rand -hex 32)
  app_password=$(openssl rand -hex 32)
  auth_secret=$(openssl rand -hex 32)
  cat > "$stack/.env" <<EOF
DATABASE_MIGRATION_URL=postgresql://exchange_owner:${owner_password}@localhost/ovla?host=%2Frun%2Fpostgresql
DATABASE_URL=postgresql://exchange_app:${app_password}@localhost/ovla?host=%2Frun%2Fpostgresql
BETTER_AUTH_SECRET=${auth_secret}
EOF
fi
# This file is root-owned and contains only the generated values above.
source "$stack/.env"
owner_password=${DATABASE_MIGRATION_URL#*://exchange_owner:}
owner_password=${owner_password%@*}
app_password=${DATABASE_URL#*://exchange_app:}
app_password=${app_password%@*}
[[ $owner_password =~ ^[0-9a-f]{64}$ && $app_password =~ ^[0-9a-f]{64}$ ]]

runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d ovla <<SQL
BEGIN;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='exchange_owner') THEN
    CREATE ROLE exchange_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='exchange_app') THEN
    CREATE ROLE exchange_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END \$\$;
ALTER ROLE exchange_owner PASSWORD '${owner_password}';
ALTER ROLE exchange_app PASSWORD '${app_password}';
GRANT CONNECT ON DATABASE ovla TO exchange_owner, exchange_app;
CREATE SCHEMA IF NOT EXISTS exchange AUTHORIZATION exchange_owner;
DO \$\$ BEGIN
  IF (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='exchange') <> 'exchange_owner' THEN
    RAISE EXCEPTION 'Unexpected owner of exchange schema';
  END IF;
END \$\$;
REVOKE ALL ON SCHEMA exchange FROM PUBLIC;
GRANT USAGE ON SCHEMA exchange TO exchange_app;
ALTER ROLE exchange_owner IN DATABASE ovla SET search_path = exchange;
ALTER ROLE exchange_app IN DATABASE ovla SET search_path = exchange;
ALTER DEFAULT PRIVILEGES FOR ROLE exchange_owner IN SCHEMA exchange
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO exchange_app;
ALTER DEFAULT PRIVILEGES FOR ROLE exchange_owner IN SCHEMA exchange
  GRANT USAGE, SELECT ON SEQUENCES TO exchange_app;
COMMIT;
SQL
unset owner_password app_password

hba=/etc/postgresql/17/main/pg_hba.conf
if ! grep -q '^# Exchange Server socket authentication$' "$hba"; then
  cp -a "$hba" "$hba.before-exchange-$(date -u +%Y%m%dT%H%M%SZ)"
  sed -i '1i# Exchange Server socket authentication\nlocal ovla exchange_owner,exchange_app scram-sha-256' "$hba"
  runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d ovla -c 'SELECT pg_reload_conf()'
fi

if [[ -f "$staging/images.tar.gz" ]]; then
  gzip -dc "$staging/images.tar.gz" | docker load
else
  docker compose --project-directory "$stack" build
fi
docker compose --project-directory "$stack" up -d --wait --wait-timeout 180
runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 -d ovla -c 'REVOKE ALL ON exchange.__drizzle_migrations FROM exchange_app'
curl --fail --silent --show-error http://127.0.0.1:3101/api/health
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3100/

install -m 644 -o root -g caddy "$staging/origin.pem" /etc/caddy/certs/aibrowser-origin.pem
install -m 640 -o root -g caddy "$staging/origin.key" /etc/caddy/certs/aibrowser-origin.key
caddy_candidate=$(mktemp /etc/caddy/Caddyfile.exchange.XXXXXX)
trap 'rm -f "${caddy_candidate:-}"' EXIT
python3 - /etc/caddy/Caddyfile "$source_dir/exchange-server/deploy/Caddyfile" "$caddy_candidate" <<'PY'
import pathlib, sys
current, snippet, target = map(pathlib.Path, sys.argv[1:])
text = current.read_text()
start, end = '# BEGIN EXCHANGE SERVER', '# END EXCHANGE SERVER'
block = start + '\n' + snippet.read_text() + '\n' + end
if start in text and end in text:
    a, b = text.index(start), text.index(end) + len(end)
    text = text[:a] + block + text[b:]
elif 'aibrowser.tools' in text:
    raise SystemExit('Existing aibrowser.tools configuration found; review before replacing it.')
else:
    text += '\n\n' + block + '\n'
target.write_text(text)
PY
caddy validate --config "$caddy_candidate" --adapter caddyfile
backup=/etc/caddy/Caddyfile.before-exchange-$(date -u +%Y%m%dT%H%M%SZ)
cp -a /etc/caddy/Caddyfile "$backup"
install -m 644 -o root -g root "$caddy_candidate" /etc/caddy/Caddyfile
if ! systemctl reload caddy; then
  cp -a "$backup" /etc/caddy/Caddyfile
  systemctl reload caddy
  echo 'Caddy reload failed; previous configuration restored.' >&2
  exit 1
fi
echo 'Exchange is running. Checking Cloudflare HTTPS...'
curl --fail --silent --show-error --retry 4 --retry-delay 3 https://aibrowser.tools/api/health
echo
docker compose --project-directory "$stack" ps
echo 'Done: https://aibrowser.tools (database ovla, schema exchange).'
