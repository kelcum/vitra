import importlib.util
import json
import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SOURCE = os.path.join(ROOT, "scripts", "art", "ruinednz.png")
FONT = os.path.join(ROOT, "mods", "vitra-cosmetics", "src", "main", "resources", "assets", "vitra", "textures", "font")
CAPES = os.path.join(ROOT, "services", "vitra-api", "players")

spec = importlib.util.spec_from_file_location("art", os.path.join(ROOT, "scripts", "make-cosmetics-art.py"))
art = importlib.util.module_from_spec(spec)
spec.loader.exec_module(art)

BADGE_FRAMES, BADGE_CELL = 16, 32
CAPE_FRAMES, CAPE_DELAY, CAPE_SCALE = 24, 90, 4

photo = Image.open(SOURCE).convert("L")
PW, PH = photo.size


def silhouette(cut_y):
    m = photo.point(lambda v: max(0, min(255, int((132 - v) * 255 / 70))))
    keep = Image.new("L", (PW, PH), 0)
    ImageDraw.Draw(keep).rectangle((0, 0, PW, cut_y), fill=255)
    return ImageChops.multiply(m, keep)


ANGEL = silhouette(512)


def sky(w, h, cx, cy, light, dark, spread):
    img = Image.new("L", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            dx, dy = (x - w * cx) / max(w, h), (y - h * cy) / max(w, h)
            t = min(1.0, (dx * dx + dy * dy) ** 0.5 * spread)
            px[x, y] = int(light + (dark - light) * t)
    return img


def scene(w, h, span, center_x, center_y):
    k = w * span / 800
    base = sky(w, h, .5, .3, 226, 150, 1.7)
    layer = Image.new("L", (w, h), 0)
    layer.paste(ANGEL.resize((int(PW * k), int(PH * k)), Image.LANCZOS), (int(w * center_x - 485 * k), int(h * center_y - 395 * k)))
    X = lambda v: w * center_x + (v - 485) * k
    Y = lambda v: h * center_y + (v - 395) * k
    ImageDraw.Draw(layer).ellipse((X(450 - 650), Y(905 - 400), X(450 + 650), Y(905 + 400)), fill=255)
    return Image.composite(Image.new("L", (w, h), 10), base, layer)


def sheen(w, h, t, width, strength):
    band = Image.new("L", (w, h), 0)
    px = band.load()
    pos = -0.4 + 1.8 * t
    for y in range(h):
        for x in range(w):
            d = (x / w + y / h * .55) - pos
            px[x, y] = int(255 * strength * math.exp(-(d * d) / width))
    return band


def lighten(img, band):
    white = Image.new("L", img.size, 255)
    return Image.composite(white, img, band)


def badge_frame(i):
    S = BADGE_CELL * 8
    t = i / BADGE_FRAMES
    medal = scene(S, S, 800 / 920, .5, .5)
    sweep = sheen(S, S, min(1, t / .55), .008, .7) if t < .55 else Image.new("L", (S, S), 0)
    medal = lighten(medal, sweep).convert("RGBA")
    pulse = .5 + .5 * math.sin(t * 2 * math.pi)
    ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse((S * .015, S * .015, S * .985, S * .985), outline=(255, 255, 255, int(70 + 90 * pulse)), width=int(S * .035))
    medal.alpha_composite(ring)
    circle = Image.new("L", (S, S), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, S - 1, S - 1), fill=255)
    medal.putalpha(circle)
    out = medal.resize((BADGE_CELL, BADGE_CELL), Image.LANCZOS)
    if out.getpixel((BADGE_CELL - 1, 0))[3] == 0:
        out.putpixel((BADGE_CELL - 1, 0), (255, 255, 255, 1))
    return out


def badge_sheet():
    sheet = Image.new("RGBA", (BADGE_CELL * 4, BADGE_CELL * (BADGE_FRAMES // 4)), (0, 0, 0, 0))
    for i in range(BADGE_FRAMES):
        sheet.paste(badge_frame(i), ((i % 4) * BADGE_CELL, (i // 4) * BADGE_CELL))
    return sheet


FACE_W, FACE_H = 10 * CAPE_SCALE * 4, 16 * CAPE_SCALE * 4
CAPE_SCENE = scene(FACE_W, FACE_H, .94, .5, .56)
random.seed(11)
_noise = Image.effect_noise((FACE_W, FACE_H), 60)
_tiled = Image.new("L", (FACE_W * 3, FACE_H))
for _i in range(3):
    _tiled.paste(_noise, (_i * FACE_W, 0))
GRAIN = _tiled.filter(ImageFilter.GaussianBlur(12)).crop((FACE_W, 0, FACE_W * 3, FACE_H))


def cape_face(t):
    shift = int(t * FACE_W)
    drift = GRAIN.crop((shift, 0, shift + FACE_W, FACE_H))
    clouds = drift.point(lambda v: max(0, min(255, (v - 128) * 4)))
    sky_only = CAPE_SCENE.point(lambda v: 255 if v > 60 else 0)
    base = ImageChops.add(CAPE_SCENE, ImageChops.multiply(clouds, sky_only))
    return lighten(base, sheen(FACE_W, FACE_H, t, .01, .55))


def cape_design(t):
    small = cape_face(t).resize((10 * CAPE_SCALE, 16 * CAPE_SCALE), Image.LANCZOS)
    face = small.load()
    fw, fh = small.size

    def fn(u, v, _t):
        x = min(fw - 1, max(0, int(u * fw)))
        y = min(fh - 1, max(0, int(v * fh)))
        g = face[x, y]
        return (g, g, g, 255)
    return fn


def cape_strip():
    frames = []
    for i in range(CAPE_FRAMES):
        t = i / CAPE_FRAMES
        frames.append(art.cape_frame(cape_design(t), t, CAPE_SCALE))
    return art.strip(frames)


if __name__ == "__main__":
    os.makedirs(FONT, exist_ok=True)
    badge_sheet().save(os.path.join(FONT, "badge_ruinednz.png"), optimize=True)
    os.makedirs(CAPES, exist_ok=True)
    cape_strip().save(os.path.join(CAPES, "ruinednz.png"), optimize=True)
    with open(os.path.join(CAPES, "ruinednz.json"), "w", encoding="utf-8") as f:
        json.dump({"uuid": "8d609161ba154839b74880f4d2c160d8", "name": "ruinednz", "frames": CAPE_FRAMES, "delay": CAPE_DELAY}, f, indent=2)
    print("badge", os.path.join(FONT, "badge_ruinednz.png"))
    print("cape", os.path.join(CAPES, "ruinednz.png"), os.path.getsize(os.path.join(CAPES, "ruinednz.png")) // 1024, "KB")
