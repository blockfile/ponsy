#!/usr/bin/env bash
# api.ponsy.fun — Ubuntu 24.04 one-shot setup.
#
# Installs Node 22, PM2, nginx and certbot; clones the repo to /var/www/ponsy-stats;
# starts the API under PM2 behind nginx on 127.0.0.1:8787.
#
#   curl -fsSL https://raw.githubusercontent.com/blockfile/ponsy/main/deploy/setup.sh | sudo bash
# or after a manual clone:
#   sudo bash deploy/setup.sh
#
# Deliberately does NOT run certbot or enable the firewall. Both are one-way
# doors — certbot burns Let's Encrypt rate limits on a domain that may not point
# here yet, and `ufw enable` over SSH locks you out if the rules are wrong. The
# exact commands are printed at the end, to run once you have checked DNS.
set -euo pipefail

APP_DIR="/var/www/ponsy-stats"
REPO="https://github.com/blockfile/ponsy.git"
SITE="ponsy-api"
DOMAIN="api.ponsy.fun"

if [[ $EUID -ne 0 ]]; then
  echo "run as root: sudo bash deploy/setup.sh" >&2
  exit 1
fi

echo "── system packages ──────────────────────────────────────────────────────"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg nginx certbot python3-certbot-nginx ufw

echo "── Node.js 22 + PM2 ─────────────────────────────────────────────────────"
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v
npm install -g pm2

echo "── app: clone + install ─────────────────────────────────────────────────"
mkdir -p /var/www
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

if [[ ! -f .env ]]; then
  cp .env.example .env
  # Production origin for the Netlify-hosted site. Without this the browser
  # blocks the request and the panel shows RETRY even though the API is fine.
  sed -i 's|^CORS_ORIGIN=.*|CORS_ORIGIN=https://ponsy.fun,https://www.ponsy.fun|' .env
  NEW_ENV=1
fi
chmod 600 .env

echo "── PM2 (single fork instance) ───────────────────────────────────────────"
pm2 start ecosystem.config.js --update-env || pm2 restart ponsy-stats
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash || true

echo "── nginx ────────────────────────────────────────────────────────────────"
cp deploy/nginx.conf "/etc/nginx/sites-available/$SITE"
ln -sf "/etc/nginx/sites-available/$SITE" "/etc/nginx/sites-enabled/$SITE"
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "── local check ──────────────────────────────────────────────────────────"
sleep 2
curl -fsS http://127.0.0.1:8787/health && echo "" || echo "WARNING: app not answering — pm2 logs ponsy-stats"

IP="$(curl -fsS4 ifconfig.me 2>/dev/null || echo YOUR_SERVER_IP)"

echo ""
echo "── done ─────────────────────────────────────────────────────────────────"
if [[ "${NEW_ENV:-0}" == "1" ]]; then
  echo ""
  echo "  *** $APP_DIR/.env was created from the example. TOKEN_ADDRESS is EMPTY, ***"
  echo "  *** so /stats returns nulls and the site shows dashes. Edit it, set     ***"
  echo "  *** TOKEN_ADDRESS and POOL_ADDRESS, then: pm2 restart ponsy-stats       ***"
  echo ""
fi
echo "Server IP : $IP"
echo "Local     : curl http://127.0.0.1:8787/stats"
echo "Logs      : pm2 logs ponsy-stats"
echo "Diagnose  : cd $APP_DIR && npm run probe"
echo ""
echo "NEXT — check DNS points here, then enable TLS and the firewall:"
echo ""
echo "  dig +short $DOMAIN            # must print $IP"
echo "  sudo certbot --nginx -d $DOMAIN --redirect"
echo ""
echo "  sudo ufw allow OpenSSH"
echo "  sudo ufw allow 'Nginx Full'"
echo "  sudo ufw enable"
echo ""
echo "FINALLY — in Netlify (ponsy.fun), add the env var and redeploy:"
echo "  VITE_STATS_URL = https://$DOMAIN/stats"
