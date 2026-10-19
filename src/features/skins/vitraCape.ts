import type { VitraCape } from "../../lib/types";

export interface AnimatedCape {
  frames: HTMLCanvasElement[];
  delay: number;
}

export interface PreparedCape extends AnimatedCape {
  png: string;
}

const MAX_FRAMES = 48;
const MAX_WIDTH = 256;
const MAX_PIXELS = 256 * 128 * 48;

const ELYTRA_MASK = [
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
];
const MAX_BYTES = 1_400_000;

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

const cache = new Map<string, Promise<AnimatedCape>>();

export function loadVitraCape(cape: VitraCape): Promise<AnimatedCape> {
  let p = cache.get(cape.id);
  if (!p) {
    p = (async () => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = cape.url;
      await img.decode();
      const fh = img.width / 2;
      const n = Math.max(1, Math.min(cape.frames, Math.floor(img.height / fh)));
      const frames = Array.from({ length: n }, (_, i) => {
        const c = canvas(img.width, fh);
        c.getContext("2d")!.drawImage(img, 0, i * fh, img.width, fh, 0, 0, img.width, fh);
        return c;
      });
      return { frames, delay: cape.delay };
    })();
    p.catch(() => cache.delete(cape.id));
    cache.set(cape.id, p);
  }
  return p;
}

async function decode(file: File): Promise<AnimatedCape> {
  const Decoder = (window as unknown as { ImageDecoder?: any }).ImageDecoder;
  if (Decoder && /gif|webp|png/i.test(file.type)) {
    try {
      const dec = new Decoder({ data: await file.arrayBuffer(), type: file.type });
      await dec.tracks.ready;
      const total: number = dec.tracks.selectedTrack?.frameCount ?? 1;
      const step = Math.max(1, total / MAX_FRAMES);
      const frames: HTMLCanvasElement[] = [];
      let micros = 0;
      for (let f = 0; f < total && frames.length < MAX_FRAMES; f += step) {
        const { image } = await dec.decode({ frameIndex: Math.floor(f) });
        const c = canvas(image.displayWidth, image.displayHeight);
        c.getContext("2d")!.drawImage(image, 0, 0);
        micros += image.duration ?? 100_000;
        image.close();
        frames.push(c);
      }
      dec.close();
      const delay = (micros / frames.length / 1000) * step;
      return { frames, delay: Math.round(delay) || 100 };
    } catch {
    }
  }
  const bmp = await createImageBitmap(file);
  const c = canvas(bmp.width, bmp.height);
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  return { frames: [c], delay: 100 };
}

function cover(g: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, w: number, h: number, flip = false) {
  const scale = Math.max(w / src.width, h / src.height);
  const sw = w / scale;
  const sh = h / scale;
  g.save();
  if (flip) {
    g.translate(x + w, y);
    g.scale(-1, 1);
    x = 0;
    y = 0;
  }
  g.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, x, y, w, h);
  g.restore();
}

function darken(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, amount: number) {
  g.save();
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = `rgba(0,0,0,${amount})`;
  g.fillRect(x, y, w, h);
  g.restore();
}

function pictureToCape(art: HTMLCanvasElement, s: number): HTMLCanvasElement {
  const out = canvas(64 * s, 32 * s);
  const g = out.getContext("2d")!;
  const pixelArt = art.width <= 64 && art.height <= 64;
  g.imageSmoothingEnabled = !pixelArt;
  g.imageSmoothingQuality = "high";
  const r = (x: number, y: number, w: number, h: number) => [x * s, y * s, w * s, h * s] as const;
  cover(g, art, ...r(1, 1, 10, 16));
  cover(g, art, ...r(12, 1, 10, 16), true);
  darken(g, ...r(12, 1, 10, 16), 0.45);
  const strip = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number, dark: number) => {
    g.drawImage(art, sx, sy, Math.max(1, sw), Math.max(1, sh), ...r(dx, dy, dw, dh));
    darken(g, ...r(dx, dy, dw, dh), dark);
  };
  strip(0, 0, art.width * 0.06, art.height, 0, 1, 1, 16, 0.3);
  strip(art.width * 0.94, 0, art.width * 0.06, art.height, 11, 1, 1, 16, 0.3);
  strip(0, 0, art.width, art.height * 0.04, 1, 0, 10, 1, 0.15);
  strip(0, art.height * 0.96, art.width, art.height * 0.04, 11, 0, 10, 1, 0.4);
  const wing = canvas(24 * s, 22 * s);
  const wg = wing.getContext("2d")!;
  wg.imageSmoothingEnabled = !pixelArt;
  wg.imageSmoothingQuality = "high";
  cover(wg, art, 12 * s, 0, 12 * s, 22 * s);
  wg.drawImage(wing, 12 * s, 0, 1, 22 * s, 0, 0, 12 * s, 22 * s);
  const mask = canvas(24 * s, 22 * s);
  const mg = mask.getContext("2d")!;
  ELYTRA_MASK.forEach((row, y) => [...row].forEach((c, x) => c === "#" && mg.fillRect(x * s, y * s, s, s)));
  wg.globalCompositeOperation = "destination-in";
  wg.drawImage(mask, 0, 0);
  g.drawImage(wing, 22 * s, 0);
  return out;
}

function padTexture(src: HTMLCanvasElement): HTMLCanvasElement {
  let w = 64;
  while (w < src.width) w *= 2;
  const out = canvas(w, w / 2);
  out.getContext("2d")!.drawImage(src, 0, 0);
  return out;
}

function fitWidth(src: HTMLCanvasElement, max = MAX_WIDTH): HTMLCanvasElement {
  if (src.width <= max) return src;
  const out = canvas(max, max / 2);
  const g = out.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

async function encode(frames: HTMLCanvasElement[]): Promise<string> {
  const w = frames[0].width;
  const h = frames[0].height;
  const out = canvas(w, h * frames.length);
  const g = out.getContext("2d")!;
  frames.forEach((f, i) => g.drawImage(f, 0, i * h));
  const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
  if (!blob) throw new Error("Couldn't encode the cape.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function prepareCape(file: File): Promise<PreparedCape> {
  if (file.size > 25_000_000) throw new Error("That file is over 25 MB. Pick a smaller image or GIF.");
  const decoded = await decode(file);
  const { width: w, height: h } = decoded.frames[0];
  const delay = Math.min(5000, Math.max(20, decoded.delay));

  const isTexture = (cw: number, ch: number) => cw % 64 === 0 && cw >= 64 && ch * 2 === cw;
  const isOptifine = w % 46 === 0 && h * 46 === w * 22;
  const isStrip = decoded.frames.length === 1 && w % 64 === 0 && w >= 64 && h > w / 2 && h % (w / 2) === 0 && h / (w / 2) <= 64;

  let textures: (s: number) => HTMLCanvasElement[];
  if (isTexture(w, h)) {
    textures = () => decoded.frames.map((f) => fitWidth(f));
  } else if (isOptifine) {
    textures = () => decoded.frames.map((f) => fitWidth(padTexture(f)));
  } else if (isStrip) {
    const fh = w / 2;
    const frames = Array.from({ length: h / fh }, (_, i) => {
      const c = canvas(w, fh);
      c.getContext("2d")!.drawImage(decoded.frames[0], 0, i * fh, w, fh, 0, 0, w, fh);
      return fitWidth(c);
    });
    textures = () => frames;
  } else {
    textures = (s) => decoded.frames.map((f) => pictureToCape(f, s));
  }

  let frames = textures(4);
  let frameDelay = delay;
  while (frames.length > 1 && frames.length * frames[0].width * frames[0].height > MAX_PIXELS) {
    frames = frames.filter((_, i) => i % 2 === 0);
    frameDelay = Math.min(5000, frameDelay * 2);
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const png = await encode(frames);
    if (png.length * 0.75 <= MAX_BYTES) return { frames, delay: Math.round(frameDelay), png };
    if (attempt === 0) frames = textures(3);
    else if (attempt === 1) frames = textures(2);
    else if (frames.length > 1) {
      frames = frames.filter((_, i) => i % 2 === 0);
      frameDelay = Math.min(5000, frameDelay * 2);
    } else break;
  }
  throw new Error("That cape is too detailed to fit in 1.5 MB, even after shrinking it. Try a shorter or smaller GIF.");
}
