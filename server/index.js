import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(); } catch { /* .env opsional */ }

const { HttpError, today } = await import('./util.js');
const { db } = await import('./db.js');
const auth = await import('./auth.js');
const S = await import('./services.js');
const { seedIfEmpty, DEMO_PASSWORD } = await import('./seed.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SECURE = process.env.COOKIE_SECURE === 'true';
const DEMO = process.env.DEMO_MODE === 'true';

const TILE_URL = process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const tileHost = (() => {
  try {
    const u = new URL(TILE_URL.replace('{s}', 'a'));
    return TILE_URL.includes('{s}') ? '*.' + u.host.split('.').slice(1).join('.') : u.host;
  } catch { return 'tile.openstreetmap.org'; }
})();

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' https://unpkg.com",
  `img-src 'self' data: blob: https://unpkg.com https://${tileHost}`,
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/* ------------------------------ ROUTER ----------------------------- */
const routes = [];
const route = (method, path, role, fn) =>
  routes.push({ method, re: new RegExp('^' + path.replace(/:id/g, '(\\d+)') + '$'), role, fn });

route('GET', '/api/config', 'public', () => ({
  demo: DEMO,
  today: today(),
  statuses: S.STATUSES,
  map: {
    tile_url: TILE_URL,
    attribution: process.env.MAP_TILE_ATTRIBUTION || '&copy; kontributor OpenStreetMap',
    lat: Number(process.env.MAP_DEFAULT_LAT || -7.6058),
    lng: Number(process.env.MAP_DEFAULT_LNG || 109.5144),
  },
}));

route('POST', '/api/login', 'public', ({ body, req, res }) => {
  const key = `${req.socket.remoteAddress}|${String(body.username || '').toLowerCase()}`;
  auth.loginGuard(key);
  const u = auth.login(body.username, body.password);
  if (!u) {
    auth.loginFailed(key);
    throw new HttpError(401, 'Username atau kata sandi salah');
  }
  auth.loginOk(key);
  const token = auth.createSession(u.id);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SECURE ? '; Secure' : ''}`);
  return { user: { id: u.id, username: u.username, name: u.name, role: u.role, is_sample: u.is_sample } };
});
route('POST', '/api/logout', 'public', ({ cookies, res }) => {
  auth.destroySession(cookies.sid);
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE ? '; Secure' : ''}`);
  return { ok: true };
});
route('GET', '/api/me', 'any', ({ user }) => ({ user }));
route('POST', '/api/me/password', 'any', ({ user, body }) => {
  const cur = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!auth.verifyPassword(String(body.current || ''), cur.password_hash)) throw new HttpError(400, 'Kata sandi saat ini salah');
  auth.checkPasswordPolicy(body.password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.password), user.id);
  return { ok: true };
});

// Geocoding (dipanggil dari server agar API key tidak terbuka di browser)
let lastGeo = 0;
route('GET', '/api/geocode', 'any', async ({ query }) => {
  const q = String(query.q || '').trim();
  if (q.length < 3) throw new HttpError(400, 'Ketik minimal 3 karakter alamat');
  const slot = Math.max(Date.now(), lastGeo + 1100); // patuhi batas 1 permintaan/detik Nominatim
  lastGeo = slot;
  await new Promise((r) => setTimeout(r, slot - Date.now()));
  const provider = process.env.GEOCODER_PROVIDER || 'nominatim';
  const key = process.env.GEOCODER_API_KEY || '';
  const enc = encodeURIComponent(q.slice(0, 200));
  const url = provider === 'locationiq' && key
    ? `https://us1.locationiq.com/v1/search?key=${encodeURIComponent(key)}&q=${enc}&format=json&limit=5&countrycodes=id`
    : `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=id&q=${enc}`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': process.env.GEOCODER_USER_AGENT || 'SewaScaffolding/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return (Array.isArray(data) ? data : []).slice(0, 5).map((d) => ({ label: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
  } catch (e) {
    console.error('Geocode gagal:', e.message);
    throw new HttpError(502, 'Pencarian alamat tidak tersedia saat ini. Anda tetap bisa menaruh pin dengan mengetuk peta.');
  }
});

// Admin
route('GET', '/api/dashboard', 'admin', () => S.dashboard());
route('GET', '/api/map', 'admin', ({ query }) => S.mapOrders(query));
route('GET', '/api/types', 'admin', () => S.stockList());
route('POST', '/api/types', 'admin', ({ body }) => S.createType(body));
route('PUT', '/api/types/:id', 'admin', ({ body, params }) => S.updateType(Number(params[0]), body));
route('GET', '/api/customers', 'admin', ({ query }) => S.listCustomers(query));
route('POST', '/api/customers', 'admin', ({ body }) => S.createCustomer(body));
route('GET', '/api/customers/:id', 'admin', ({ params }) => S.customerDetail(Number(params[0])));
route('PUT', '/api/customers/:id', 'admin', ({ body, params }) => S.updateCustomer(Number(params[0]), body));
route('DELETE', '/api/customers/:id', 'admin', ({ params }) => { S.deleteCustomer(Number(params[0])); return { ok: true }; });
route('GET', '/api/users', 'admin', () => S.listUsers());
route('POST', '/api/users', 'admin', ({ body }) => S.createUser(body));
route('PUT', '/api/users/:id', 'admin', ({ body, params, user }) => S.updateUser(Number(params[0]), body, user));
route('POST', '/api/orders', 'admin', ({ body, user }) => S.createOrder(body, user));
route('PUT', '/api/orders/:id', 'admin', ({ body, params, user }) => S.updateOrder(Number(params[0]), body, user));
route('POST', '/api/orders/:id/payments', 'admin', ({ body, params, user }) => S.addPayment(Number(params[0]), body, user));

// Admin & pengantar (pembatasan per pesanan ada di layanan)
route('GET', '/api/orders', 'any', ({ query, user }) => S.listOrders(query, user));
route('GET', '/api/orders/:id', 'any', ({ params, user }) => S.getOrder(Number(params[0]), user));
route('POST', '/api/orders/:id/status', 'any', ({ body, params, user }) => S.setStatus(Number(params[0]), body, user));
route('POST', '/api/orders/:id/location', 'any', ({ body, params, user }) => S.saveLocation(Number(params[0]), body, user));
route('POST', '/api/orders/:id/notes', 'any', ({ body, params, user }) => S.saveCourierNotes(Number(params[0]), body, user));

/* ------------------------------ HTTP ------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 200_000) throw new HttpError(413, 'Data terlalu besar');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('bukan objek');
    return v;
  } catch { throw new HttpError(400, 'Format data tidak valid'); }
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function api(req, res, url) {
  const matches = routes.filter((r) => r.re.test(url.pathname));
  if (!matches.length) throw new HttpError(404, 'Endpoint tidak ditemukan');
  const r = matches.find((m) => m.method === req.method);
  if (!r) throw new HttpError(405, 'Metode tidak diizinkan');

  const cookies = parseCookies(req.headers.cookie);
  const user = auth.userFromToken(cookies.sid);
  if (r.role !== 'public' && !user) throw new HttpError(401, 'Silakan login terlebih dahulu');
  if (r.role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Akses ditolak');

  let body = {};
  if (req.method !== 'GET') {
    // Perlindungan CSRF tambahan: wajib header khusus + JSON (SameSite=Strict sudah membatasi cookie)
    if (req.headers['x-requested-with'] !== 'sewa') throw new HttpError(403, 'Permintaan tidak valid');
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Content-Type harus application/json');
    body = await readBody(req);
  }
  const params = url.pathname.match(r.re).slice(1);
  const query = Object.fromEntries(url.searchParams);
  return send(res, 200, await r.fn({ req, res, user, body, params, query, cookies }));
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Metode tidak diizinkan');
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(ROOT)) throw new HttpError(403, 'Akses ditolak');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    throw new HttpError(404, 'Halaman tidak ditemukan');
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'Terjadi kesalahan pada server' });
  }
});

export function start(port = PORT, host = HOST) {
  const r = seedIfEmpty();
  return new Promise((resolve) => server.listen(port, host, () => {
    console.log(`Sewa Scaffolding berjalan di http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`);
    if (DEMO) {
      console.log(`MODE DEMO${r.seeded ? ' (data contoh dibuat)' : ''}. Akun contoh: admin / budi / agus, sandi: ${DEMO_PASSWORD}`);
    }
    resolve(server);
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) start();
