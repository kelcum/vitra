"""Draws Vitra's preset capes and the badge shown next to Vitra players' names.

    python scripts/make-cosmetics-art.py

Capes go to services/vitra-api/presets/ (upload them with scripts/upload-capes.py); the badge goes
into the mod's font. A cape image is one or more cape textures (2:1, the vanilla 64x32 layout scaled
up) stacked top to bottom, one per animation frame.
"""
import colorsys
import json
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "services", "vitra-api", "presets")
BADGE = os.path.join(ROOT, "mods", "vitra-cosmetics", "src", "main", "resources", "assets", "vitra", "textures", "font", "badge.png")
ICON = os.path.join(ROOT, "site", "vitra", "icon.png")


def lerp(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


def shade(c, k):
    return tuple(max(0, min(255, int(v * k))) for v in c[:3]) + (c[3] if len(c) > 3 else 255,)


ELYTRA_MASK = [
    ".........#########......",
    "..........##............",
    "............########....",
    "............#########...",
    ".............#########..",
    ".............#########..",
    ".............#########..",
    ".............##########.",
    ".............##########.",
    ".............##########.",
    ".............##########.",
    "#.............##########",
    "#.............##########",
    "#.............##########",
    "#.............##########",
    "#.............##########",
    "#..............#########",
    "#..............#########",
    "#..............#########",
    "#...............########",
    "#...............########",
    "#................#######",
]


def cape_frame(design, t, s):
    """One cape texture at scale s, painted by design(u, v, t) -> RGBA over the outer face."""
    img = Image.new("RGBA", (64 * s, 32 * s), (0, 0, 0, 0))
    px = img.load()

    def paint(x0, y0, w, h, fn):
        for y in range(y0 * s, (y0 + h) * s):
            for x in range(x0 * s, (x0 + w) * s):
                px[x, y] = fn((x - x0 * s + .5) / (w * s), (y - y0 * s + .5) / (h * s))

    paint(1, 1, 10, 16, lambda u, v: design(u, v, t))
    paint(12, 1, 10, 16, lambda u, v: shade(design(1 - u, v, t), .55))
    paint(0, 1, 1, 16, lambda u, v: shade(design(0, v, t), .7))
    paint(11, 1, 1, 16, lambda u, v: shade(design(1, v, t), .7))
    paint(1, 0, 10, 1, lambda u, v: shade(design(u, 0, t), .85))
    paint(11, 0, 10, 1, lambda u, v: shade(design(u, 1, t), .6))
    for y in range(0, 22 * s):
        for x in range(22 * s, 46 * s):
            if ELYTRA_MASK[y // s][x // s - 22] == "#":
                u = min(1, max(0, (x - 34 * s + .5) / (12 * s)))
                px[x, y] = design(u, (y + .5) / (22 * s), t)
    return img


def strip(frames):
    w, h = frames[0].size
    out = Image.new("RGBA", (w, h * len(frames)))
    for i, f in enumerate(frames):
        out.paste(f, (0, i * h))
    return out


def glass(u, v, t):
    """Vitra's glass cube colours, with a sheen sweeping across."""
    base = lerp((96, 140, 255), (139, 92, 246), v * .8 + u * .2)
    d = (u + v * .55) - (t * 2.4 - .6)
    sheen = math.exp(-(d * d) / .006)
    edge = 1 - min(u, 1 - u, v, 1 - v)
    rim = .35 if min(u, 1 - u) < .07 or min(v, 1 - v) < .045 else 0
    k = 1 + sheen * .55 + rim * .4 + (edge - .5) * .1
    return shade(lerp(base, (230, 240, 255), sheen * .55), k)


STARS = [(random.Random(3).random(), random.Random(i).random() * .5, i) for i in range(1, 16)]


def aurora(u, v, t):
    """Northern lights: green curtains rippling across a night sky."""
    T = t * 2 * math.pi
    sky = lerp((6, 10, 28), (16, 22, 52), v)
    c = sky
    for sx, sy, i in STARS:
        sx = (sx * (i * 7.31)) % 1
        if ((u - sx) * 10) ** 2 + ((v - sy) * 16) ** 2 < .1 * (1 + .5 * math.sin(T + i)):
            c = (220, 230, 255)
    glow = 0
    for k, (f, ph, off) in enumerate([(3.1, 0, .32), (2.3, 2.1, .52), (4.2, 4.0, .7)]):
        x = off + math.sin(v * f + T + ph) * .12 + math.sin(v * 7 - T * 2 + k) * .03
        d = abs(u - x)
        glow += math.exp(-d * d / .006) * (1 - v) ** 1.3 * (.8 + .2 * math.sin(T * 2 + k * 2 + v * 9))
    glow = min(1, glow)
    top = max(0, .35 - v) * 2
    col = lerp((40, 255, 150), (150, 90, 255), min(1, top * glow * 1.6))
    return lerp(c, col, glow * .95) + (255,)


random.seed(7)
SPARKS = [(random.random(), random.random(), random.uniform(.6, 1.4)) for _ in range(14)]


def ember(u, v, t):
    flick = math.sin((v * 9 + t * 2 * math.pi * 2) + math.sin(u * 7 + t * 2 * math.pi) * 1.5) * .5 + .5
    heat = max(0, min(1, (1 - v) * .2 + v * .95 + flick * .18 - .1))
    c = lerp((22, 4, 2), (196, 38, 10), min(1, heat * 1.4))
    c = lerp(c, (255, 176, 50), max(0, heat - .55) * 2)
    for sx, sy, sp in SPARKS:
        y = (sy - t * sp) % 1
        d = (u - sx) ** 2 * 4 + (v - y) ** 2 * 16
        if d < .004:
            c = lerp(c, (255, 236, 160), 1 - d / .004)
    return c + (255,)


PETALS = [(random.random(), random.random(), random.uniform(.9, 1.4), random.uniform(0, 6.28)) for _ in range(9)]


def sakura(u, v, t):
    c = lerp((250, 190, 214), (190, 40, 110), v * .95)
    for px_, py, sp, ph in PETALS:
        y = (py + t * sp) % 1.1 - .05
        x = px_ + math.sin(t * 6.28 + ph) * .07
        a = ph + t * 6.28 * .5
        dx, dy = (u - x) * .625, (v - y)
        rx, ry = dx * math.cos(a) + dy * math.sin(a), -dx * math.sin(a) + dy * math.cos(a)
        e = (rx / .06) ** 2 + (ry / .03) ** 2
        if e < 1:
            c = lerp((255, 236, 244), (255, 255, 255), 1 - e) if e < .85 else lerp(c, (255, 220, 235), .7)
    return c + (255,)


def nocturne(u, v, t):
    """Black velvet with a gold trim, after xan.gripe/k3."""
    c = lerp((24, 16, 12), (8, 6, 5), v)
    if min(u, 1 - u) < .09 or min(v, 1 - v) < .055:
        g = .65 + .35 * math.sin((u + v) * 9)
        return lerp((154, 117, 53), (243, 223, 170), g) + (255,)
    if .14 < min(u, 1 - u) < .17 or .09 < min(v, 1 - v) < .105:
        return (120, 92, 44, 255)
    return c + (255,)


def with_emblem(design, emblem, box):
    """Draws an emblem image (RGBA, sized for the outer face) over a design."""
    ew, eh = emblem.size
    data = emblem.load()

    def fn(u, v, t):
        base = design(u, v, t)
        x0, y0, x1, y1 = box
        if x0 <= u < x1 and y0 <= v < y1:
            ex = int((u - x0) / (x1 - x0) * ew)
            ey = int((v - y0) / (y1 - y0) * eh)
            r, g, b, a = data[min(ew - 1, ex), min(eh - 1, ey)]
            if a:
                return lerp(base[:3], (r, g, b), a / 255) + (255,)
        return base
    return fn


def lyre(size):
    """The lyre from xan.gripe, in gold."""
    big = Image.new("RGBA", (size * 8, size * 8), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    k = size * 8 / 24
    gold, w = (236, 206, 140, 255), max(2, int(k * 1.3))
    pts = lambda *ps: [(x * k, y * k) for x, y in ps]
    d.line(pts((8, 20), (5.5, 16), (4.8, 11), (6, 8), (6, 5.5), (4.5, 3.5)), fill=gold, width=w, joint="curve")
    d.line(pts((16, 20), (18.5, 16), (19.2, 11), (18, 8), (18, 5.5), (19.5, 3.5)), fill=gold, width=w, joint="curve")
    d.line(pts((6.2, 7.5), (17.8, 7.5)), fill=gold, width=w)
    d.line(pts((7.5, 19.5), (12, 21.5), (16.5, 19.5)), fill=gold, width=w, joint="curve")
    for x in (10, 12, 14):
        d.line(pts((x, 7.5), (x, 20.5)), fill=gold, width=max(1, w // 2))
    return big.resize((size, size), Image.LANCZOS)


def vitra_cube(size):
    """Vitra's glass cube, drawn big and scaled down so the edges stay smooth."""
    S = size * 8
    big = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    c, top, mid, bot = S / 2, S * .06, S * .32, S * .94
    left, right = S * .1, S * .9
    d.polygon([(c, top), (right, top + (mid - top)), (c, mid * 2 - top), (left, mid)], fill=(168, 205, 255, 255))
    d.polygon([(left, mid), (c, mid * 2 - top), (c, bot), (left, bot - (mid - top))], fill=(86, 118, 246, 255))
    d.polygon([(right, mid), (c, mid * 2 - top), (c, bot), (right, bot - (mid - top))], fill=(122, 82, 232, 255))
    d.line([(c, mid * 2 - top), (c, bot)], fill=(214, 226, 255, 255), width=max(2, S // 40))
    d.line([(left, mid), (c, mid * 2 - top), (right, mid)], fill=(232, 240, 255, 255), width=max(2, S // 40))
    return big.resize((size, size), Image.LANCZOS)


OWNER_FRAMES, OWNER_CELL = 16, (40, 32)


def owner_badge_frame(i):
    """The owner's badge: a holographic glass cube turning a quarter turn per loop (a cube looks
    the same after 90 degrees, so it loops seamlessly), colours sweeping through the rainbow, with a
    glow and a sparkle that twinkles at its corner."""
    cw, ch = OWNER_CELL
    S = 8
    W, H = cw * S, ch * S
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    t = i / OWNER_FRAMES
    hue = t

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    r, g, b = [int(v * 255) for v in colorsys.hsv_to_rgb(hue % 1, .55, 1)]
    ImageDraw.Draw(glow).ellipse([W * .5 - H * .47, H * .05, W * .5 + H * .47, H * .99], fill=(r, g, b, 120))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(H * .09)))

    a, tilt = t * math.pi / 2 + math.pi / 4, math.radians(-30)
    pts = []
    for x in (-1, 1):
        for y in (-1, 1):
            for z in (-1, 1):
                x1, z1 = x * math.cos(a) - z * math.sin(a), x * math.sin(a) + z * math.cos(a)
                y2, z2 = y * math.cos(tilt) - z1 * math.sin(tilt), y * math.sin(tilt) + z1 * math.cos(tilt)
                pts.append((x1, y2, z2))
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    size, cx, cy = H * .27, W / 2, H * .53
    d = ImageDraw.Draw(img)
    light = (-.4, -.75, .55)
    drawn = []
    for k, f in enumerate(faces):
        p0, p1, p2 = (pts[j] for j in f[:3])
        ux, uy, uz = (p1[n] - p0[n] for n in range(3))
        vx, vy, vz = (p2[n] - p0[n] for n in range(3))
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        ln = math.sqrt(nx * nx + ny * ny + nz * nz)
        nx, ny, nz = nx / ln, ny / ln, nz / ln
        if nz < 0:
            nx, ny, nz = -nx, -ny, -nz
            continue
        depth = sum(pts[j][2] for j in f) / 4
        drawn.append((depth, f, (nx, ny, nz), k))
    for depth, f, (nx, ny, nz), k in sorted(drawn):
        shade = .5 + .5 * max(0, nx * light[0] + ny * light[1] + nz * light[2])
        fh = (hue + k * .13) % 1
        r, g, b = colorsys.hsv_to_rgb(fh, .62 - .25 * (ny < -.5), min(1, shade))
        poly = [(cx + pts[j][0] * size, cy + pts[j][1] * size) for j in f]
        d.polygon(poly, fill=(int(r * 255), int(g * 255), int(b * 255), 255))
        d.line(poly + [poly[0]], fill=(255, 255, 255, 235), width=int(S * 1.15))

    sweep = Image.new("L", (W, H), 0)
    sx = W * (-.2 + 1.4 * ((t * 2) % 1))
    ImageDraw.Draw(sweep).polygon([(sx, 0), (sx + W * .12, 0), (sx - W * .08, H), (sx - W * .2, H)], fill=110)
    cube_alpha = img.split()[3].point(lambda v: 255 if v > 200 else 0)
    shine = Image.new("RGBA", (W, H), (255, 255, 255, 0))
    shine.putalpha(Image.composite(sweep, Image.new("L", (W, H), 0), cube_alpha))
    img.alpha_composite(shine)

    tw = math.sin(t * 2 * math.pi * 2)
    if tw > 0:
        k = tw
        sx, sy, R = W * .84, H * .2, H * .2 * k
        star = [(sx, sy - R), (sx + R * .22, sy - R * .22), (sx + R, sy), (sx + R * .22, sy + R * .22),
                (sx, sy + R), (sx - R * .22, sy + R * .22), (sx - R, sy), (sx - R * .22, sy - R * .22)]
        d.polygon(star, fill=(255, 255, 255, int(255 * min(1, k * 1.3))))

    out = img.resize(OWNER_CELL, Image.LANCZOS)
    if out.getpixel((cw - 1, 0))[3] == 0:
        out.putpixel((cw - 1, 0), (255, 255, 255, 1))
    return out


def owner_badge_sheet():
    cw, ch = OWNER_CELL
    sheet = Image.new("RGBA", (cw * 4, ch * 4), (0, 0, 0, 0))
    for i in range(OWNER_FRAMES):
        sheet.paste(owner_badge_frame(i), ((i % 4) * cw, (i // 4) * ch))
    return sheet


def build(slug, title, design, scale, frames, delay, sort):
    imgs = [cape_frame(design, i / frames, scale) for i in range(frames)]
    path = os.path.join(OUT, f"{slug}.png")
    strip(imgs).save(path, optimize=True)
    meta = {"slug": slug, "title": title, "frames": frames, "delay": delay, "sort": sort}
    with open(os.path.join(OUT, f"{slug}.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)
    print(f"{slug:10s} {imgs[0].size[0]}x{imgs[0].size[1] * frames:<5d} {frames:2d} frames  {os.path.getsize(path) // 1024} KB")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    cube = vitra_cube(64)
    build("glass", "Vitra Glass", with_emblem(glass, cube, (.18, .28, .82, .68)), 4, 20, 90, 0)
    build("aurora", "Aurora", aurora, 3, 24, 110, 1)
    build("ember", "Ember", ember, 3, 24, 80, 2)
    build("sakura", "Sakura", sakura, 4, 24, 110, 3)
    build("nocturne", "Nocturne", with_emblem(nocturne, lyre(64), (.2, .3, .8, .68)), 4, 1, 1000, 4)

    os.makedirs(os.path.dirname(BADGE), exist_ok=True)
    vitra_cube(32).save(BADGE)
    owner_badge_sheet().save(BADGE.replace("badge.png", "badge_owner.png"))
    print("badges", os.path.dirname(BADGE))
