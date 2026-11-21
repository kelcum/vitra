import MOJANG_KEYS from './mojang-keys.json';

const ONLINE_MS = 3 * 60 * 1000;
const TOKEN_TTL_MS = 24 * 3600 * 1000;
const PING_WRITE_MS = 60 * 1000;
const MAX_PNG_BYTES = 1_500_000;
const MAX_CAPE_WIDTH = 256;
const MAX_CAPE_FRAMES = 48;
const MAX_CAPE_PIXELS = 256 * 128 * 48;
const MAX_UPLOADS_PER_DAY = 20;
const MAX_LOOKUP = 300;
const UUID_RE = /^[0-9a-f]{32}$/;
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
const MAX_BADGE_IMAGE_BYTES = 5_000_000;
const MAX_BADGE_PREVIEW_BYTES = 200_000;
const MAX_BADGE_BODY_BYTES = 7_200_000;
const BADGE_SHAPES = ['circle', 'rounded', 'none'];
const BADGE_BACKGROUNDS = ['gradient', 'solid', 'none'];
const BADGE_EFFECTS = ['shine', 'glint', 'pulse', 'float', 'spin'];
const MAX_BADGE_COLORS = 4;
const BADGE_REQUESTS_PER_HOUR = 3;
const BADGE_REQUESTS_PER_DAY = 8;
const BADGE_TESTER_PER_HOUR = 100;
const BADGE_STATUSES = ['new', 'approved', 'denied', 'done'];
const PLUGIN_NAME_RE = /^[A-Za-z0-9 _.+-]{1,64}$/;
const MAX_BREAKAGE_PLUGINS = 50;
const BREAKAGE_ROWS_PER_DAY = 200;
const ADMIN_ORIGIN = 'https://xan.gripe';
const ADMIN_PAGE = 'https://xan.gripe/deadbolt/admin/';
const ADMIN_CALLBACK = 'https://api.xan.gripe/v1/admin/auth/callback';
const ADMIN_SESSION_MS = 7 * 86400000;
const BADGE_REQUEST_ID_RE = /^[0-9a-f]{16}$/;
const GH_REPO = 'kelcum/Deadbolt';
const GH_BRANCH = 'main';
const BADGE_DIR = 'src/plugins/_api/badges/requested';
const BADGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const DEFAULT_DESIGN = { shape: 'circle', background: 'gradient', effects: ['shine'], speed: 1, zoom: 1, x: 0, y: 0, rotate: 0 };
const MAX_BADGE_USERS = 20;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }), req);
    try {
      return withCors(await route(req, env, ctx, new URL(req.url)), req);
    } catch (e) {
      if (e instanceof HttpError) return withCors(json({ error: e.message }, e.status), req);
      console.error(e && e.stack || e);
      return withCors(json({ error: 'Something went wrong on our side.' }, 500), req);
    }
  },
};

async function route(req, env, ctx, url) {
  const p = url.pathname, m = req.method;
  if (p === '/' && m === 'GET') return json({ service: 'vitra-api', ok: true });
  if (p === '/v1/auth' && m === 'POST') return auth(env, await body(req));
  if (p === '/v1/ping' && m === 'POST') return ping(env, req, await body(req));
  if (p === '/v1/lookup' && m === 'POST') {
    const claims = await verifyToken(env, bearer(req));
    return json({ players: await lookup(env, (await body(req)).players, !!claims) });
  }
  if (p === '/v1/me' && m === 'DELETE') return deleteMe(env, await body(req));
  if (p === '/v1/presets' && m === 'GET') return presets(env);
  if (p === '/v1/stats' && m === 'GET') return stats(env);
  if (p === '/v1/me/cape' && m === 'PUT') return setCape(env, await body(req));
  if (p === '/v1/badge-requests' && m === 'POST') return submitBadgeRequest(env, req, await body(req, MAX_BADGE_BODY_BYTES * 2));
  if (p === '/v1/admin/badge-requests' && m === 'GET') return listBadgeRequests(env, req, url);
  if (p === '/v1/badges/hidden' && m === 'GET') return hiddenBadgeUsers(env);
  if (p === '/v1/badges/prefs' && m === 'GET') return badgePrefs(env);
  if (p === '/v1/badges/prefs' && m === 'POST') return setBadgePrefs(env, req, await body(req));
  if (p === '/v1/badges/hidden' && m === 'POST') return setBadgesHidden(env, req, await body(req));
  if (p === '/v1/breakage' && m === 'POST') return reportBreakage(env, req, await body(req, 8192));
  if (p === '/v1/admin/breakage' && m === 'GET') return listBreakage(env, req);
  if (p === '/v1/admin/auth/login' && m === 'GET') return adminLogin(env);
  if (p === '/v1/admin/auth/callback' && m === 'GET') return adminCallbackPage();
  if (p === '/v1/admin/auth/session' && m === 'POST') return adminSession(env, req, await body(req, 8192));
  if (p === '/v1/admin/auth/logout' && m === 'POST') return adminLogout(req);
  if (p === '/v1/admin/me' && m === 'GET') return adminMe(env, req);
  if (p === '/v1/admin/badges' && m === 'GET') return listPublishedBadges(env, req);
  if (p === '/v1/admin/badges' && m === 'POST') return publishBadge(env, req, await body(req, MAX_BADGE_BODY_BYTES * 2));
  let r;
  if ((r = p.match(/^\/v1\/admin\/badge-requests\/([0-9a-f]{16})$/))) {
    if (m === 'GET') return getBadgeRequest(env, req, r[1]);
    if (m === 'POST') return updateBadgeRequest(env, req, r[1], await body(req));
  }
  if ((r = p.match(/^\/v1\/admin\/badge-requests\/([0-9a-f]{16})\/(image|preview)$/)) && m === 'GET') return badgeRequestImage(env, req, r[1], r[2]);
  if ((r = p.match(/^\/v1\/admin\/badges\/([0-9a-f]{16})$/)) && m === 'DELETE') return unpublishBadge(env, req, r[1]);
  if ((r = p.match(/^\/v1\/admin\/breakage\/(\d{1,8})$/)) && m === 'POST') return markBreakagePosted(env, req, Number(r[1]), await body(req));
  if ((r = p.match(/^\/v1\/players\/([0-9a-f]{32})$/)) && m === 'GET') return player(env, r[1]);
  if ((r = p.match(/^\/v1\/capes\/([0-9a-f]{20})\.png$/)) && m === 'GET') return capeImage(env, ctx, req, r[1]);
  if ((r = p.match(/^\/v1\/admin\/presets\/([a-z0-9-]{1,32})$/)) && m === 'PUT') return putPreset(env, req, r[1], await body(req));
  if ((r = p.match(/^\/v1\/admin\/capes\/([0-9a-f]{32})$/)) && m === 'DELETE') return removeCape(env, r[1], await body(req));
  if ((r = p.match(/^\/v1\/admin\/players\/([0-9a-f]{32})\/cape$/)) && m === 'PUT') return assignCape(env, req, r[1], await body(req));
  throw new HttpError(404, 'Not found.');
}

const PROOF_MAX_AGE_MS = 5 * 60 * 1000;
const b64bytes = s => Uint8Array.from(atob(String(s)), c => c.charCodeAt(0));
let mojangKeys;

async function mojangCertificateKeys() {
  mojangKeys ??= await Promise.all(MOJANG_KEYS.flatMap(k => ['SHA-1', 'SHA-256'].map(hash =>
    crypto.subtle.importKey('spki', b64bytes(k.publicKey), { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']))));
  return mojangKeys;
}

async function verifyProof(name, proof, purpose) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HttpError(400, 'Bad player name.');
  const p = proof && typeof proof === 'object' ? proof : {};
  if (!UUID_RE.test(p.uuid || '')) throw new HttpError(400, 'Missing proof of account.');
  if (typeof p.expiresAt !== 'number' || p.expiresAt < Date.now()) throw new HttpError(401, 'Your Minecraft key expired. Try again.');
  if (typeof p.ts !== 'number' || Math.abs(Date.now() - p.ts) > PROOF_MAX_AGE_MS) {
    throw new HttpError(401, "Your computer's clock is off. Set the right time and try again.");
  }
  let keyDer, mojangSig, playerSig;
  try { keyDer = b64bytes(p.publicKey); mojangSig = b64bytes(p.keySignature); playerSig = b64bytes(p.signature); } catch {
    throw new HttpError(400, 'Proof of account is malformed.');
  }
  const payload = new Uint8Array(24 + keyDer.length);
  for (let i = 0; i < 16; i++) payload[i] = parseInt(p.uuid.substr(i * 2, 2), 16);
  new DataView(payload.buffer).setBigUint64(16, BigInt(p.expiresAt));
  payload.set(keyDer, 24);
  let mojangOk = false;
  for (const k of await mojangCertificateKeys()) {
    if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, mojangSig, payload)) { mojangOk = true; break; }
  }
  if (!mojangOk) throw new HttpError(401, "Couldn't confirm you own this Minecraft account.");
  let playerKey;
  try { playerKey = await crypto.subtle.importKey('spki', keyDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']); } catch {
    throw new HttpError(400, 'Proof of account is malformed.');
  }
  const message = new TextEncoder().encode(`vitra|${p.uuid}|${p.ts}|${purpose}`);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', playerKey, playerSig, message)) {
    throw new HttpError(401, "Couldn't confirm you own this Minecraft account.");
  }
  return { uuid: p.uuid, name };
}

async function sha256hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function upsertUser(env, who) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (uuid, name, created, last_seen) VALUES (?1, ?2, ?3, 0)
     ON CONFLICT (uuid) DO UPDATE SET name = ?2`
  ).bind(who.uuid, who.name, now).run();
}

async function auth(env, b) {
  const who = await verifyProof(b.name, b.proof, 'auth');
  await upsertUser(env, who);
  const token = await sign(env, { u: who.uuid, e: Date.now() + TOKEN_TTL_MS });
  return json({ token, uuid: who.uuid, expiresIn: TOKEN_TTL_MS, ...(await player(env, who.uuid, true)) });
}

async function ping(env, req, b) {
  const claims = await verifyToken(env, bearer(req));
  if (!claims) throw new HttpError(401, 'Token expired.');
  const now = Date.now();
  await env.DB.prepare('UPDATE users SET last_seen = ?1 WHERE uuid = ?2 AND last_seen < ?3')
    .bind(now, claims.u, now - PING_WRITE_MS).run();
  const players = Array.isArray(b.players) ? b.players : [];
  return json({ players: await lookup(env, [claims.u, ...players], true) });
}

async function lookup(env, list, presence) {
  if (!Array.isArray(list)) throw new HttpError(400, 'Expected a list of players.');
  const ids = [...new Set(list.filter(u => typeof u === 'string').map(u => u.replace(/-/g, '').toLowerCase()).filter(u => UUID_RE.test(u)))].slice(0, MAX_LOOKUP);
  const out = {}, now = Date.now();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT u.uuid, u.last_seen, c.id, c.w, c.h, c.frames, c.delay FROM users u
       LEFT JOIN capes c ON c.id = u.cape WHERE u.uuid IN (${chunk.map((_, j) => '?' + (j + 1)).join(',')})`
    ).bind(...chunk).all();
    for (const r of results) {
      out[r.uuid] = presence
        ? { online: now - r.last_seen < ONLINE_MS, badge: badgeFor(env, r.uuid), cape: r.id ? capeInfo(r) : null }
        : { online: false, badge: null, cape: r.id ? capeInfo(r) : null };
    }
  }
  return out;
}

const isAdmin = (env, uuid) => (env.ADMINS || '').split(',').map(s => s.trim()).includes(uuid);
const customBadge = (env, uuid) => (env.BADGES || '').split(',').map(s => s.trim().split(':')).find(([u]) => u === uuid)?.[1];
const badgeFor = (env, uuid) => (isAdmin(env, uuid) ? 'owner' : customBadge(env, uuid) || 'vitra');

const capeInfo = r => ({ id: r.id, url: `https://api.xan.gripe/v1/capes/${r.id}.png`, w: r.w, h: r.h, frames: r.frames, delay: r.delay });

async function player(env, uuid, own) {
  const r = await env.DB.prepare(
    'SELECT u.uuid, u.name, u.last_seen, c.id, c.w, c.h, c.frames, c.delay FROM users u LEFT JOIN capes c ON c.id = u.cape WHERE u.uuid = ?1'
  ).bind(uuid).first();
  const cape = r?.id ? capeInfo(r) : null;
  if (!own) return json({ cape });
  return r ? { vitra: true, name: r.name, online: Date.now() - r.last_seen < ONLINE_MS, badge: badgeFor(env, r.uuid), cape } : { vitra: false, cape: null };
}

async function stats(env) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS players, COALESCE(SUM(last_seen > ?1), 0) AS online FROM users')
    .bind(Date.now() - ONLINE_MS).first();
  return json({ players: r.players, online: r.online }, 200, { 'cache-control': 'public, max-age=30' });
}

async function presets(env) {
  const { results } = await env.DB.prepare(
    'SELECT p.slug, p.name, c.id, c.w, c.h, c.frames, c.delay FROM presets p JOIN capes c ON c.id = p.cape ORDER BY p.sort, p.name'
  ).all();
  return json({ presets: results.map(r => ({ slug: r.slug, name: r.name, cape: capeInfo(r) })) },
    200, { 'cache-control': 'public, max-age=300' });
}

async function capeImage(env, ctx, req, id) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  const r = await env.DB.prepare('SELECT png FROM capes WHERE id = ?1').bind(id).first();
  if (!r) throw new HttpError(404, 'No such cape.');
  const res = new Response(new Uint8Array(r.png), {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
  });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

async function storeCape(env, b, owner) {
  if (typeof b.image !== 'string') throw new HttpError(400, 'Missing image.');
  let bytes;
  try { bytes = Uint8Array.from(atob(b.image), c => c.charCodeAt(0)); } catch { throw new HttpError(400, 'Image is not valid base64.'); }
  if (bytes.length > MAX_PNG_BYTES) throw new HttpError(413, 'That cape is too big. Keep it under 1.5 MB.');
  checkPng(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  if (w % 64 || w < 64 || w > MAX_CAPE_WIDTH) throw new HttpError(400, `Cape width must be 64, 128, 192 or ${MAX_CAPE_WIDTH} pixels.`);
  const frameH = w / 2, frames = h / frameH;
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_CAPE_FRAMES) {
    throw new HttpError(400, `The image must be 1 to ${MAX_CAPE_FRAMES} cape frames stacked on top of each other.`);
  }
  if (w * h > MAX_CAPE_PIXELS) throw new HttpError(400, 'That cape has too many pixels. Use fewer frames or a smaller size.');
  if (b.frames !== undefined && b.frames !== frames) throw new HttpError(400, 'Frame count does not match the image.');
  const delay = Math.round(Number(b.delay) || 100);
  if (delay < 20 || delay > 5000) throw new HttpError(400, 'Frame time must be between 20 and 5000 ms.');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const id = [...new Uint8Array(hash)].slice(0, 10).map(x => x.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT OR IGNORE INTO capes (id, png, w, h, frames, delay, owner, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(id, bytes.buffer, w, h, frames, delay, owner, Date.now()).run();
  return id;
}

async function setCape(env, b) {
  const purpose = b.preset ? `cape:preset:${b.preset}` : b.image ? `cape:image:${await sha256hex(b.image)}` : 'cape:remove';
  const who = await verifyProof(b.name, b.proof, purpose);
  await upsertUser(env, who);
  let capeId = null;
  if (b.preset) {
    const p = await env.DB.prepare('SELECT cape FROM presets WHERE slug = ?1').bind(String(b.preset)).first();
    if (!p) throw new HttpError(404, 'No such cape.');
    capeId = p.cape;
  } else if (b.image) {
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM capes WHERE owner = ?1 AND created > ?2')
      .bind(who.uuid, Date.now() - 86400000).first();
    if (recent.n >= MAX_UPLOADS_PER_DAY) throw new HttpError(429, "That's a lot of capes for one day. Try again tomorrow.");
    capeId = await storeCape(env, b, who.uuid);
  } else if (!b.remove) {
    throw new HttpError(400, 'Pick a cape, upload one, or remove yours.');
  }
  await env.DB.prepare('UPDATE users SET cape = ?1 WHERE uuid = ?2').bind(capeId, who.uuid).run();
  return json(await player(env, who.uuid, true));
}

function checkPng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 57 || sig.some((v, i) => bytes[i] !== v)) throw new HttpError(400, 'The cape has to be a PNG.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = at => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (dv.getUint32(8) !== 13 || type(12) !== 'IHDR') throw new HttpError(400, 'The cape PNG is damaged.');
  const depth = bytes[24], color = bytes[25], interlace = bytes[28];
  if (depth !== 8 || (color !== 2 && color !== 6) || bytes[26] !== 0 || bytes[27] !== 0 || interlace !== 0) {
    throw new HttpError(400, 'The cape PNG must be 8-bit RGB or RGBA, not interlaced.');
  }
  let pos = 8, idat = false, end = false;
  while (pos + 12 <= bytes.length) {
    const len = dv.getUint32(pos), name = type(pos + 4);
    if (len > bytes.length - pos - 12) throw new HttpError(400, 'The cape PNG is damaged.');
    if (name === 'IDAT') idat = true;
    pos += 12 + len;
    if (name === 'IEND') { end = true; break; }
  }
  if (!idat || !end || pos !== bytes.length) throw new HttpError(400, 'The cape PNG is damaged.');
}

async function deleteMe(env, b) {
  const who = await verifyProof(b.name, b.proof, 'delete');
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM capes WHERE owner = ?1
         AND id NOT IN (SELECT cape FROM users WHERE cape IS NOT NULL AND uuid != ?1)
         AND id NOT IN (SELECT cape FROM presets)`
    ).bind(who.uuid),
    env.DB.prepare('DELETE FROM users WHERE uuid = ?1').bind(who.uuid),
  ]);
  return json({ deleted: true });
}

async function putPreset(env, req, slug, b) {
  if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) throw new HttpError(403, 'Not allowed.');
  const id = await storeCape(env, b, 'preset');
  await env.DB.prepare(
    `INSERT INTO presets (slug, name, cape, sort) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (slug) DO UPDATE SET name = ?2, cape = ?3, sort = ?4`
  ).bind(slug, String(b.title || slug), id, Number(b.sort) || 0).run();
  return json({ slug, id });
}

async function assignCape(env, req, uuid, b) {
  if (!env.ADMIN_KEY || req.headers.get('x-admin-key') !== env.ADMIN_KEY) throw new HttpError(403, 'Not allowed.');
  const user = await env.DB.prepare('SELECT uuid FROM users WHERE uuid = ?1').bind(uuid).first();
  if (!user) throw new HttpError(404, 'That player has never used Vitra.');
  const id = await storeCape(env, b, uuid);
  await env.DB.prepare('UPDATE users SET cape = ?1 WHERE uuid = ?2').bind(id, uuid).run();
  return json({ uuid, cape: id });
}

async function removeCape(env, uuid, b) {
  const who = await verifyProof(b.name, b.proof, `admin:remove:${uuid}`);
  if (!isAdmin(env, who.uuid)) throw new HttpError(403, 'Not allowed.');
  await env.DB.prepare('UPDATE users SET cape = NULL WHERE uuid = ?1').bind(uuid).run();
  return json({ removed: uuid });
}

function cleanText(value, max, label, multiline = false) {
  const s = String(value ?? '').replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length > max) throw new HttpError(400, `${label} is too long. Keep it under ${max} characters.`);
  return s;
}

function cleanDesign(d) {
  if (!d || typeof d !== 'object') return null;
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(Math.min(max, Math.max(min, n)) * 1000) / 1000 : fallback;
  };
  return {
    shape: BADGE_SHAPES.includes(d.shape) ? d.shape : 'circle',
    background: BADGE_BACKGROUNDS.includes(d.background) ? d.background : 'gradient',
    effects: [...new Set((Array.isArray(d.effects) ? d.effects : []).filter(e => BADGE_EFFECTS.includes(e)))],
    speed: num(d.speed, 0.25, 3, 1),
    zoom: num(d.zoom, 0.1, 5, 1),
    x: num(d.x, -1, 1, 0),
    y: num(d.y, -1, 1, 0),
    rotate: num(d.rotate, -180, 180, 0),
  };
}

function decodeUpload(value, max, tooBig) {
  let bytes;
  try { bytes = b64bytes(String(value).replace(/^data:[^,]*,/, '')); } catch { throw new HttpError(400, 'That image could not be read.'); }
  if (bytes.length > max) throw new HttpError(413, tooBig);
  return bytes;
}

function sniffImage(bytes) {
  const at = (i, ...v) => v.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

function badgePart(b, label = '') {
  const badge = cleanText(b.badge, 40, `The ${label}badge name`);
  if (!badge) throw new HttpError(400, `Give the ${label}badge a name.`);
  const colors = [...new Set((Array.isArray(b.colors) ? b.colors : []).map(c => String(c).trim().toLowerCase()))];
  if (!colors.length || colors.length > MAX_BADGE_COLORS || !colors.every(c => HEX_COLOR_RE.test(c))) {
    throw new HttpError(400, `Pick between 1 and ${MAX_BADGE_COLORS} colors${label ? ` for the ${label}badge` : ''}.`);
  }
  let image = null, imageType = null, preview = null;
  if (b.image) {
    image = decodeUpload(b.image, MAX_BADGE_IMAGE_BYTES, `The ${label}badge image is too big. Keep it under 5 MB.`);
    imageType = sniffImage(image);
    if (!imageType) throw new HttpError(400, 'The image has to be a PNG, JPG, GIF or WebP.');
  }
  if (b.preview) {
    preview = decodeUpload(b.preview, MAX_BADGE_PREVIEW_BYTES, 'The badge preview is too big.');
    if (sniffImage(preview) !== 'image/png') preview = null;
  }
  return { badge, colors, image, imageType, preview, design: cleanDesign(b.design) };
}

const newBadgeId = () => [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');

async function submitBadgeRequest(env, req, b) {
  if (b.website) return json({ ok: true }, 201);
  const discordId = String(b.discordId ?? '').trim();
  if (!SNOWFLAKE_RE.test(discordId)) throw new HttpError(400, "That Discord ID doesn't look right. It's a number 17 to 20 digits long.");
  const name = cleanText(b.name, 32, 'Your username');
  const details = cleanText(b.details, 1000, 'The extra info', true);
  if (!name) throw new HttpError(400, 'Add your Discord username.');
  const parts = [badgePart(b, b.pair ? 'first ' : '')];
  if (b.pair) parts.push(badgePart(b.pair, 'second '));
  const now = Date.now();
  const ip = await sha256hex(`badge|${req.headers.get('cf-connecting-ip') || 'unknown'}|${env.TOKEN_SECRET || ''}`);
  const tester = (env.BADGE_TESTERS || '').split(',').map(s => s.trim()).includes(discordId);
  const recent = await env.DB.prepare(
    'SELECT COALESCE(SUM(created > ?2), 0) AS hour, COUNT(*) AS day FROM badge_requests WHERE ip = ?1 AND created > ?3 AND pair_of IS NULL'
  ).bind(ip, now - 3600000, now - 86400000).first();
  const [perHour, perDay] = tester ? [BADGE_TESTER_PER_HOUR, BADGE_TESTER_PER_HOUR * 24] : [BADGE_REQUESTS_PER_HOUR, BADGE_REQUESTS_PER_DAY];
  if (recent.hour >= perHour || recent.day >= perDay) {
    throw new HttpError(429, "You've sent a few already. Give it a while and try again.");
  }
  const waiting = tester ? null : await env.DB.prepare("SELECT id FROM badge_requests WHERE discord = ?1 AND status = 'new' AND created > ?2 LIMIT 1")
    .bind(discordId, now - 14 * 86400000).first();
  if (waiting) throw new HttpError(409, "There's already a request waiting for that account. Hang tight.");
  const ids = parts.map(newBadgeId);
  const id = ids[0];
  const source = b.source === 'deadbolt' ? 'deadbolt' : 'web';
  await Promise.all(parts.map((p, i) => p.image && env.BADGE_IMAGES.put(`requests/${ids[i]}`, p.image, { httpMetadata: { contentType: p.imageType } })));
  await env.DB.batch(parts.map((p, i) => env.DB.prepare(
    `INSERT INTO badge_requests (id, discord, name, badge, colors, details, image, image_type, source, ip, status, created, posted, design, preview, pair_of)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new', ?11, 0, ?12, ?13, ?14)`
  ).bind(ids[i], discordId, name, p.badge, JSON.stringify(p.colors), details, null, p.imageType,
    source, ip, now, p.design ? JSON.stringify(p.design) : null, p.preview ? p.preview.buffer : null, i ? id : null)));
  return json({ ok: true, id }, 201);
}

function secretMatches(want, got) {
  if (!want || want.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return !diff;
}

function feedAllowed(env, req) {
  if (!secretMatches(env.BADGE_FEED_KEY || '', req.headers.get('x-feed-key') || '')) throw new HttpError(403, 'Not allowed.');
}

async function hiddenBadgeUsers(env, cache = 'public, max-age=30') {
  const { results } = await env.DB.prepare('SELECT user_id FROM badge_hidden ORDER BY user_id').all();
  return json({ users: results.map(r => r.user_id) }, 200, { 'cache-control': cache });
}

const BADGE_ID_RE = /^[a-z0-9_]{1,64}$/;
const BADGE_PREF_USERS_PER_HOUR = 30;

async function badgePrefs(env, cache = 'public, max-age=30') {
  const { results } = await env.DB.prepare('SELECT user_id, hidden FROM badge_prefs').all();
  const prefs = {};
  for (const r of results) {
    const hidden = JSON.parse(r.hidden || '[]');
    if (hidden.length) prefs[r.user_id] = { hidden };
  }
  return json({ prefs }, 200, { 'cache-control': cache });
}

async function setBadgePrefs(env, req, b) {
  const userId = String(b?.userId ?? '');
  if (!SNOWFLAKE_RE.test(userId)) throw new HttpError(400, 'Send your Discord user ID.');
  if (!Array.isArray(b.hidden) || b.hidden.length > 64 || !b.hidden.every(id => typeof id === 'string' && BADGE_ID_RE.test(id))) {
    throw new HttpError(400, 'Send the badges to hide as a list of badge IDs.');
  }
  const now = Date.now();
  const ip = await sha256hex(`badgeprefs|${req.headers.get('cf-connecting-ip') || 'unknown'}|${env.TOKEN_SECRET || ''}`);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM badge_prefs WHERE ip = ?1 AND updated > ?2 AND user_id != ?3')
    .bind(ip, now - 3600000, userId).first();
  if ((recent?.n || 0) >= BADGE_PREF_USERS_PER_HOUR) throw new HttpError(429, 'Too many changes from here, try again in a bit.');
  const hidden = [...new Set(b.hidden)].sort();
  await env.DB.prepare('INSERT INTO badge_prefs (user_id, hidden, ip, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id) DO UPDATE SET hidden = ?2, ip = ?3, updated = ?4')
    .bind(userId, JSON.stringify(hidden), ip, now).run();
  return badgePrefs(env, 'no-store');
}

async function setBadgesHidden(env, req, b) {
  const owner = env.BADGE_OWNER || '';
  if (!owner || !secretMatches(env.BADGE_OWNER_KEY || '', bearer(req))) throw new HttpError(403, 'Not allowed.');
  if (typeof b?.hidden !== 'boolean') throw new HttpError(400, 'Send {"hidden": true} or {"hidden": false}.');
  if (b.hidden) await env.DB.prepare('INSERT OR REPLACE INTO badge_hidden (user_id, updated) VALUES (?, ?)').bind(owner, Date.now()).run();
  else await env.DB.prepare('DELETE FROM badge_hidden WHERE user_id = ?').bind(owner).run();
  return hiddenBadgeUsers(env, 'no-store');
}

const BADGE_COLUMNS = 'id, discord, name, badge, colors, details, image_type, source, status, created, posted, design, preview IS NOT NULL AS has_preview, pair_of';

const badgeRequestOut = r => ({
  id: r.id,
  discordId: r.discord,
  name: r.name,
  badge: r.badge,
  colors: JSON.parse(r.colors),
  details: r.details,
  image: r.image_type ? { type: r.image_type, url: `https://api.xan.gripe/v1/admin/badge-requests/${r.id}/image` } : null,
  preview: r.has_preview ? `https://api.xan.gripe/v1/admin/badge-requests/${r.id}/preview` : null,
  design: r.design ? JSON.parse(r.design) : null,
  source: r.source,
  status: r.status,
  created: r.created,
  posted: !!r.posted,
  pairOf: r.pair_of,
});

async function withPair(env, r) {
  const out = badgeRequestOut(r);
  if (!r.pair_of) {
    const p = await env.DB.prepare(`SELECT ${BADGE_COLUMNS} FROM badge_requests WHERE pair_of = ?1`).bind(r.id).first();
    if (p) out.pair = badgeRequestOut(p);
  }
  return out;
}

async function listBadgeRequests(env, req, url) {
  await adminAllowed(env, req);
  const pending = url.searchParams.get('pending') === '1';
  const status = BADGE_STATUSES.includes(url.searchParams.get('status')) ? url.searchParams.get('status') : null;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 25));
  const { results } = await env.DB.prepare(
    `SELECT ${BADGE_COLUMNS} FROM badge_requests WHERE pair_of IS NULL AND (?1 IS NULL OR status = ?1) ${pending ? 'AND posted = 0 ORDER BY created ASC' : 'ORDER BY created DESC'} LIMIT ?2`
  ).bind(status, limit).all();
  return json({ requests: await Promise.all(results.map(r => withPair(env, r))) });
}

async function getBadgeRequest(env, req, id) {
  await adminAllowed(env, req);
  const r = await env.DB.prepare(`SELECT ${BADGE_COLUMNS} FROM badge_requests WHERE id = ?1`).bind(id).first();
  if (!r) throw new HttpError(404, 'No such request.');
  return json(await withPair(env, r));
}

async function updateBadgeRequest(env, req, id, b) {
  await adminAllowed(env, req);
  if (b.status !== undefined && !BADGE_STATUSES.includes(b.status)) throw new HttpError(400, 'Unknown status.');
  const r = await env.DB.prepare('UPDATE badge_requests SET status = COALESCE(?2, status), posted = COALESCE(?3, posted) WHERE id = ?1 OR pair_of = ?1')
    .bind(id, b.status ?? null, b.posted === undefined ? null : b.posted ? 1 : 0).run();
  if (!r.meta.changes) throw new HttpError(404, 'No such request.');
  return getBadgeRequest(env, req, id);
}

async function badgeRequestImage(env, req, id, which) {
  await adminAllowed(env, req);
  const r = await env.DB.prepare('SELECT image, image_type, preview FROM badge_requests WHERE id = ?1').bind(id).first();
  const bytes = which === 'preview' ? r?.preview : r?.image || (r?.image_type && await (await env.BADGE_IMAGES.get(`requests/${id}`))?.arrayBuffer());
  if (!bytes) throw new HttpError(404, 'No image.');
  return new Response(new Uint8Array(bytes), {
    headers: { 'content-type': which === 'preview' ? 'image/png' : r.image_type, 'cache-control': 'private, no-store' },
  });
}

async function reportBreakage(env, req, b) {
  const build = b?.build;
  if (!Number.isInteger(build) || build < 1 || build > 99_999_999) throw new HttpError(400, 'Send the Discord build number.');
  const plugins = Array.isArray(b.plugins) ? [...new Set(b.plugins)] : [];
  if (!plugins.length || plugins.length > MAX_BREAKAGE_PLUGINS || !plugins.every(n => typeof n === 'string' && PLUGIN_NAME_RE.test(n))) {
    throw new HttpError(400, 'Send the broken plugins as a list of plugin names.');
  }
  const now = Date.now();
  const ip = await sha256hex(`breakage|${req.headers.get('cf-connecting-ip') || 'unknown'}|${env.TOKEN_SECRET || ''}`);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM breakage_reports WHERE ip = ?1 AND created > ?2').bind(ip, now - 86400000).first();
  if ((recent?.n || 0) + plugins.length > BREAKAGE_ROWS_PER_DAY) throw new HttpError(429, 'Too many reports from here, try again tomorrow.');
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO breakage_builds (build, first) VALUES (?1, ?2)').bind(build, now),
    ...plugins.map(n => env.DB.prepare('INSERT OR IGNORE INTO breakage_reports (build, plugin, ip, created) VALUES (?1, ?2, ?3, ?4)').bind(build, n, ip, now)),
  ]);
  return json({ ok: true });
}

async function listBreakage(env, req) {
  feedAllowed(env, req);
  const recent = 'SELECT build FROM breakage_builds ORDER BY first DESC LIMIT 20';
  const { results: builds } = await env.DB.prepare(`SELECT build, first, posted, message FROM breakage_builds WHERE build IN (${recent}) ORDER BY first ASC`).all();
  const { results: rows } = await env.DB.prepare(`SELECT build, plugin, COUNT(*) AS reports FROM breakage_reports WHERE build IN (${recent}) GROUP BY build, plugin`).all();
  return json({
    builds: builds.map(x => ({
      build: x.build,
      first: x.first,
      posted: JSON.parse(x.posted),
      message: x.message,
      plugins: rows.filter(r => r.build === x.build).map(r => ({ name: r.plugin, reports: r.reports })),
    })),
  });
}

async function markBreakagePosted(env, req, build, b) {
  feedAllowed(env, req);
  if (!Array.isArray(b?.posted) || !b.posted.every(n => typeof n === 'string' && PLUGIN_NAME_RE.test(n))) throw new HttpError(400, 'Send the posted plugin names.');
  if (b.message !== undefined && !SNOWFLAKE_RE.test(String(b.message))) throw new HttpError(400, 'Send the message ID.');
  const r = await env.DB.prepare('UPDATE breakage_builds SET posted = ?2, message = COALESCE(?3, message) WHERE build = ?1')
    .bind(build, JSON.stringify([...new Set(b.posted)].sort()), b.message === undefined ? null : String(b.message)).run();
  if (!r.meta.changes) throw new HttpError(404, 'No such build.');
  return json({ ok: true });
}

const cookieOf = (req, name) => (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(name + '='))?.slice(name.length + 1) || '';
const adminCookie = (name, value, path, maxAge) => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

async function ownerSession(env, req) {
  const claims = await verifySigned(env, cookieOf(req, 'db_admin'));
  return claims?.k === 'admin' && env.BADGE_OWNER && claims.d === env.BADGE_OWNER ? claims : null;
}

async function adminAllowed(env, req, feed = true) {
  if (feed && secretMatches(env.BADGE_FEED_KEY || '', req.headers.get('x-feed-key') || '')) return;
  if (req.method !== 'GET' && req.headers.get('origin') !== ADMIN_ORIGIN) throw new HttpError(403, 'Not allowed.');
  if (!await ownerSession(env, req)) throw new HttpError(401, 'Log in to keep going.');
}

function adminLogin(env) {
  if (!env.DISCORD_CLIENT_ID) throw new HttpError(503, "Discord login isn't set up yet.");
  const state = newBadgeId() + newBadgeId();
  const q = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'token', redirect_uri: ADMIN_CALLBACK, scope: 'identify', state, prompt: 'none' });
  return new Response(null, {
    status: 302,
    headers: { location: `https://discord.com/oauth2/authorize?${q}`, 'set-cookie': adminCookie('db_state', state, '/v1/admin/auth', 600), 'cache-control': 'no-store' },
  });
}

const CALLBACK_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex">
<title>Signing in - Deadbolt</title>
<style>
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:#08090c;color:#aab3be;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.box{display:grid;justify-items:center;gap:18px}
.ring{width:42px;height:42px;border-radius:50%;border:3px solid rgba(255,255,255,.08);border-top-color:#c9c0ff;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
</style></head>
<body><div class="box"><div class="ring"></div><div>Signing you in&hellip;</div></div>
<script>
(() => {
  const page = ${JSON.stringify(ADMIN_PAGE)};
  const hash = new URLSearchParams(location.hash.slice(1));
  const query = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname);
  const fail = code => location.replace(page + "?login=" + encodeURIComponent(code));
  if (!hash.get("access_token")) return fail(hash.get("error") || query.get("error") || "cancelled");
  fetch("/v1/admin/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: hash.get("access_token"), state: hash.get("state") })
  }).then(r => r.ok ? location.replace(page) : fail(r.status === 403 ? "not_owner" : r.status === 400 ? "expired" : "failed"), () => fail("failed"));
})();
</script></body></html>`;

function adminCallbackPage() {
  return new Response(CALLBACK_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

async function adminSession(env, req, b) {
  const state = cookieOf(req, 'db_state');
  if (!state || !secretMatches(state, String(b.state || ''))) throw new HttpError(400, 'That login link expired. Try again.');
  const token = String(b.token || '');
  if (!/^[A-Za-z0-9._-]{10,200}$/.test(token)) throw new HttpError(400, "Discord didn't send a login token.");
  const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new HttpError(401, "Discord didn't accept that login. Try again.");
  const u = await res.json();
  if (!env.BADGE_OWNER || u.id !== env.BADGE_OWNER) throw new HttpError(403, 'This page is only for the owner of Deadbolt.');
  const session = await sign(env, {
    k: 'admin',
    d: u.id,
    n: encodeURIComponent(u.global_name || u.username || ''),
    a: /^(a_)?[0-9a-f]{32}$/.test(u.avatar || '') ? u.avatar : '',
    e: Date.now() + ADMIN_SESSION_MS,
  });
  const out = json({ ok: true }, 200, { 'cache-control': 'no-store' });
  out.headers.append('set-cookie', adminCookie('db_admin', session, '/v1/admin', ADMIN_SESSION_MS / 1000));
  out.headers.append('set-cookie', adminCookie('db_state', '', '/v1/admin/auth', 0));
  return out;
}

function adminLogout(req) {
  if (req.headers.get('origin') !== ADMIN_ORIGIN) throw new HttpError(403, 'Not allowed.');
  return json({ ok: true }, 200, { 'cache-control': 'no-store', 'set-cookie': adminCookie('db_admin', '', '/v1/admin', 0) });
}

async function adminMe(env, req) {
  const s = await ownerSession(env, req);
  if (!s) throw new HttpError(401, 'Not logged in.');
  const avatar = s.a ? `https://cdn.discordapp.com/avatars/${s.d}/${s.a}.${s.a.startsWith('a_') ? 'gif' : 'png'}?size=128` : null;
  return json({ id: s.d, name: decodeURIComponent(s.n || ''), avatar, expires: s.e }, 200, { 'cache-control': 'no-store' });
}

class GitHubError extends HttpError {
  constructor(status, message) { super(502, `GitHub said ${status}: ${message}`); this.gh = status; }
}

async function gh(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) throw new HttpError(503, "Publishing isn't set up yet. The GitHub token is missing.");
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'vitra-api',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new GitHubError(res.status, data?.message || 'no details');
  return data;
}

const bytesB64 = bytes => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function readPublishedBadges(env) {
  const head = (await gh(env, `/git/ref/heads/${GH_BRANCH}`)).object.sha;
  const files = await gh(env, `/contents/${BADGE_DIR}?ref=${head}`);
  const file = files.find(f => f.name === 'badges.json');
  const entries = file ? JSON.parse(new TextDecoder().decode(b64bytes((await gh(env, `/git/blobs/${file.sha}`)).content.replace(/\s/g, '')))) : [];
  return { head, files: files.map(f => f.name), entries };
}

function badgesJson(value, indent = '', lead = 0) {
  const inner = indent + '    ';
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every(v => v === null || typeof v !== 'object')) {
      const flat = `[${value.map(v => JSON.stringify(v)).join(', ')}]`;
      if (lead + flat.length + 1 <= 100) return flat;
    }
    return `[\n${value.map(v => inner + badgesJson(v, inner, inner.length)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return `{\n${keys.map(k => {
      const head = `${inner}${JSON.stringify(k)}: `;
      return head + badgesJson(value[k], inner, head.length);
    }).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}

const importOrder = line => line.match(/\d+|\D+/g).map(t => /^\d/.test(t) ? [0, Number(t), ''] : [1, 0, t.toLowerCase()]);
const compareImports = (a, b) => {
  const x = importOrder(a), y = importOrder(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    for (let j = 0; j < 3; j++) if (x[i][j] !== y[i][j]) return x[i][j] < y[i][j] ? -1 : 1;
  }
  return x.length - y.length;
};

function badgesTs(entries) {
  const imports = [], items = [];
  for (const e of entries) {
    let image = 'null';
    if (e.image) {
      const v = `img_${e.id}`;
      imports.push(`import ${v} from "file://${e.image}?base64";`);
      image = `\`data:${e.imageType};base64,\${${v}}\``;
    }
    const d = e.design;
    const design = [
      `shape: "${d.shape}"`,
      `background: "${d.background}"`,
      `colors: [${e.colors.map(c => '0x' + c.replace('#', '').toLowerCase()).join(', ')}]`,
      `effects: [${d.effects.map(x => JSON.stringify(x)).join(', ')}]`,
      ...['speed', 'zoom', 'x', 'y', 'rotate'].map(k => `${k}: ${JSON.stringify(d[k])}`),
    ].join(', ');
    items.push(`    {\n        id: "${e.id}",\n        users: [${e.users.map(u => JSON.stringify(u)).join(', ')}],\n        name: ${JSON.stringify(e.name)},\n        image: ${image},\n        design: { ${design} },\n    },`);
  }
  const out = ['/*\n * Deadbolt, a Discord client mod\n * Copyright (c) 2026 k3 and contributors\n * SPDX-License-Identifier: GPL-3.0-or-later\n */\n'];
  if (imports.length) out.push(...imports.sort(compareImports), '');
  out.push('import type { RequestedBadgeEntry } from "../requestedBadges";', '');
  if (items.length) out.push('export const requestedBadges: RequestedBadgeEntry[] = [', ...items, '];');
  else out.push('export const requestedBadges: RequestedBadgeEntry[] = [];');
  return out.join('\n') + '\n';
}

async function commitBadges(env, images, change) {
  const blobs = await Promise.all(images.map(async img => ({
    name: img.name,
    sha: (await gh(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: bytesB64(img.bytes), encoding: 'base64' }) })).sha,
  })));
  const keep = new Set(blobs.map(b => b.name));
  for (let attempt = 0; ; attempt++) {
    const { head, files, entries } = await readPublishedBadges(env);
    const { next, drop, message } = change(entries);
    const path = name => `${BADGE_DIR}/${name}`;
    const tree = [
      ...files.filter(n => !keep.has(n) && drop.some(id => n.startsWith(id + '.'))).map(n => ({ path: path(n), mode: '100644', type: 'blob', sha: null })),
      ...blobs.map(b => ({ path: path(b.name), mode: '100644', type: 'blob', sha: b.sha })),
      { path: path('badges.json'), mode: '100644', type: 'blob', content: badgesJson(next) + '\n' },
      { path: path('badges.ts'), mode: '100644', type: 'blob', content: badgesTs(next) },
    ];
    const base = (await gh(env, `/git/commits/${head}`)).tree.sha;
    const t = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base, tree }) });
    const c = await gh(env, '/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: t.sha, parents: [head] }) });
    try {
      await gh(env, `/git/refs/heads/${GH_BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha }) });
      return { commit: c.sha, entries: next };
    } catch (e) {
      if (!(e instanceof GitHubError) || e.gh !== 422 || attempt >= 2) throw e;
    }
  }
}

async function listPublishedBadges(env, req) {
  await adminAllowed(env, req, false);
  const { head, entries } = await readPublishedBadges(env);
  return json({ commit: head, base: `https://raw.githubusercontent.com/${GH_REPO}/${head}/${BADGE_DIR}/`, badges: entries }, 200, { 'cache-control': 'no-store' });
}

async function requestImage(env, row) {
  if (row.image) return new Uint8Array(row.image);
  const obj = await env.BADGE_IMAGES.get(`requests/${row.id}`);
  if (!obj) throw new HttpError(404, "That request's image is gone.");
  return new Uint8Array(await obj.arrayBuffer());
}

async function publishBadge(env, req, b) {
  await adminAllowed(env, req, false);
  const users = [...new Set((Array.isArray(b.users) ? b.users : []).map(u => String(u).trim()))];
  if (!users.length || users.length > MAX_BADGE_USERS || !users.every(u => SNOWFLAKE_RE.test(u))) {
    throw new HttpError(400, "Add the Discord ID of who gets the badge. It's a number 17 to 20 digits long.");
  }
  const raw = Array.isArray(b.parts) ? b.parts : [];
  if (raw.length < 1 || raw.length > 2) throw new HttpError(400, 'Send one badge or a matching pair.');
  let rows = [];
  if (b.requestId !== undefined && b.requestId !== null) {
    const id = String(b.requestId);
    if (!BADGE_REQUEST_ID_RE.test(id)) throw new HttpError(400, 'That request ID looks wrong.');
    rows = (await env.DB.prepare('SELECT id, name, badge, image, image_type, pair_of FROM badge_requests WHERE id = ?1 OR pair_of = ?1 ORDER BY pair_of IS NOT NULL')
      .bind(id).all()).results;
    if (!rows.length || rows[0].pair_of) throw new HttpError(404, 'No such request.');
    if (rows.length !== raw.length) throw new HttpError(400, rows.length > 1 ? 'That request is a matching pair, so publish both badges.' : 'That request is a single badge.');
  }
  const forName = cleanText(b.for, 32, 'The username') || rows[0]?.name || users[0];
  const pair = raw.length > 1;
  const parts = await Promise.all(raw.map(async (p, i) => {
    const fromRequest = p?.image === 'request';
    const part = badgePart({ ...p, image: fromRequest ? undefined : p?.image, preview: undefined }, pair ? (i ? 'second ' : 'first ') : '');
    const row = rows[i];
    let image = part.image, imageType = part.imageType;
    if (fromRequest) {
      if (!row?.image_type) throw new HttpError(400, "That request doesn't have an image.");
      image = await requestImage(env, row);
      imageType = sniffImage(image);
      if (!imageType) throw new HttpError(400, "That request's image isn't a PNG, JPG, GIF or WebP.");
    }
    const id = row ? row.id : BADGE_REQUEST_ID_RE.test(String(p?.id || '')) ? p.id : newBadgeId();
    return { id, name: part.badge, requested: row?.badge ?? part.badge, colors: part.colors, design: { ...DEFAULT_DESIGN, ...(part.design || {}) }, image, imageType };
  }));
  if (pair && parts[0].id === parts[1].id) parts[1].id = newBadgeId();
  const entries = await Promise.all(parts.map(async (p, i) => {
    const request = { badge: p.requested, for: forName };
    if (pair) request.pair = parts[1 - i].id;
    const e = { id: p.id, users, name: p.name, colors: p.colors, image: p.image ? `${p.id}.${BADGE_EXT[p.imageType]}` : null, imageType: p.image ? p.imageType : null, design: p.design, request };
    if (p.image) {
      const hash = await crypto.subtle.digest('SHA-256', p.image);
      e.imageHash = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }
    return e;
  }));
  const names = entries.map(e => `"${e.name}"`);
  const message = `Add ${forName}'s ${names.join(' and ')} badge${pair ? 's' : ''}`;
  const images = parts.filter(p => p.image).map(p => ({ name: `${p.id}.${BADGE_EXT[p.imageType]}`, bytes: p.image }));
  const result = await commitBadges(env, images, list => {
    const ids = new Set(entries.map(e => e.id));
    const next = [...list];
    for (const e of entries) {
      const at = next.findIndex(x => x.id === e.id);
      if (at >= 0) next[at] = e;
      else next.push(e);
    }
    return { next, drop: [...ids], message };
  });
  if (rows.length) await env.DB.prepare("UPDATE badge_requests SET status = 'done' WHERE id = ?1 OR pair_of = ?1").bind(rows[0].id).run();
  return json({ commit: result.commit, badges: entries }, 201);
}

async function unpublishBadge(env, req, id) {
  await adminAllowed(env, req, false);
  let gone = [];
  const result = await commitBadges(env, [], list => {
    gone = list.filter(e => e.id === id || e.request?.pair === id);
    if (!gone.some(e => e.id === id)) throw new HttpError(404, "That badge isn't published.");
    const names = gone.map(e => `"${e.name}"`);
    return { next: list.filter(e => !gone.includes(e)), drop: gone.map(e => e.id), message: `Remove the ${names.join(' and ')} badge${gone.length > 1 ? 's' : ''}` };
  });
  return json({ commit: result.commit, removed: gone.map(e => e.id) });
}

const bearer = req => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

async function body(req, max = MAX_PNG_BYTES * 1.4 + 4096) {
  if (Number(req.headers.get('content-length') || 0) > max) throw new HttpError(413, 'Request too large.');
  try { return await req.json(); } catch { throw new HttpError(400, 'Expected JSON.'); }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function withCors(res, req) {
  const r = new Response(res.body, res);
  if (req.headers.get('origin') === ADMIN_ORIGIN) {
    r.headers.set('access-control-allow-origin', ADMIN_ORIGIN);
    r.headers.set('access-control-allow-credentials', 'true');
  } else {
    r.headers.set('access-control-allow-origin', '*');
  }
  r.headers.append('vary', 'Origin');
  r.headers.set('access-control-allow-headers', 'content-type, authorization');
  r.headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
  return r;
}

const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

async function hmac(env, data) {
  if (!env.TOKEN_SECRET) throw new Error('TOKEN_SECRET is not set');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

async function sign(env, claims) {
  const payload = b64url(JSON.stringify(claims));
  return payload + '.' + await hmac(env, payload);
}

async function verifySigned(env, token) {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig || !secretMatches(await hmac(env, payload), sig)) return null;
  try {
    const claims = JSON.parse(unb64url(payload));
    return claims.e > Date.now() ? claims : null;
  } catch { return null; }
}

async function verifyToken(env, token) {
  const claims = await verifySigned(env, token);
  return claims && UUID_RE.test(claims.u) ? claims : null;
}
