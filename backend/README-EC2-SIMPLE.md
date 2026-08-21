# FuelSense Backend — EC2 (Very Simple)

## Teltonika TCP configuration (this is what to use)

- Host: `ec2-13-61-2-216.eu-north-1.compute.amazonaws.com`
- Port: `5027`
- Protocol: `TCP`
- Full endpoint string: `tcp://ec2-13-61-2-216.eu-north-1.compute.amazonaws.com:5027`

## Quick connectivity checks from your Mac

Ping host:

```bash
ping -c 4 ec2-13-61-2-216.eu-north-1.compute.amazonaws.com
```

Check TCP port 5027:

```bash
nc -zv -w 5 ec2-13-61-2-216.eu-north-1.compute.amazonaws.com 5027
```

If timeout happens, open inbound security-group rules for `5027/tcp`.

## Connect to EC2

```bash
ssh -i ~/.ssh/fuelsense.pem ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com
```

If key permission is wrong:

```bash
chmod 600 ~/.ssh/fuelsense.pem
```

## Local dev against production data (SSH tunnel)

Since **2026-08-21** the production database is Amazon RDS — `fuelsense-prod`
in `eu-north-1c`, PostgreSQL 16.15. It is deliberately *not* publicly
reachable: its security group (`sg-072efb466379bfe8a`) admits port 5432 from
the backend's security group and nothing else. So your laptop reaches it by
tunnelling **through** the EC2 box, which acts purely as a jump host.

Before this, the database was a Postgres 15 server on the EC2 box's own disk.
That server still exists as a rollback option but is no longer written to.

### 1. Open the tunnel

Just run the watchdog — it opens the forward and re-establishes it whenever it
drops (which it does every 30–60 minutes, usually when the laptop's network
interface sleeps):

```bash
cd backend
nohup ./tunnel-watchdog.sh > tunnel-watchdog.log 2>&1 & disown
```

Stop it with `pkill -f tunnel-watchdog.sh`. To open a one-off forward by hand
instead:

```bash
ssh -i ~/.ssh/fuelsense.pem \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes \
  -N -L 15432:fuelsense-prod.cf0m8smsiksj.eu-north-1.rds.amazonaws.com:5432 \
  ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com
```

Note the forward target is the **RDS endpoint**, not `localhost` — forwarding
to `localhost:5432` now lands on the retired local Postgres, not production.

### 2. Point `backend/.env` at the tunnel

Get the real `DATABASE_URL` (username/password) from the EC2 box:

```bash
ssh -i ~/.ssh/fuelsense.pem ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com \
  "grep '^DATABASE_URL=' /home/ec2-user/backend/.env"
```

Copy it into your local `backend/.env`, replacing the RDS hostname with
`localhost:15432` (the tunnel's local end), and **add `DATABASE_SSL=require`**:

```bash
DATABASE_URL=postgresql://fuelsense:<password>@localhost:15432/fuelsense
DATABASE_SSL=require
```

That second line is not optional. RDS runs `rds.force_ssl=1` and rejects
plaintext connections outright, but through the tunnel the host reads as
`localhost` — the one case `needsSsl()` in `src/db/index.ts` cannot infer TLS
from the hostname, so it has to be told explicitly.

Comment out whatever `DATABASE_URL` was there before rather than deleting it.

### 3. Start the backend

```bash
npm run dev
```

Login with the real account: `demo@fuelsense.local` / `demo1234` (this is a
different customer record than the one seeded in the local Docker DB, even
though the email matches — don't confuse the two).

### Troubleshooting: "Something went wrong" / random 500s

This almost always means **the tunnel dropped**. It's been observed dropping
within an hour even with the keepalive flags above — most likely your
laptop's network interface sleeping or switching (wifi ↔ ethernet, VPN
toggling), not an EC2-side timeout. Symptoms:

- Login fails with a generic error
- Dashboard panels stay stuck on "Loading…"
- `/api/health` still returns `200` (it doesn't touch the DB — don't trust it
  alone as a sign everything's fine)

Check and fix:

```bash
# Is the tunnel actually up?
nc -z -w2 localhost 15432 && echo up || echo down

# If down, just re-run the ssh command from step 1.
```

The backend itself doesn't need restarting when the tunnel comes back — it
retries the connection on the next request.

### Switching back to the local Docker DB

If you don't need real data (pure UI work, or the tunnel is being unreliable):

```bash
docker compose up -d db   # from the repo root, if not already running
```

Then in `backend/.env`, swap `DATABASE_URL` to:

```bash
DATABASE_URL=postgresql://user:password@localhost:5434/fuelguard
```

Same demo login (`demo@fuelsense.local` / `demo1234`), but seeded fake data —
safe to hammer without touching production.

## Where app is on server

```bash
/home/ec2-user/backend
```

## Is code auto-updated from your laptop?

No. **Code changes are NOT auto-pulled** to EC2.

When you change code locally, you must deploy again.

## Deploy updated code (after local changes)

From your Mac. **Always dry-run first** (`-n`) and read the deletion list —
`--delete` removes anything on the server that is missing locally:

```bash
rsync -avn --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude dist \
  -e 'ssh -i ~/.ssh/fuelsense.pem' \
  /Users/uzochukwuamara/Code/FuelSense/backend/ \
  ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com:/home/ec2-user/backend/
```

Drop the `n` to apply.

**`--exclude .env` is not optional.** A local `.env` exists, so without it rsync
overwrites the server's production environment — `DATABASE_URL` included — with
your laptop's values, and the backend silently starts writing to the wrong
database.

Then on EC2:

```bash
sudo systemctl restart fuelsense
```

**The unit is `fuelsense`, not `fuelsense-backend`.** Until 2026-08-21 the box
carried *two* enabled units running the same app. On boot they raced for ports
5027 and 5001; one won and served traffic, the other crash-looped to `failed`.
Because this file used to say `fuelsense-backend`, every documented deploy
restarted the dead unit and left the running app on old code — which is how the
box came to be serving 50-day-old code in July. The duplicate has been removed
to `/root/removed-units/`. If you ever see a `fuelsense-backend` again, that is
the bug, not a second service.

**Do not run `npm install --omit=dev`.** The systemd unit starts the app with
`node_modules/.bin/tsx src/server.ts`, and `tsx` is a devDependency — omitting
dev dependencies deletes the binary the service runs, and it will not start
again. Only run a plain `npm install` when `package.json` dependencies actually
changed; a code-only deploy needs no install step at all.

## If `.env` changes (or you add new env vars)

On EC2:

```bash
cd /home/ec2-user/backend
nano .env
```

Add/update keys, save, then:

```bash
chmod 600 /home/ec2-user/backend/.env
sudo systemctl restart fuelsense
```

Important: If code now reads a **new env key**, add it to `.env` manually (it will not appear automatically).

## Health + status checks

```bash
curl http://127.0.0.1:5001/api/health
sudo systemctl status fuelsense --no-pager
sudo journalctl -u fuelsense -n 100 --no-pager
sudo journalctl -u fuelsense -f
```

## Telemetry not writing to Postgres?

Work through these in order while watching `journalctl -f`:

### 1. IMEI must exist in `devices` table

The TCP server **rejects unknown IMEIs** before any insert. Your device:

- IMEI: `862129084847783`
- CCID: `89234010006276368382` (stored in `firmware_version` as `CCID:…` for reference)

On EC2, register once:

```bash
cd /home/ec2-user/backend
node src/seed-real-device.js
```

Verify in psql:

```sql
SELECT imei, vehicle_id, customer_id, is_active, last_seen_at FROM devices WHERE imei = '862129084847783';
```

**Log you want:** `Device 862129084847783 connected for customer …`  
**Log that means no writes:** `Unknown device 862129084847783 - rejecting connection`

### 2. `DATABASE_URL` in `/home/ec2-user/backend/.env`

Must point at the **same** Postgres you query. Neon needs `?sslmode=require`.

After `.env` changes:

```bash
sudo systemctl restart fuelsense
```

**Log on DB failure:** `❌ TELEMETRY SAVE FAILED` or `[REAL DEVICE] insert error`

### 3. Port 5027 open + device pointed at EC2

Teltonika server: `tcp://ec2-13-61-2-216.eu-north-1.compute.amazonaws.com:5027`

From your Mac:

```bash
nc -zv -w 5 ec2-13-61-2-216.eu-north-1.compute.amazonaws.com 5027
```

AWS security group must allow **inbound TCP 5027** from `0.0.0.0/0` (or your SIM carrier IPs).

### 4. Disable test simulator on EC2

In `.env`:

```bash
NODE_ENV=production
ENABLE_FLEET_SIMULATOR=false
```

Restart service. Startup should log: `Fleet simulator disabled — expecting real Teltonika devices`.

### 5. Confirm rows in DB

```sql
SELECT recorded_at, fuel_level_liters, latitude, longitude, speed_kph
FROM telemetry
WHERE imei = '862129084847783'
ORDER BY recorded_at DESC
LIMIT 10;
```

## Caddy (HTTP reverse proxy)

- Caddy file: `/etc/caddy/Caddyfile`
- Proxies `:80` -> `127.0.0.1:5001`

Validate and reload after Caddy changes:

```bash
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Stopping the server

```bash
sudo systemctl stop fuelsense
tcping ec2-13-61-2-216.eu-north-1.compute.amazonaws.com 5027

ping -c 4 ec2-13-61-2-216.eu-north-1.compute.amazonaws.com
```

Resuming the server

```bash
sudo systemctl start fuelsense
```
