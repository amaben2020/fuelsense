# Deployment

Both halves of FuelSense run on one EC2 box in eu-north-1, behind Caddy.

| Piece | Where | Served by |
|---|---|---|
| API and TCP ingest | `/home/ec2-user/backend` | systemd `fuelsense-backend`, port 5001 and 5027 |
| Marketing site and dashboard | `/var/www/fuelsense` | Caddy, static files |

The frontend is a static export (`output: 'export'` in `next.config.ts`). Every
route prerenders, so there is no Node process to keep alive for it.

## Why not Netlify

Netlify hosted the frontend until its team credits ran out mid-cycle, at which
point production deploys were silently skipped and the live site sat several
builds behind while still serving traffic. Nothing failed loudly. Moving to the
box that already runs the API removed the second bill and the second failure
mode.

## GitHub Actions

`deploy-backend.yml` runs on pushes touching `backend/`, and
`deploy-frontend.yml` on pushes touching `frontend/`. Both verify before they
ship, and both assert the result is answering afterwards.

Required repository secrets:

| Secret | Value |
|---|---|
| `EC2_SSH_KEY` | Private key contents, ideally a deploy-only key rather than a personal one |
| `EC2_HOST` | `ec2-13-61-2-216.eu-north-1.compute.amazonaws.com` |
| `EC2_USER` | `ec2-user` |
| `GOOGLE_MAPS_API_KEY` | Same value as the local `.env` |
| `NEXT_PUBLIC_API_URL` | `https://api.fuelsense.ng/api` |

## DNS

`fuelsense.ng` and `www.fuelsense.ng` must point at the EC2 elastic IP
(`13.61.2.216`) as A records. `api.fuelsense.ng` already does. Caddy issues and
renews the certificates itself once DNS resolves to the box.

## Deploying by hand

Only needed if Actions is unavailable. Note the exclusion: the server holds the
production `.env` and nothing in the repo should overwrite it.

```bash
# Backend
rsync -av --delete --exclude node_modules --exclude .git --exclude .env \
  -e 'ssh -i ~/.ssh/fuelsense.pem' \
  backend/ ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com:/home/ec2-user/backend/
ssh -i ~/.ssh/fuelsense.pem ec2-user@... 'sudo systemctl restart fuelsense-backend'

# Frontend
cd frontend && npx next build
rsync -az --delete -e 'ssh -i ~/.ssh/fuelsense.pem' \
  out/ ec2-user@ec2-13-61-2-216.eu-north-1.compute.amazonaws.com:/var/www/fuelsense/
```

Do not run `npm install --omit=dev` on the server: the systemd unit executes
`node_modules/.bin/tsx`, which is a dev dependency.
