# ops/

Configuration for things that run *alongside* the app rather than inside it.

| Directory | What it configures | Brought up by |
| --- | --- | --- |
| `observability/` | Prometheus, Loki, Promtail, Grafana | `docker-compose.observability.yml` (repo root) |

There is a second, unrelated `ops/` under `backend/` — that one holds the
production RDS backup units (systemd timer, dump script, IAM policies) and is
scoped to the backend deployment. This one is repo-wide and local-only.

Everything here is mounted read-only into containers, so edits take effect on
`docker compose … restart <service>` without a rebuild. Grafana's dashboards
are provisioned with `allowUiUpdates: false`: change the JSON in
`observability/grafana/dashboards/`, not the browser, or the next reload will
overwrite you.

Drive the stack through `obs.sh` (`npm run prom:grafana` and friends) rather
than `docker compose` directly. It resolves the repo root with `git rev-parse`
because the compose file's volume paths are relative: macOS lets you `cd
~/code/FuelSense` when the directory is `Code`, Docker Desktop's file sharing
does not, and the result is an empty mount rather than an error. `pwd -P` fixes
the casing under zsh but not bash, which is why it looks intermittent.

**One directory per service, and the compose file mounts directories, never
individual files.** A single-file bind mount pins an inode — edit the file on
the host and the container keeps reading the old one, or a half-written one.
That bit on 2026-08-24: Prometheus rejected a reload with `field 'expr' must be
set in rule` against a rules file that was perfectly valid on disk, because the
container was seeing it truncated. If you add a service here, give it its own
subdirectory and mount that.

Full reference: **Operations → Metrics and logs** in the docs site
(`docs-site/docs/operations/observability.md`).
