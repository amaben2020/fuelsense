#!/usr/bin/env python3
"""Generate the FuelSense telemetry loader Lottie animation.

The old loader showed a van crawling round a street grid, which said "map app".
This one says what the product actually is, in three beats that read in a single
loop:

  1. a satellite tracks overhead and pings down
  2. the ping lands on a vehicle moving along a route
  3. the fuel arc drains as it travels, and steps back up on arrival

Scene: 420x300, 30fps, 180 frames (6s). Everything is drawn here rather than
pulled from a stock library — a third-party Lottie would carry its own licence,
its own palette, and a van that is not this brand's green.

Run: python3 scripts/generate-telemetry-loader.py
"""
import json
import math

W, H, FPS, OP = 420, 300, 30, 180
OUT = __file__.rsplit("/scripts/", 1)[0] + "/src/assets/animations/fleet-command-loader.json"


def rgb(hexstr):
    hexstr = hexstr.lstrip("#")
    return [round(int(hexstr[i : i + 2], 16) / 255, 4) for i in (0, 2, 4)] + [1]


PANEL = rgb("12161e")
EDGE = rgb("28303d")
TRACK = rgb("2a3444")
GOOD = rgb("00e599")
BRAND = rgb("7df5c8")
ACCENT = rgb("2e5bff")
INK = rgb("e8ecf4")
DIM = rgb("6b7a90")


def static(v):
    return {"a": 0, "k": v}


def kf(frames, dims=1):
    ks = []
    for idx, (t, v) in enumerate(frames):
        entry = {"t": t, "s": v if isinstance(v, list) else [v]}
        if idx < len(frames) - 1:
            entry["i"] = {"x": [0.5] * dims, "y": [1] * dims}
            entry["o"] = {"x": [0.5] * dims, "y": [0] * dims}
        ks.append(entry)
    return {"a": 1, "k": ks}


def transform(p=None, a=None, s=None, r=None, o=None):
    return {
        "ty": "tr",
        "p": p or static([0, 0]),
        "a": a or static([0, 0]),
        "s": s or static([100, 100]),
        "r": r or static(0),
        "o": o or static(100),
    }


def fill(c, o=100):
    return {"ty": "fl", "c": static(c), "o": static(o), "r": 1}


def stroke(c, w, o=100, dash=None, cap=2):
    st = {"ty": "st", "c": static(c), "o": static(o), "w": static(w), "lc": cap, "lj": 2}
    if dash:
        st["d"] = [
            {"n": "d", "nm": "dash", "v": static(dash[0])},
            {"n": "g", "nm": "gap", "v": static(dash[1])},
        ]
    return st


def trim(start, end, offset=0):
    """Draws a stroke on progressively — the comet effect."""
    return {"ty": "tm", "s": start, "e": end, "o": static(offset), "m": 1}


def rect(w, h, x=0, y=0, r=0):
    return {"ty": "rc", "d": 1, "s": static([w, h]), "p": static([x, y]), "r": static(r)}


def ellipse(w, h, x=0, y=0):
    return {"ty": "el", "d": 1, "s": static([w, h]), "p": static([x, y])}


def path(points, closed=False):
    n = len(points)
    return {
        "ty": "sh",
        "d": 1,
        "ks": static({"i": [[0, 0]] * n, "o": [[0, 0]] * n, "v": [list(p) for p in points], "c": closed}),
    }


def arc(cx, cy, r, start_deg, end_deg, steps=24):
    pts = []
    for i in range(steps + 1):
        a = math.radians(start_deg + (end_deg - start_deg) * i / steps)
        pts.append([round(cx + r * math.cos(a), 2), round(cy + r * math.sin(a), 2)])
    return path(pts)


def group(items, tr=None):
    return {"ty": "gr", "it": items + [tr or transform()]}


def layer(nm, shapes, ind=1, ks=None):
    return {
        "ddd": 0,
        "ind": ind,
        "ty": 4,
        "nm": nm,
        "sr": 1,
        "ks": ks
        or {
            "o": static(100),
            "r": static(0),
            "p": static([0, 0, 0]),
            "a": static([0, 0, 0]),
            "s": static([100, 100, 100]),
        },
        "ao": 0,
        "shapes": shapes,
        "ip": 0,
        "op": OP,
        "st": 0,
        "bm": 0,
    }


# --- geometry --------------------------------------------------------------
# A gentle S-curve reads as a road without needing a whole street grid.
ROUTE = [(48, 214), (120, 214), (176, 196), (232, 168), (286, 150), (352, 150)]
SAT = (196, 60)


def route_position(t):
    """Point along ROUTE at 0..1, plus the heading in degrees."""
    segs = []
    total = 0.0
    for a, b in zip(ROUTE, ROUTE[1:]):
        d = math.dist(a, b)
        segs.append((a, b, d))
        total += d

    travelled = t * total
    for a, b, d in segs:
        if travelled <= d or (a, b, d) == segs[-1]:
            f = min(1, travelled / d)
            x = a[0] + (b[0] - a[0]) * f
            y = a[1] + (b[1] - a[1]) * f
            ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
            return [round(x, 2), round(y, 2)], round(ang, 2)
        travelled -= d
    return list(ROUTE[-1]), 0


layers = []
ind = 1


def add(l):
    global ind
    l["ind"] = ind
    ind += 1
    layers.append(l)


# 1. panel ------------------------------------------------------------------
add(layer("panel", [group([rect(W - 24, H - 24, W / 2, H / 2, 18), fill(PANEL), stroke(EDGE, 1.5)])]))

# 2. route, drawn as an unlit track then a bright comet that follows the van --
add(
    layer(
        "route-track",
        [group([path(ROUTE), stroke(TRACK, 4, dash=[7, 9], cap=2)])],
    )
)

# The lit portion ends where the vehicle is and starts 28% behind it, so the
# glow reads as "this is where it has just been".
travel = [(0, 0), (24, 0), (150, 100), (180, 100)]
add(
    layer(
        "route-live",
        [
            group(
                [
                    path(ROUTE),
                    stroke(GOOD, 4, cap=2),
                    trim(
                        kf([(t, max(0, v - 28)) for t, v in travel]),
                        kf(travel),
                    ),
                ]
            )
        ],
    )
)

# 3. satellite --------------------------------------------------------------
# Drifts across the top; the downlink pulses three times per loop.
sat_x = kf([(0, [SAT[0] - 26, SAT[1]]), (90, [SAT[0] + 10, SAT[1] - 6]), (180, [SAT[0] + 46, SAT[1]])], dims=2)

add(
    layer(
        "satellite",
        [
            group(
                [
                    rect(15, 15, 0, 0, 3),
                    fill(PANEL),
                    stroke(BRAND, 2.4),
                ]
            ),
            group([rect(16, 5, -18, 0, 1.5), fill(ACCENT, 85)]),
            group([rect(16, 5, 18, 0, 1.5), fill(ACCENT, 85)]),
            group([path([[0, 8], [0, 15]]), stroke(BRAND, 2)]),
        ],
        ks={
            "o": static(100),
            "r": kf([(0, -6), (90, 4), (180, -6)]),
            "p": sat_x,
            "a": static([0, 0, 0]),
            "s": static([100, 100, 100]),
        },
    )
)

# Downlink: three expanding arcs beneath the satellite, staggered.
for i, delay in enumerate((0, 18, 36)):
    add(
        layer(
            f"downlink-{i}",
            [
                group(
                    [
                        arc(0, 0, 16 + i * 7, 30, 150),
                        stroke(GOOD, 2),
                    ]
                )
            ],
            ks={
                "o": kf(
                    [
                        (delay, 0),
                        (delay + 10, 70),
                        (delay + 34, 0),
                        (180, 0),
                    ]
                ),
                "r": static(0),
                "p": sat_x,
                "a": static([0, 0, 0]),
                "s": kf([(delay, [70, 70, 100]), (delay + 34, [125, 125, 100])], dims=3),
            },
        )
    )

# 4. vehicle ----------------------------------------------------------------
veh_pos = []
veh_rot = []
for step in range(0, 181, 6):
    t = min(1, max(0, (step - 24) / 126))
    p, ang = route_position(t)
    veh_pos.append((step, [p[0], p[1], 0]))
    veh_rot.append((step, ang))

add(
    layer(
        "vehicle",
        [
            # body
            group([rect(30, 13, 0, 0, 3), fill(ACCENT)]),
            # cab
            group([rect(11, 10, 19, 1, 2.5), fill(BRAND)]),
            # wheels
            group([ellipse(6, 6, -8, 8), fill(INK, 85)]),
            group([ellipse(6, 6, 8, 8), fill(INK, 85)]),
            group([ellipse(6, 6, 20, 8), fill(INK, 85)]),
        ],
        ks={
            "o": static(100),
            "r": kf(veh_rot),
            "p": kf(veh_pos, dims=3),
            "a": static([0, 0, 0]),
            "s": static([100, 100, 100]),
        },
    )
)

# 5. fuel arc ---------------------------------------------------------------
# Bottom-left gauge: drains while the vehicle travels, jumps back up when it
# arrives — the product's whole loop in one dial.
GX, GY = 66, 88
add(layer("gauge-track", [group([arc(GX, GY, 22, 140, 400), stroke(TRACK, 5)])]))
add(
    layer(
        "gauge-fill",
        [
            group(
                [
                    arc(GX, GY, 22, 140, 400),
                    stroke(GOOD, 5),
                    trim(
                        static(0),
                        kf([(0, 82), (24, 82), (150, 24), (162, 88), (180, 88)]),
                    ),
                ]
            )
        ],
    )
)
# droplet in the middle of the dial
add(
    layer(
        "fuel-drop",
        [
            group([path([[0, -7], [5, 1], [0, 7], [-5, 1]], closed=True), fill(GOOD)]),
        ],
        ks={
            "o": kf([(0, 90), (150, 90), (162, 100), (180, 90)]),
            "r": static(0),
            "p": static([GX, GY, 0]),
            "a": static([0, 0, 0]),
            "s": kf([(150, [100, 100, 100]), (162, [125, 125, 100]), (176, [100, 100, 100])], dims=3),
        },
    )
)

# 6. destination pulse ------------------------------------------------------
add(
    layer(
        "destination",
        [group([ellipse(9, 9, 0, 0), fill(GOOD)]), group([ellipse(20, 20, 0, 0), stroke(GOOD, 2, o=55)])],
        ks={
            "o": kf([(0, 45), (140, 45), (156, 100), (180, 60)]),
            "r": static(0),
            "p": static([ROUTE[-1][0], ROUTE[-1][1], 0]),
            "a": static([0, 0, 0]),
            "s": kf([(140, [90, 90, 100]), (158, [115, 115, 100]), (180, [90, 90, 100])], dims=3),
        },
    )
)

animation = {
    "v": "5.7.4",
    "fr": FPS,
    "ip": 0,
    "op": OP,
    "w": W,
    "h": H,
    "nm": "FuelSense telemetry loader",
    "ddd": 0,
    "assets": [],
    "layers": list(reversed(layers)),
}

with open(OUT, "w") as fh:
    json.dump(animation, fh, separators=(",", ":"))

print(f"wrote {OUT} — {len(layers)} layers, {OP / FPS:.1f}s loop")
