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
ssh -i "/Users/uzochukwuamara/Downloads/.ssh/fuelsense.pem" ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com
```

If key permission is wrong:

```bash
chmod 600 /Users/uzochukwuamara/Downloads/.ssh/fuelsense.pem
```

## Where app is on server

```bash
/home/ec2-user/backend
```

## Is code auto-updated from your laptop?

No. **Code changes are NOT auto-pulled** to EC2.

When you change code locally, you must deploy again.

## Deploy updated code (after local changes)

From your Mac:

```bash
rsync -av --delete --exclude node_modules --exclude .git -e 'ssh -i /Users/uzochukwuamara/Downloads/.ssh/fuelsense.pem' /Users/uzochukwuamara/Code/FuelSense/backend/ ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com:/home/ec2-user/backend/
```

Then on EC2:

```bash
cd /home/ec2-user/backend
npm install --omit=dev
sudo systemctl restart fuelsense-backend
```

## If `.env` changes (or you add new env vars)

On EC2:

```bash
cd /home/ec2-user/backend
nano .env
```

Add/update keys, save, then:

```bash
chmod 600 /home/ec2-user/backend/.env
sudo systemctl restart fuelsense-backend
```

Important: If code now reads a **new env key**, add it to `.env` manually (it will not appear automatically).

## Health + status checks

```bash
curl http://127.0.0.1:5001/api/health
sudo systemctl status fuelsense-backend --no-pager
sudo journalctl -u fuelsense-backend -n 100 --no-pager
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
sudo systemctl stop fuelsense-backend
tcping ec2-13-61-2-216.eu-north-1.compute.amazonaws.com 5027

ping -c 4 ec2-13-61-2-216.eu-north-1.compute.amazonaws.com
```

Resuming the server

```bash
sudo systemctl start fuelsense-backend
```
