---
id: avl-elements
title: What the hardware sends
sidebar_position: 1
---

# What the hardware actually sends

Before debugging a missing feature, check whether the device ever sent the data
it needs. Several UI surfaces have looked broken when they were simply starved
of input, and that cause is invisible from the codebase alone.

## The 15 elements on the reference fleet

Enumerated from `device_frames.io_raw` on the live FMC150 and re-confirmed
against production:

| AVL | Element | Unit | Used for |
| --- | --- | --- | --- |
| 12 | Fuel used GPS | ml | Diagnostic only — see below |
| 13 | Fuel rate GPS | L/h ×100 | Diagnostic only — see below |
| 16 | Total odometer | m | **Distance** — the primary source |
| 21 | GSM signal | — | Connectivity |
| 24 | Speed | km/h | Harsh events, overspeed, idle detection |
| 68 | Battery current | mA | Limited power diagnostics |
| 69 | GNSS status | — | Fix quality |
| 181 | PDOP | — | Fix quality |
| 182 | HDOP | — | Fix quality |
| 199 | Trip odometer | m | Trip distance |
| 200 | Sleep mode | — | Power state |
| 239 | Ignition | bool | **Trips, idle, engine-on time** |
| 240 | Movement | bool | Motion gate |
| 241 | GSM operator | — | 62130 = MTN NG |
| 449 | Ignition on counter | — | Diagnostics |

## What is not sent, and what that costs

**No CAN or OBD group at all.** Nothing in 30, 48, 89, 270, 389 or 390. So no
engine RPM, coolant temperature, engine load, or tyre pressure is possible
without an LV-CAN200 / ALL-CAN300 adapter or TPMS sensors. The product does not
return these fields as zero — they do not exist in the API.

**No scenario events.** Only event ids 0, 239 and 240 have ever arrived. Never
250 (trip), 251 (idling), 253 (green driving), 255 (overspeed), or 246/247/249/252.
The decoder handles all of them; they are simply never fed. Enabling them is a
Configurator change, not a code change.

This is why harsh manoeuvres are [derived from GPS](/data/driving-events)
rather than taken from the device.

**No voltage elements.** 66 (external voltage), 67 (backup battery) and 113
(battery level) are **not** sent — only 68 (battery current, 0–139 mA). Full
power diagnostics therefore needs a Configurator I/O change, not code.

## Adding an element is a Configurator change, not a code change

`GET /telemetry/vehicle-signals` is **frame-driven, not column-driven**: it
decodes every key present in `device_frames.io_raw` through
`lib/avl-catalogue.ts`, which already defines labels, units and scaling for far
more elements than the device currently sends.

So enabling a new AVL element in the Teltonika Configurator surfaces it in the
API and the signals table with **zero backend work**. Only bespoke UI for it
needs writing. Panels that depend on an element not yet enabled render an
explicit "enable these in the Configurator" empty state rather than looking
broken.

## AVL 12 and 13: why they are diagnostics only

The two fuel elements contradict each other and neither describes the vehicle.

Measured on the live RAV4:

- **AVL 12** counted **13 ml across 3.55 km** of driving
- **AVL 13** reported a **constant ~2.47 L/h** whether moving, idling or with
  the engine off

Neither element is measured — there is no fuel sensor. The firmware *derives*
both from GPS movement plus consumption parameters set in the Configurator, and
when those parameters are left at defaults the output is meaningless. Replayed
over a real 3.6 km drive with 9.1 minutes of idling, AVL 12 gave 0.145 L where
the correct figure is around 0.742 L — off by roughly 5×, and the moving case
is off by around 80×.

No scaling factor repairs this. An idle-derived correction factor of ~2.6× does
not fix the moving case at all. Both elements are still ingested and shown as
diagnostics, but **they do not drive the tank** — see [The fuel
model](/data/fuel-model).

## Checking for yourself

```sql
-- Which event ids has this fleet ever produced?
SELECT event_id, count(*) FROM device_frames GROUP BY 1 ORDER BY 2 DESC;

-- Which AVL elements are actually present?
SELECT DISTINCT jsonb_object_keys(io_raw) AS avl_id
FROM device_frames
WHERE received_at > NOW() - INTERVAL '7 days'
ORDER BY 1;
```
