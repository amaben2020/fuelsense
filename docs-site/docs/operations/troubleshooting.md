---
id: troubleshooting
title: Troubleshooting
sidebar_position: 3
---

# Troubleshooting

Ordered by how often each turns out to be the answer.

## "A panel is empty"

**First check whether the device ever sent the data.** Most "broken panel"
reports are a panel starved of input, and that cause is invisible from the code.

```sql
SELECT event_id, count(*) FROM device_frames GROUP BY 1 ORDER BY 2 DESC;

SELECT DISTINCT jsonb_object_keys(io_raw)
FROM device_frames
WHERE received_at > NOW() - INTERVAL '7 days'
ORDER BY 1;
```

If the element or event id is absent, it is a
[Configurator change](/operations/calibration), not a bug.

Known-empty by design on the reference fleet:

| Panel | Needs | Why it is empty |
| --- | --- | --- |
| Power diagnostics | AVL 66, 67, 113 | Not enabled; only 68 is sent |
| Engine metrics | CAN group | No CAN adapter fitted |
| Overspeeding | A declared speed limit | Set one per vehicle |

## "It says I drove when I didn't"

Almost always a **time window** question. `days=1` means since local midnight in
`Africa/Lagos`, not the last 24 hours — but check the figure agrees with the
table beneath it. If a KPI says "today" and the grouped rows say yesterday's
date, the window and the grouping disagree. See
[Distance and time windows](/data/distance).

```sql
-- What does the vehicle think it did today, in local time?
SELECT DATE(recorded_at AT TIME ZONE 'Africa/Lagos') AS local_day,
       count(*), min(recorded_at), max(recorded_at)
FROM telemetry
WHERE vehicle_id = $1
GROUP BY 1 ORDER BY 1 DESC LIMIT 5;
```

## "The fuel figure looks wrong"

Work through in order:

1. **Is the vehicle on a preset?** `rate_source = 'preset'` means nobody has
   entered a real rate and the model is using a class guess.
2. **Is the drop actually a calibration?** Check for a marker row.
   ```sql
   SELECT recorded_at, fuel_level_liters, fuel_source
   FROM telemetry
   WHERE vehicle_id = $1 AND fuel_source IS NOT NULL
   ORDER BY recorded_at DESC LIMIT 10;
   ```
   A calibration made before marker rows existed is not retroactively taggable
   and still reads as burn.
3. **Is the anchor stale?** The model has no feedback loop. If it has drifted,
   re-anchor.
4. **Are you reading AVL 12?** It is a diagnostic and does not drive the tank.
   It under-reports the moving case by roughly 80×.

## "The naira figure is wrong"

Check whether a benchmark price exists and what was in force at the time:

```sql
SELECT ngn_per_liter, effective_from, source
FROM fuel_prices
WHERE customer_id = $1
ORDER BY effective_from DESC;
```

With no benchmark and no receipt, money fields are `null` by design. A window
spanning a price change is valued per day, so the total will not equal
`litres × today's price`. See [Fuel pricing](/data/pricing).

## "A tracker has gone quiet"

The tracker streams to **EC2 directly**, not to a laptop. A device that looks
silent locally is usually reporting fine to production.

```sql
SELECT imei, max(received_at) AS last_frame
FROM device_frames GROUP BY 1 ORDER BY 2;
```

Then on the box:

```bash
sudo ss -tlnp | grep 5027           # is the port listening
sudo journalctl -u fuelsense-backend -n 100 --no-pager | grep -i imei
```

If the port is not listening or is closed in the security group, every tracker
looks dead and nothing in the logs says so.

Locally, the [metrics stack](/operations/observability) answers this without
SQL: `fuelsense_tcp_seconds_since_last_frame` per device, and a
`PacketsBeingDiscarded` alert if the frames are arriving but failing to parse —
the failure that is indistinguishable from a parked vehicle in the database.

## "Local queries return nothing"

Check `DATABASE_URL`. A laptop `.env` may still point at the retired Neon
instance rather than the Postgres on EC2. Production moved and started empty, so
a working connection to the old host returns an empty result rather than an
error — which reads exactly like a broken query.

## "Harsh events stopped appearing"

The sweep is idempotent and re-runnable, so the usual causes are input-side:

- Frames without `gps_raw` are skipped entirely
- Heading without a valid fix is treated as unknown, which suppresses cornering
- Sample gaps over 5 seconds break a manoeuvre rather than spanning it

A vehicle reporting every 30 seconds will produce almost no harsh events, and
that is correct — a 30-second gap says nothing about the second inside it.

## Useful one-liners

```sql
-- Frames per vehicle per day, local time
SELECT d.vehicle_id, DATE(f.received_at AT TIME ZONE 'Africa/Lagos') AS day, count(*)
FROM device_frames f JOIN devices d ON d.imei = f.imei
GROUP BY 1, 2 ORDER BY 2 DESC LIMIT 20;

-- Which events has the sweep written?
SELECT event_type, severity, count(*)
FROM device_events
WHERE occurred_at > NOW() - INTERVAL '14 days'
GROUP BY 1, 2 ORDER BY 3 DESC;
```
