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
const MAX_BADGE_IMAGE_BYTES = 1_000_000;
const MAX_BADGE_COLORS = 4;
const BADGE_REQUESTS_PER_HOUR = 3;
const BADGE_REQUESTS_PER_DAY = 8;
const BADGE_STATUSES = ['new', 'approved', 'denied', 'done'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
    try {
      return withCors(await route(req, env, ctx, new URL(req.url)));
    } catch (e) {
      if (e instanceof HttpError) return withCors(json({ error: e.message }, e.status));
      console.error(e && e.stack || e);
      return withCors(json({ error: 'Something went wrong on our side.' }, 500));
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
  if (p === '/v1/badge-requests' && m === 'POST') return submitBadgeRequest(env, req, await body(req));
  if (p === '/v1/admin/badge-requests' && m === 'GET') return listBadgeRequests(env, req, url);
  let r;
  if ((r = p.match(/^\/v1\/admin\/badge-requests\/([0-9a-f]{16})$/))) {
    if (m === 'GET') return getBadgeRequest(env, req, r[1]);
    if (m === 'POST') return updateBadgeRequest(env, req, r[1], await body(req));
  }
  if ((r = p.match(/^\/v1\/admin\/badge-requests\/([0-9a-f]{16})\/image$/)) && m === 'GET') return badgeRequestImage(env, req, r[1]);
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

function sniffImage(bytes) {
  const at = (i, ...v) => v.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}

async function submitBadgeRequest(env, req, b) {
  if (b.website) return json({ ok: true }, 201);
  const discordId = String(b.discordId ?? '').trim();
  if (!SNOWFLAKE_RE.test(discordId)) throw new HttpError(400, "That Discord ID doesn't look right. It's a number 17 to 20 digits long.");
  const name = cleanText(b.name, 32, 'Your username');
  const badge = cleanText(b.badge, 40, 'The badge name');
  const details = cleanText(b.details, 1000, 'The extra info', true);
  if (!name) throw new HttpError(400, 'Add your Discord username.');
  if (!badge) throw new HttpError(400, 'Give the badge a name.');
  const colors = [...new Set((Array.isArray(b.colors) ? b.colors : []).map(c => String(c).trim().toLowerCase()))];
  if (!colors.length || colors.length > MAX_BADGE_COLORS || !colors.every(c => HEX_COLOR_RE.test(c))) {
    throw new HttpError(400, `Pick between 1 and ${MAX_BADGE_COLORS} colors.`);
  }
  let image = null, imageType = null;
  if (b.image) {
    try { image = b64bytes(String(b.image).replace(/^data:[^,]*,/, '')); } catch { throw new HttpError(400, 'That image could not be read.'); }
    if (image.length > MAX_BADGE_IMAGE_BYTES) throw new HttpError(413, 'That image is too big. Keep it under 1 MB.');
    imageType = sniffImage(image);
    if (!imageType) throw new HttpError(400, 'The image has to be a PNG, JPG, GIF or WebP.');
  }
  const now = Date.now();
  const ip = await sha256hex(`badge|${req.headers.get('cf-connecting-ip') || 'unknown'}|${env.TOKEN_SECRET || ''}`);
  const recent = await env.DB.prepare(
    'SELECT COALESCE(SUM(created > ?2), 0) AS hour, COUNT(*) AS day FROM badge_requests WHERE ip = ?1 AND created > ?3'
  ).bind(ip, now - 3600000, now - 86400000).first();
  if (recent.hour >= BADGE_REQUESTS_PER_HOUR || recent.day >= BADGE_REQUESTS_PER_DAY) {
    throw new HttpError(429, "You've sent a few already. Give it a while and try again.");
  }
  const waiting = await env.DB.prepare("SELECT id FROM badge_requests WHERE discord = ?1 AND status = 'new' AND created > ?2 LIMIT 1")
    .bind(discordId, now - 14 * 86400000).first();
  if (waiting) throw new HttpError(409, "There's already a request waiting for that account. Hang tight.");
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map(x => x.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare(
    `INSERT INTO badge_requests (id, discord, name, badge, colors, details, image, image_type, source, ip, status, created, posted)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'new', ?11, 0)`
  ).bind(id, discordId, name, badge, JSON.stringify(colors), details, image ? image.buffer : null, imageType,
    b.source === 'deadbolt' ? 'deadbolt' : 'web', ip, now).run();
  return json({ ok: true, id }, 201);
}

function feedAllowed(env, req) {
  const want = env.BADGE_FEED_KEY || '', got = req.headers.get('x-feed-key') || '';
  if (!want || want.length !== got.length) throw new HttpError(403, 'Not allowed.');
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) throw new HttpError(403, 'Not allowed.');
}

const BADGE_COLUMNS = 'id, discord, name, badge, colors, details, image_type, source, status, created, posted';

const badgeRequestOut = r => ({
  id: r.id,
  discordId: r.discord,
  name: r.name,
  badge: r.badge,
  colors: JSON.parse(r.colors),
  details: r.details,
  image: r.image_type ? { type: r.image_type, url: `https://api.xan.gripe/v1/admin/badge-requests/${r.id}/image` } : null,
  source: r.source,
  status: r.status,
  created: r.created,
  posted: !!r.posted,
});

async function listBadgeRequests(env, req, url) {
  feedAllowed(env, req);
  const pending = url.searchParams.get('pending') === '1';
  const { results } = await env.DB.prepare(
    `SELECT ${BADGE_COLUMNS} FROM badge_requests ${pending ? 'WHERE posted = 0 ORDER BY created ASC' : 'ORDER BY created DESC'} LIMIT 25`
  ).all();
  return json({ requests: results.map(badgeRequestOut) });
}

async function getBadgeRequest(env, req, id) {
  feedAllowed(env, req);
  const r = await env.DB.prepare(`SELECT ${BADGE_COLUMNS} FROM badge_requests WHERE id = ?1`).bind(id).first();
  if (!r) throw new HttpError(404, 'No such request.');
  return json(badgeRequestOut(r));
}

async function updateBadgeRequest(env, req, id, b) {
  feedAllowed(env, req);
  if (b.status !== undefined && !BADGE_STATUSES.includes(b.status)) throw new HttpError(400, 'Unknown status.');
  const r = await env.DB.prepare('UPDATE badge_requests SET status = COALESCE(?2, status), posted = COALESCE(?3, posted) WHERE id = ?1')
    .bind(id, b.status ?? null, b.posted === undefined ? null : b.posted ? 1 : 0).run();
  if (!r.meta.changes) throw new HttpError(404, 'No such request.');
  return getBadgeRequest(env, req, id);
}

async function badgeRequestImage(env, req, id) {
  feedAllowed(env, req);
  const r = await env.DB.prepare('SELECT image, image_type FROM badge_requests WHERE id = ?1').bind(id).first();
  if (!r?.image) throw new HttpError(404, 'No image.');
  return new Response(new Uint8Array(r.image), { headers: { 'content-type': r.image_type, 'cache-control': 'private, no-store' } });
}

const bearer = req => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');

async function body(req) {
  if (Number(req.headers.get('content-length') || 0) > MAX_PNG_BYTES * 1.4 + 4096) throw new HttpError(413, 'Request too large.');
  try { return await req.json(); } catch { throw new HttpError(400, 'Expected JSON.'); }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function withCors(res) {
  const r = new Response(res.body, res);
  r.headers.set('access-control-allow-origin', '*');
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

async function verifyToken(env, token) {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = await hmac(env, payload);
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff) return null;
  try {
    const claims = JSON.parse(unb64url(payload));
    return claims.e > Date.now() && UUID_RE.test(claims.u) ? claims : null;
  } catch { return null; }
}
