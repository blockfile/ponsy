# Deploying to api.ponsy.fun

Target: Ubuntu 24.04 droplet at **152.42.239.56**, serving **api.ponsy.fun** only.

**`ponsy.fun` is on Netlify and stays there.** It resolves to
`13.215.239.219` / `52.74.6.109` and answers with `Server: Netlify` — a
different host entirely. Do not point it at this droplet. The only change on the
frontend side is one Netlify environment variable (Step 7).

As of the last check the droplet has **only port 22 open** — 80, 443 and 3000 are
closed, so nothing is being served yet.

---

## Step 0 — Look before you touch

```bash
ssh root@152.42.239.56

pm2 list 2>/dev/null || echo "pm2 not installed"
ls -la /etc/nginx/sites-enabled/ 2>/dev/null || echo "nginx not installed"
ls -la /var/www/ 2>/dev/null
sudo ss -tlnp | grep -E ':(80|443|3000|8787)' || echo "nothing listening on those ports"
```

If everything comes back empty, skip to Step 1 — the box is clean.

### If you find PONSCAT here

`pm2 list` showing **`ponscat-api`**, or `/var/www/ponscat` existing, means the
claim-and-burn bot was deployed. **Read this before removing it.**

> **Back up the wallet key first.** `/var/www/ponscat/.env` contains
> `WALLET_PRIVATE_KEY`. Deleting that directory destroys the only copy on this
> box. If the wallet holds claimed WETH, that is real money.
>
> **It is a bot, not just an API.** PONSCAT runs a scheduler that claims LP fees
> and burns tokens on a timer. Stopping it stops those on-chain actions. If
> `DRY_RUN=false` in its `.env`, it has been transacting for real.

```bash
# 1. Save the key and config off the server, BEFORE anything else
sudo cat /var/www/ponscat/.env          # copy WALLET_PRIVATE_KEY somewhere safe
grep -E '^(DRY_RUN|TOKEN_ADDRESS)=' /var/www/ponscat/.env   # was it live?

# 2. Stop it — but do not delete yet
pm2 stop ponscat-api
pm2 list

# 3. Only once you are certain, remove it
pm2 delete ponscat-api && pm2 save
sudo rm -f /etc/nginx/sites-enabled/ponscat /etc/nginx/sites-available/ponscat
sudo tar czf /root/ponscat-backup-$(date +%F).tar.gz /var/www/ponscat   # keeps the key
sudo rm -rf /var/www/ponscat

# 4. Its MongoDB is not used by the new backend. Remove it only if nothing
#    else on the box needs it — this deletes the data.
sudo systemctl disable --now mongod
# sudo apt-get purge -y mongodb-org* && sudo rm -rf /var/lib/mongodb
```

PONSCAT's nginx site was a `default_server` catch-all (`server_name _;`), so
while it existed it answered for *any* hostname pointed at this IP. Removing it
is required — otherwise it would intercept `api.ponsy.fun` too.

---

## Step 1 — Install the runtime

```bash
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx ufw rsync

# Node 22 (skip if `node -v` already reports v20+)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node -v

sudo npm install -g pm2
```

---

## Step 2 — Get the code onto the server

The code lives at **https://github.com/blockfile/ponsy.git**.

```bash
sudo mkdir -p /var/www
sudo git clone https://github.com/blockfile/ponsy.git /var/www/ponsy-stats
cd /var/www/ponsy-stats
npm ci --omit=dev
```

`npm ci` (not `npm install`) installs the exact versions in `package-lock.json`,
so the server runs what was tested rather than whatever is newest that morning.
`--omit=dev` skips the test-only packages.

If the repo is private, either use a deploy key or push over SSH and clone with
`git@github.com:blockfile/ponsy.git`.

---

## Step 3 — Configure

```bash
cd /var/www/ponsy-stats
cp .env.example .env
nano .env
```

Set these four. Everything else can stay at its default:

```ini
TOKEN_ADDRESS=0xYourPonsyContract
POOL_ADDRESS=0xYourUniswapV3PonsyWethPool
CORS_ORIGIN=https://ponsy.fun,https://www.ponsy.fun
HOST=127.0.0.1
```

`CORS_ORIGIN` must list the Netlify site exactly, scheme included — the browser
blocks the request otherwise and the panel shows its RETRY state.

Leaving `TOKEN_ADDRESS` empty is valid: `/stats` returns nulls and the site shows
dashes until you fill it in.

```bash
chmod 600 .env
npm run probe        # confirms every upstream is reachable from the droplet
```

---

## Step 4 — Run it under PM2

```bash
cd /var/www/ponsy-stats
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | sudo bash

curl -s http://127.0.0.1:8787/health          # {"ok":true,...}
curl -s http://127.0.0.1:8787/stats
```

Both must work locally before you touch nginx. If they don't, `pm2 logs
ponsy-stats` says why.

---

## Step 5 — nginx + TLS

DNS is already correct: `api.ponsy.fun` → `152.42.239.56`. Confirm before
running certbot, since it validates over HTTP:

```bash
dig +short api.ponsy.fun          # must print 152.42.239.56
```

```bash
cd /var/www/ponsy-stats
sudo cp deploy/nginx.conf /etc/nginx/sites-available/ponsy-api
sudo ln -sf /etc/nginx/sites-available/ponsy-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default      # drops the "Welcome to nginx" catch-all
sudo nginx -t && sudo systemctl reload nginx
```

```bash
sudo certbot --nginx -d api.ponsy.fun --redirect --agree-tos -m you@example.com
```

Certbot rewrites the site file with the 443 block and the http→https redirect,
then installs a renewal timer. Check it:

```bash
sudo certbot certificates
systemctl list-timers | grep certbot
```

---

## Step 6 — Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

Port 8787 is deliberately absent. The app binds `127.0.0.1`, so it is reachable
only through nginx — the firewall is the second layer, not the only one.

Verify from your own machine:

```bash
curl -s https://api.ponsy.fun/health
curl -s https://api.ponsy.fun/stats
```

---

## Step 7 — Point the frontend at it (Netlify)

No code change. In the Netlify dashboard for `ponsy.fun`:

**Site configuration → Environment variables → Add a variable**

```
VITE_STATS_URL = https://api.ponsy.fun/stats
```

Then **Deploys → Trigger deploy → Clear cache and deploy site**.

The rebuild is required: Vite inlines `import.meta.env` values at build time, so
an env var added without redeploying changes nothing.

Confirm in the browser at `ponsy.fun` — the MARKET CAP and HOLDERS panels should
show figures instead of dashes, and the "LIVE FIGURES ON LAUNCH" caption
disappears on its own once `VITE_STATS_URL` is set.

---

## Verifying it actually works

```bash
curl -s https://api.ponsy.fun/stats | head -c 400
```

Read `source` in the response:

| `source.price` | Meaning |
| --- | --- |
| `pool` | Priced on-chain from your RPC. This is the healthy path. |
| `dexscreener` | Pool read failed or `POOL_ADDRESS` is unset — check `warnings`. |
| `none` | No price at all. `warnings` says why. |

`"placeholder": true` means `TOKEN_ADDRESS` is still empty.

Browser-side, confirm CORS from the real origin:

```bash
curl -s -I -H "Origin: https://ponsy.fun" https://api.ponsy.fun/stats | grep -i access-control
```

An empty result means `CORS_ORIGIN` does not list `https://ponsy.fun`.

---

## Updating later

```bash
cd /var/www/ponsy-stats
git pull            # or rsync again from Windows
npm ci --omit=dev
pm2 restart ponsy-stats
pm2 logs ponsy-stats --lines 30
```

`.env` is gitignored and excluded from the rsync, so it survives updates.

## If something breaks

```bash
pm2 logs ponsy-stats --lines 50      # app errors
sudo tail -50 /var/log/nginx/ponsy-api.error.log
npm run probe                        # which upstream is failing
sudo ss -tlnp | grep 8787            # is the app actually listening
```

Rolling back is `pm2 stop ponsy-stats`. The site degrades to its error panel
with a RETRY button; nothing else on `ponsy.fun` is affected, because the
frontend is a separate Netlify deploy.
