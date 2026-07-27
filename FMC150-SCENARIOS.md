# FMC150 — GNSS & Accelerometer Scenario Setup

FuelSense decodes the FMC150's scenario events (no fuel sensor required) into
the `device_events` table, the **Driving behavior** dashboard view, and the
existing alerts feed. The device only sends these events if the scenarios are
enabled in the Teltonika Configurator, so run through this checklist once per
tracker (USB cable or SMS/GPRS config).

## How the pipeline works

1. The FMC150 fires a scenario → sends an **eventful AVL record** whose
   Event IO ID names the triggering element (e.g. 253 for Green Driving).
2. `tcp-server.ts` → `lib/device-event-decoder.ts` decodes it into
   `device_events`; security scenarios (towing, crash, jamming, unplug,
   geofence exit) also raise a row in `alerts`.
3. `GET /api/device-events` + `/api/device-events/summary` power the
   **Driving behavior** view (per-vehicle 0–100 safety score, event feed).
4. Every raw frame still lands in `device_frames`, so events received before
   this feature can be recovered with:
   `npm run backfill-device-events -- --apply`

## Configurator checklist (Teltonika Configurator → FMC150)

### Accelerometer Features

| Scenario | Where | Settings to use | AVL ID sent |
|---|---|---|---|
| Eco/Green Driving | Accelerometer Features → Green Driving | Enable; Source: **GPS** (or Accelerometer after calibration); Max acceleration ≈ 0.25 g; Max braking ≈ 0.35 g; Max cornering ≈ 0.25 g; Priority: Low | 253 (type) + 254 (g×100) |
| Crash Detection | Accelerometer Features → Crash Detection | Enable; Threshold ≈ 1500 mg / Duration 5 ms (tune per vehicle); Crash Trace: optional | 247 |
| Towing Detection | Accelerometer Features → Towing Detection | Enable; Activation timeout 5 min; Threshold 0.22 g; Priority: **High** | 246 |
| Excessive Idling | Accelerometer Features → Excessive Idling | Enable; Time to idling: 5 min; Time to not idling: 2 min | 251 (1 start / 0 end) |

### System / Features

| Scenario | Where | Settings to use | AVL ID sent |
|---|---|---|---|
| Over Speeding | Features → Over Speeding | Enable; Max speed: your fleet limit (e.g. 100 km/h); Source: GNSS | 255 (speed km/h) |
| Jamming Detection | System → Jamming | Enable; timeout 60 s; Priority: High (eventual = sends immediately) | 249 (1 start / 0 end) |
| Unplug Detection | Features → Unplug Detection | Enable; Mode: Simple; Priority: High | 252 (1 unplugged / 0 restored) |
| Trip | Trip \ Odometer → Trip Settings | Enable; Start speed 5 km/h; Ignition off timeout 30–60 s; Odometer source: GNSS | 250 (1 start / 0 stop) |
| Auto-Geofencing | Features → Auto Geofencing | Enable; Activation timeout 60 s; Radius e.g. 100 m; Deactivate by: ignition | 175 |
| Manual Geofence zones | Features → Manual Geofence (zones 1–4) | Draw circle/polygon; Generate event: On Exit (or Both) | 155–158 |

### I/O panel (send data with the events)

In the **I/O** tab set these elements so eventful records carry the values the
dashboard uses (Priority "Low" is enough unless noted):

- **239 Ignition**, **240 Movement**, **24 Speed** — On Change
- **16 Total Odometer** — On Change (already used for mileage)
- **17/18/19 Axis X/Y/Z** — optional, only if you want raw G traces
- **66 External Voltage** — On Change, and set **High priority on drop** to
  reinforce unplug detection
- **12 Fuel Used GPS / 13 Fuel Rate GPS** — optional virtual fuel counter;
  configure the consumption profile under Trip \ Odometer if you want the
  device's own GNSS fuel estimate alongside FuelSense's server-side estimate

> After saving, keep **Data Protocol: Codec 8 Extended** (the server listens
> with Codec8e) and the existing server/APN settings unchanged.

## Testing without the real device

`npm run simulate-fleet` (or `ENABLE_FLEET_SIMULATOR=true npm run dev`) now
emits the same scenario IOs: trip start/stop, idling, random harsh
acceleration/braking/cornering, overspeed bursts, and — on the PHC-302-RY
profile — a scripted towing, jamming and unplug sequence. The Driving
behavior view fills up within a couple of minutes.
