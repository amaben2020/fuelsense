---
id: observability
title: Metrics and logs
sidebar_position: 4
---

# Metrics and logs

Local only. Nothing in this page runs on the EC2 box — production is still
systemd units, Caddy and RDS, with logs in `journalctl`.

## Can this be deployed?

Yes, and nothing in the instrumentation stops it — `/metrics` already refuses
anything that is not loopback or a private range, and `METRICS_TOKEN` exists for
a scraper elsewhere. What is *not* done is the production side of it. Three
routes, in increasing order of effort:

| Route | What it costs | What you get |
| --- | --- | --- |
| **Grafana Cloud** | Free tier; an agent on EC2 pushing to their endpoint | A real URL, auth handled, nothing to run yourself. Metrics leave your infrastructure. |
| **Same box, systemd** | Prometheus, Grafana, Loki and node_exporter as units on the EC2 host, behind Caddy with basic auth or an OAuth proxy | One URL, all yours. Instruments share a box with the thing they watch — if the box dies, so does the evidence. |
| **Separate small instance** | Another EC2, scraping across the VPC | Survives the app box dying, which is the whole point of monitoring. Costs another instance. |

The middle one is the usual next step and it is a contained job: four units, a
Caddy block, an auth decision, and the same config files already in
`ops/observability/`. The scrape target changes from `host.docker.internal` to
`127.0.0.1`, and Promtail reads journald instead of a file.

What must not happen is a copy of this stack going up with its current
settings — Grafana here runs **anonymous admin with no login form**, which is
safe only because every port is bound to `127.0.0.1`.

## What this is for

The two halves of the backend fail in different ways, and only one of them is
noisy about it.

The Express API fails **visibly**: a request 500s, the dashboard shows an error,
somebody says something. The Teltonika TCP listener fails **silently**. A
tracker's NAT mapping dies and the socket sits `ESTABLISHED` with nothing coming
through it. A Codec8E packet fails to parse and every record in it is discarded.
Neither writes an error anyone is watching, and both look exactly like *the
vehicle did not move*.

That is the failure this stack exists for. `fuelsense_tcp_frames_total` going
flat is the signal that was missing on 2026-08-09 (parse failures discarding
packets for two hours) and 2026-08-20 (a half-open socket, last fix at 12:28,
still `ESTABLISHED` six hours later).

## Running it

```bash
cd backend && npm run prom:grafana
```

That starts Docker Desktop if the daemon is down, brings the four containers
up, waits for Grafana to answer, warns if no backend is being scraped, and opens
the dashboard. The raw equivalent, if you prefer it:

```bash
docker compose -f docker-compose.observability.yml up -d
open http://localhost:3002
```

| Script | Does |
| --- | --- |
| `npm run prom:grafana` | Start everything and open Grafana |
| `npm run prom:grafana:stop` | Stop the stack, keep the volumes |
| `npm run prom:grafana:logs` | Follow the stack's own logs |
| `npm run prom:grafana:reload` | Restart the four services after a config edit |

**Docker has to be running.** These are containers; there is no daemon-free
mode. If you would rather not run Docker at all, Prometheus and Grafana both
install natively (`brew install prometheus grafana`) — but then the configs in
`ops/observability/` have to be pointed at by hand and the paths in this page
stop matching, so the container route is the supported one.

| Service | URL | Notes |
| --- | --- | --- |
| Grafana | http://localhost:3002 | Anonymous admin, no login form |
| Prometheus | http://localhost:9090 | `/targets` shows what is being scraped |
| Loki | http://localhost:3100 | Queried through Grafana, not directly |

All three publish on `127.0.0.1` explicitly, not `0.0.0.0`. That prefix is what
makes anonymous-admin Grafana defensible — published the default way, it was
reachable from every network the laptop joined, with admin rights and no
password, and Prometheus was serving device IMEIs beside it.

Ports avoid `3000` (an unrelated app on this machine) and `3001` (the FuelSense
frontend).

Grafana opens on the **FuelSense backend** dashboard. It is provisioned from
`ops/observability/grafana/dashboards/fuelsense-backend.json` with
`allowUiUpdates: false` — edits made in the browser are overwritten on the next
reload, so change the JSON, not the page. That is what keeps a tuned dashboard
alive through a `docker compose down -v`.

### Getting logs in

Metrics need nothing extra: Prometheus scrapes `/metrics` over HTTP. Logs need
the backend's stdout to reach a file Promtail can tail.

```bash
cd backend && npm run dev:logs     # instead of npm run dev
```

`dev:logs` is `npm run dev` with stdout teed into `backend/logs/backend.log`,
which is bind-mounted into Promtail. Plain `npm run dev` works fine — you simply
get no logs in Grafana. If the backend is running as the Compose `backend`
service instead, Promtail reads its stdout through the Docker socket and no
extra script is needed.

`backend/logs/*.log` is gitignored, and `tee -a` appends forever — delete the
file when it gets big. Nothing rotates it.

## Two targets, on purpose

Prometheus scrapes **both** `host.docker.internal:5001` and `backend:5001`,
because the backend is sometimes `npm run dev` on the host and sometimes a
container, and which one is live changes day to day. Whichever is not running
shows as a down target on http://localhost:9090/targets. That is honest, and
cheaper than remembering to edit a config.

## The metrics

All prefixed `fuelsense_`, all on `GET /metrics`.

### Ingest — the ones that matter

| Metric | Type | Reads |
| --- | --- | --- |
| `fuelsense_tcp_frames_total{imei}` | counter | AVL records **committed to `telemetry`** — counted after the insert, not on arrival |
| `fuelsense_tcp_seconds_since_last_frame{imei}` | gauge | Silence per device, since this process started |
| `fuelsense_tcp_devices_connected` | gauge | Trackers with an open socket right now |
| `fuelsense_tcp_handshakes_total{outcome}` | counter | `accepted` / `rejected` / `error` |
| `fuelsense_tcp_parse_failures_total{imei}` | counter | Packets discarded by Codec8E parsing — telemetry lost, unrecoverable |
| `fuelsense_tcp_socket_timeouts_total{imei}` | counter | Sockets dropped for going silent past the 15-minute idle timeout |

`seconds_since_last_frame` is measured from **what this process has seen**, not
from the database, so it resets on restart. It answers "which device stopped",
not "when did this device last report ever" — that question belongs to SQL.

### API and runtime

| Metric | Type | Reads |
| --- | --- | --- |
| `fuelsense_http_request_duration_seconds{method,route,status}` | histogram | Request duration; `status` can also be `aborted` |
| `fuelsense_http_requests_in_flight` | gauge | Requests being served right now |
| `fuelsense_db_pool_total` / `_idle` / `_waiting` | gauge | The `pg` pool's own counters |
| `fuelsense_nodejs_*`, `fuelsense_process_*` | mixed | Event loop lag, heap, GC, handles |

`fuelsense_db_pool_waiting` is the one to watch. Sustained above zero means
requests are queueing for a connection, which surfaces as *every endpoint being
slow at once* with no single slow query to blame.

## Label cardinality

Two rules, both load-bearing:

**Routes are labelled by matched Express pattern, never by URL.**
`/api/vehicles/:id` is one time series; `/api/vehicles/<uuid>` would be one per
vehicle, and Prometheus keeps every one of them for as long as the series is
retained. Unmatched paths collapse into a single `unmatched` bucket for the
same reason — a 404 scanner would otherwise mint a label per probed URL.

**IMEI is safe; a rejected IMEI is not.** Registered devices are a bounded set,
one row per `devices` record. A *rejected* handshake is by definition an IMEI
this server does not know, so `fuelsense_tcp_handshakes_total` carries only the
outcome — anything that can reach port 5027 could otherwise mint series at will.

## Who can scrape

`/metrics` is not public. The series carry device IMEIs.

By default only loopback and private ranges are served; everything else gets a
404. `app.set('trust proxy', 1)` means `req.ip` is the real client even behind
Caddy, so this rule keeps working if the backend is ever deployed. Set
`METRICS_TOKEN` to switch to a `Authorization: Bearer …` check instead, for a
scraper that is not on the same network.

The route is mounted **ahead of the rate limiter**. A scrape every 15s is not
abuse, and a throttled scrape leaves a gap in the graph that looks exactly like
the outage you are trying to diagnose.

## Editing the configs

`ops/observability/` has one directory per service — `prometheus/`, `loki/`,
`promtail/`, `grafana/` — and the compose file mounts **directories, never
individual files**. A single-file bind mount pins an inode, so an edit on the
host leaves the container reading the old file or a half-written one. That cost
an afternoon on 2026-08-24: Prometheus rejected a reload with `field 'expr' must
be set in rule` against a rules file that was valid on disk.

After an edit:

```bash
docker compose -f docker-compose.observability.yml restart prometheus
curl -X POST http://localhost:9090/-/reload      # or this, for Prometheus only
```

## Alert rules

`ops/observability/prometheus/rules.yml` is loaded by Prometheus. There is no Alertmanager,
so these fire onto Prometheus' own `/alerts` page and into Grafana's alert list
rather than into anyone's inbox — the point of writing them now is to state in
one place what "wrong" means, so routing can be added later without rethinking
the conditions.

| Alert | Fires when |
| --- | --- |
| `BackendDown` | No scrape target responding for 2m |
| `NoTelemetryArriving` | Zero records fleet-wide for 10m |
| `DeviceSilent` | One device quiet for 45m |
| `PacketsBeingDiscarded` | Any parse failure rate above zero |
| `DbPoolSaturated` | Connection queueing for 5m |
| `ApiLatencyHigh` | Route p95 above 2s for 10m |

`NoTelemetryArriving` and `DeviceSilent` are deliberately separate. A parked
fleet still reports, so flat *everywhere* means the listener, the network or the
database — not the vehicles.

## Useful queries

Grafana → Explore, Loki datasource:

```logql
{job=~"fuelsense-backend|fuelsense-docker"} |= "[DATA LOSS]"
{job=~"fuelsense-backend|fuelsense-docker"} |= "[REAL DEVICE]"
{component="virtual_tank"}
```

Promtail lifts the bracketed subsystem tag the backend already prints —
`[REAL DEVICE]`, `[DATA LOSS]`, `[virtual_tank]`, `[geofence]` — into a
`component` label, so those are label matches rather than full-text scans.
Cardinality is bounded because the tags are literals in the source.

A 15-digit IMEI in a log line is a link: clicking it opens that device's
`fuelsense_tcp_frames_total` in Prometheus.

## Related

- [Ingest pipeline](/architecture/ingest) — what a frame goes through before it
  is counted
- [Troubleshooting](/operations/troubleshooting) — when a panel is empty rather
  than when ingest has stopped
- [Deployment](/operations/deployment) — the production topology this stack does
  not yet touch
