#!/usr/bin/env python3
"""Generate the FuelSense fleet-command loader Lottie animation.

Scene (420x300, 30fps, 180 frames / 6s loop):
- dark map panel with street grid
- glowing route drawn as a comet trail
- delivery truck driving the route (rotates at corners, fades at loop seam)
- pulsing start/destination markers
- fuel pump bobbing at the destination
"""
import json

W, H, FPS, OP = 420, 300, 30, 180
OUT = __file__.rsplit("/scripts/", 1)[0] + "/src/assets/animations/fleet-command-loader.json"


def rgb(hexstr):
    hexstr = hexstr.lstrip("#")
    return [round(int(hexstr[i : i + 2], 16) / 255, 4) for i in (0, 2, 4)] + [1]


CANVAS = rgb("0b0e13")
PANEL = rgb("12161e")
STREET = rgb("1c2431")
GRID = rgb("161d28")
EDGE = rgb("28303d")
ROUTE_BASE = rgb("3a4557")
GOOD = rgb("00e599")
BRAND = rgb("7df5c8")
ACCENT = rgb("2e5bff")
INK = rgb("e8ecf4")
AMBER = rgb("ffd66b")

# ---- helpers -------------------------------------------------------------

def static(v):
    return {"a": 0, "k": v}


def kf(frames, dims=1):
    """frames: list of (t, value). Linear-ish easing."""
    ks = []
    for idx, (t, v) in enumerate(frames):
        entry = {"t": t, "s": v if isinstance(v, list) else [v]}
        if idx < len(frames) - 1:
            entry["i"] = {"x": [0.55] * dims, "y": [1] * dims}
            entry["o"] = {"x": [0.45] * dims, "y": [0] * dims}
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


def stroke(c, w, o=100, dash=None):
    st = {"ty": "st", "c": static(c), "o": static(o), "w": static(w), "lc": 2, "lj": 2}
    if dash:
        st["d"] = [
            {"n": "d", "nm": "dash", "v": static(dash[0])},
            {"n": "g", "nm": "gap", "v": static(dash[1])},
        ]
    return st


def rect(w, h, x=0, y=0, r=0):
    return {"ty": "rc", "d": 1, "s": static([w, h]), "p": static([x, y]), "r": static(r)}


def ellipse(w, h, x=0, y=0):
    return {"ty": "el", "d": 1, "s": static([w, h]), "p": static([x, y])}


def polyline(points, closed=False):
    n = len(points)
    return {
        "ty": "sh",
        "d": 1,
        "ks": static(
            {
                "i": [[0, 0]] * n,
                "o": [[0, 0]] * n,
                "v": [list(p) for p in points],
                "c": closed,
            }
        ),
    }


def group(items, tr=None):
    return {"ty": "gr", "it": items + [tr or transform()]}


def layer(nm, shapes, ks=None, ind=1):
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


# ---- route geometry ------------------------------------------------------

ROUTE = [(70, 225), (160, 225), (160, 120), (265, 120), (265, 185), (350, 185)]
seg_len = []
for i in range(len(ROUTE) - 1):
    (x1, y1), (x2, y2) = ROUTE[i], ROUTE[i + 1]
    seg_len.append(abs(x2 - x1) + abs(y2 - y1))
total = sum(seg_len)
DRIVE_END = 150  # frames 0..150 driving, 150..180 rest

cum = [0]
for s in seg_len:
    cum.append(cum[-1] + s)
times = [round(c / total * DRIVE_END, 1) for c in cum]  # keyframe times per vertex
prog = [round(c / total * 100, 1) for c in cum]  # % progress per vertex

# vehicle position keyframes
pos_frames = [(times[i], [ROUTE[i][0], ROUTE[i][1], 0]) for i in range(len(ROUTE))]
pos_frames.append((OP, [ROUTE[-1][0], ROUTE[-1][1], 0]))

# rotation per segment (vehicle artwork faces +x)
seg_rot = []
for i in range(len(ROUTE) - 1):
    (x1, y1), (x2, y2) = ROUTE[i], ROUTE[i + 1]
    if x2 > x1:
        seg_rot.append(0)
    elif x2 < x1:
        seg_rot.append(180)
    elif y2 > y1:
        seg_rot.append(90)
    else:
        seg_rot.append(-90)

rot_frames = [(0, seg_rot[0])]
for i in range(1, len(seg_rot)):
    t = times[i]
    rot_frames.append((max(0, t - 2), seg_rot[i - 1]))
    rot_frames.append((min(DRIVE_END, t + 2), seg_rot[i]))
rot_frames.append((OP, seg_rot[-1]))

# vehicle opacity: fade out after arrival, invisible across the loop seam,
# fade back in at the start point
op_frames = [(0, 0), (6, 100), (DRIVE_END + 4, 100), (DRIVE_END + 16, 0), (OP, 0)]

vehicle_ks = {
    "o": kf(op_frames),
    "r": kf(rot_frames),
    "p": kf(pos_frames, dims=3),
    "a": static([0, 0, 0]),
    "s": static([135, 135, 100]),
}

vehicle_shapes = [
    # soft glow under the truck
    group([ellipse(34, 14, 0, 4), fill(ACCENT, 25)]),
    # trailer body
    group([rect(20, 11, -5, 0, 2.5), fill(ACCENT)]),
    # cabin
    group([rect(8, 9, 9, 1, 2), fill(BRAND)]),
    # cabin window
    group([rect(3.5, 4, 10.2, -0.5, 1), fill(PANEL)]),
    # headlight
    group([ellipse(2.5, 2.5, 13.5, 1.5), fill(AMBER)]),
    # wheels
    group([ellipse(5, 5, -10, 5.5), fill(CANVAS), stroke(INK, 1.2)]),
    group([ellipse(5, 5, -1, 5.5), fill(CANVAS), stroke(INK, 1.2)]),
    group([ellipse(5, 5, 9, 5.5), fill(CANVAS), stroke(INK, 1.2)]),
]

# route comet: end tracks vehicle progress, start lags 30%
trim_e = kf([(times[i], prog[i]) for i in range(len(ROUTE))] + [(OP, 100)])
trim_s_vals = [(times[i], max(0, prog[i] - 30)) for i in range(len(ROUTE))]
trim_s = kf(trim_s_vals + [(OP - 6, 100), (OP, 100)])


def route_layer(nm, width, opacity):
    return layer(
        nm,
        [
            group(
                [
                    polyline(ROUTE),
                    {"ty": "tm", "s": trim_s, "e": trim_e, "o": static(0), "m": 1},
                    stroke(GOOD, width, opacity),
                ]
            )
        ],
    )


def pulse_layer(nm, x, y, color, offset):
    """Expanding ring pulsing every 60 frames, staggered by `offset`."""
    frames_s, frames_o = [], []
    t = -offset
    while t < OP + 60:
        frames_s += [(max(0, t), [30, 30]), (t + 55, [220, 220])]
        frames_o += [(max(0, t), 80), (t + 55, 0)]
        t += 60
    frames_s = [(a, b) for a, b in frames_s if a <= OP]
    frames_o = [(a, b) for a, b in frames_o if a <= OP]
    return layer(
        nm,
        [
            group(
                [ellipse(14, 14), stroke(color, 2)],
                transform(p=static([x, y]), s=kf(frames_s, dims=2), o=kf(frames_o)),
            )
        ],
    )


# fuel pump at destination, gentle bob
pump_shapes = [
    group([rect(15, 19, 0, 0, 2.5), fill(rgb("12161e")), stroke(GOOD, 1.5)]),
    group([rect(9, 6, 0, -3.5, 1), fill(GOOD, 85)]),
    group([rect(11, 2, 0, 11, 1), fill(EDGE)]),
    # hose arcing off the right side
    group([polyline([(7.5, -6), (13, -6), (13, 4)]), stroke(GOOD, 1.6)]),
    group([rect(3, 4.5, 13, 6.5, 1), fill(GOOD)]),
]
pump_layer = layer(
    "fuel_pump",
    [
        group(
            pump_shapes,
            transform(p=kf([(0, [372, 173, 0]), (90, [372, 169, 0]), (OP, [372, 173, 0])], dims=3)),
        )
    ],
)

# destination + start markers
dest_pin = layer(
    "dest_pin",
    [
        group([ellipse(9, 9), fill(GOOD)], transform(p=static([350, 185]))),
        group([ellipse(3.5, 3.5), fill(PANEL)], transform(p=static([350, 185]))),
    ],
)
start_pin = layer(
    "start_pin",
    [group([ellipse(8, 8), fill(BRAND)], transform(p=static([70, 225])))],
)

# street grid: corridors the route rides on + a few extras
streets = []
for pts in [
    [(30, 225), (390, 225)],
    [(30, 120), (390, 120)],
    [(30, 185), (390, 185)],
    [(160, 40), (160, 260)],
    [(265, 40), (265, 260)],
    [(90, 40), (90, 260)],
    [(330, 40), (330, 260)],
    [(30, 70), (390, 70)],
]:
    streets.append(group([polyline(pts), stroke(STREET, 7)]))

grid_minor = []
for x in range(52, 390, 42):
    grid_minor.append(group([polyline([(x, 32), (x, 268)]), stroke(GRID, 0.8, 60)]))
for y in range(52, 280, 42):
    grid_minor.append(group([polyline([(32, y), (388, y)]), stroke(GRID, 0.8, 60)]))

map_panel = layer(
    "map_panel",
    [
        group([rect(364, 244, 210, 150, 22), fill(PANEL)]),
        group([rect(364, 244, 210, 150, 22), stroke(EDGE, 1.5, 90)]),
    ],
)

route_base = layer(
    "route_base",
    [group([polyline(ROUTE), stroke(ROUTE_BASE, 3, 70, dash=(2.5, 6))])],
)

layers = [
    layer("vehicle", vehicle_shapes, ks=vehicle_ks),
    pump_layer,
    pulse_layer("dest_pulse", 350, 185, GOOD, 30),
    dest_pin,
    pulse_layer("start_pulse", 70, 225, BRAND, 0),
    start_pin,
    route_layer("route_glow", 9, 16),
    route_layer("route", 3, 100),
    route_base,
    layer("streets", streets),
    layer("grid", grid_minor),
    map_panel,
]
for i, l in enumerate(layers):
    l["ind"] = i + 1

doc = {
    "v": "5.7.4",
    "fr": FPS,
    "ip": 0,
    "op": OP,
    "w": W,
    "h": H,
    "nm": "Fleet Command Loader",
    "ddd": 0,
    "assets": [],
    "layers": layers,
}

with open(OUT, "w") as f:
    json.dump(doc, f, separators=(",", ":"))
print("wrote", OUT, "bytes:", len(json.dumps(doc)))
print("vertex times:", times, "progress %:", prog)
