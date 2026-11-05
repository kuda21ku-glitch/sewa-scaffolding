// Smoke test: menjalankan server nyata (DB in-memory) dan menguji aturan bisnis & keamanan.
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.DEMO_MODE = 'true';

const { start } = await import('../server/index.js');
const { db } = await import('../server/db.js');
const { today, addDays } = await import('../server/util.js');

const server = await start(0, '127.0.0.1');
const base = `http://127.0.0.1:${server.address().port}`;

async function call(cookie, method, path, body, { csrf = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (csrf) headers['X-Requested-With'] = 'sewa';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* kosong */ }
  return { status: res.status, data, res };
}
async function login(username, password = 'demo1234') {
  const r = await call(null, 'POST', '/login', { username, password });
  return r.status === 200 ? r.res.headers.get('set-cookie').split(';')[0] : null;
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ✓', name); } catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

const admin = await login('admin');
const budi = await login('budi');
const agus = await login('agus');
const types = (await call(admin, 'GET', '/types')).data;
const byName = (n) => types.find((t) => t.name.startsWith(n));
const mainFrame = byName('Main Frame');
const fullSet = byName('Set Scaffolding');
const budiId = (await call(admin, 'GET', '/users')).data.find((u) => u.username === 'budi').id;

console.log('Autentikasi & akses');
await test('login salah ditolak, tanpa sesi ditolak', async () => {
  assert.equal(await login('admin', 'salah-sandi'), null);
  assert.equal((await call(null, 'GET', '/orders')).status, 401);
});
await test('kata sandi tersimpan sebagai hash scrypt, bukan teks biasa', () => {
  for (const u of db.prepare('SELECT password_hash FROM users').all()) {
    assert.ok(u.password_hash.startsWith('scrypt$'));
    assert.ok(!u.password_hash.includes('demo1234'));
  }
});
await test('pengantar tidak bisa mengakses endpoint admin', async () => {
  for (const p of ['/dashboard', '/customers', '/types', '/users', '/map']) assert.equal((await call(budi, 'GET', p)).status, 403, p);
});
await test('permintaan mutasi tanpa header CSRF ditolak', async () => {
  assert.equal((await call(admin, 'POST', '/customers', { name: 'X', phone: '08123456' }, { csrf: false })).status, 403);
});
await test('pengantar hanya melihat tugas miliknya, tanpa data harga', async () => {
  const mine = (await call(budi, 'GET', '/orders')).data;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((o) => o.totals === undefined && o.payments === undefined && o.discount === undefined));
  const agusOrders = (await call(agus, 'GET', '/orders')).data;
  const other = agusOrders.find((o) => !mine.some((m) => m.id === o.id));
  assert.equal((await call(budi, 'GET', `/orders/${other.id}`)).status, 404);
});

console.log('Pesanan, harga & stok');
let order;
const before = (await call(admin, 'GET', '/types')).data.find((t) => t.id === mainFrame.id).available;
await test('total dihitung otomatis (harian: qty × harga × hari + ongkir − diskon)', async () => {
  const r = await call(admin, 'POST', '/orders', {
    new_customer: { name: 'Pelanggan Uji', phone: '081200000000', address: 'Jl. Uji' },
    start_date: today(), due_date: addDays(today(), 4), delivery_fee: 100000, discount: 20000, courier_id: budiId,
    items: [{ type_id: mainFrame.id, qty: 10 }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  order = r.data;
  // 4 hari × 10 × 5000 = 200.000 + 100.000 − 20.000
  assert.equal(order.totals.subtotal, 200000);
  assert.equal(order.totals.total, 280000);
  assert.equal(order.totals.remaining, 280000);
  assert.equal(order.status, 'Menunggu Konfirmasi');
});
await test('stok tersedia berkurang saat pesanan aktif dibuat', async () => {
  const now = (await call(admin, 'GET', '/types')).data.find((t) => t.id === mainFrame.id).available;
  assert.equal(now, before - 10);
});
await test('stok tidak boleh negatif', async () => {
  const r = await call(admin, 'POST', '/orders', {
    customer_id: order.customer_id, start_date: today(), due_date: addDays(today(), 2),
    items: [{ type_id: mainFrame.id, qty: 100000 }],
  });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Stok .* tidak cukup/);
  for (const t of (await call(admin, 'GET', '/types')).data) assert.ok(t.available >= 0, t.name);
});
await test('harga mingguan dibulatkan ke atas per minggu', async () => {
  const r = await call(admin, 'POST', '/orders', {
    customer_id: order.customer_id, start_date: today(), due_date: addDays(today(), 10),
    items: [{ type_id: fullSet.id, qty: 1 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.subtotal, fullSet.price * 2); // 10 hari = 2 minggu
});
await test('validasi input: tanggal, jumlah, telepon', async () => {
  const bad = [
    { start_date: addDays(today(), 5), due_date: today(), items: [{ type_id: mainFrame.id, qty: 1 }], customer_id: order.customer_id },
    { start_date: today(), due_date: today(), items: [{ type_id: mainFrame.id, qty: 0 }], customer_id: order.customer_id },
    { start_date: today(), due_date: today(), items: [], customer_id: order.customer_id },
    { start_date: today(), due_date: today(), items: [{ type_id: mainFrame.id, qty: 1 }], new_customer: { name: 'A', phone: 'abc' } },
  ];
  for (const b of bad) assert.equal((await call(admin, 'POST', '/orders', b)).status, 400);
});

console.log('Pembayaran');
await test('uang muka, batas pelunasan, dan sisa tagihan', async () => {
  let r = await call(admin, 'POST', `/orders/${order.id}/payments`, { kind: 'dp', amount: 80000, method: 'transfer', paid_at: today() });
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.remaining, 200000);
  assert.equal((await call(admin, 'POST', `/orders/${order.id}/payments`, { kind: 'dp', amount: 999999999, method: 'tunai', paid_at: today() })).status, 409);
  assert.equal((await call(admin, 'POST', `/orders/${order.id}/payments`, { kind: 'pelunasan', amount: 1000, method: 'tunai', paid_at: today() })).status, 409);
  r = await call(admin, 'POST', `/orders/${order.id}/payments`, { kind: 'pelunasan', amount: 200000, method: 'tunai', paid_at: today() });
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.remaining, 0);
});

console.log('Status, lokasi & pengantar');
await test('alur status pengantar dibatasi', async () => {
  assert.equal((await call(admin, 'POST', `/orders/${order.id}/status`, { status: 'Siap Dikirim' })).status, 200);
  assert.equal((await call(budi, 'POST', `/orders/${order.id}/status`, { status: 'Selesai' })).status, 403);
  assert.equal((await call(budi, 'POST', `/orders/${order.id}/status`, { status: 'Dalam Pengiriman' })).status, 200);
});
await test('lokasi manual & GPS tersimpan dengan waktu dan sumber; koordinat divalidasi', async () => {
  assert.equal((await call(budi, 'POST', `/orders/${order.id}/location`, { lat: 999, lng: 0, source: 'manual' })).status, 400);
  assert.equal((await call(budi, 'POST', `/orders/${order.id}/location`, { lat: -7.6, lng: 109.5, source: 'telepati' })).status, 400);
  let r = await call(budi, 'POST', `/orders/${order.id}/location`, { lat: -7.6058, lng: 109.5144, source: 'manual', address: 'Gombong', courier_notes: 'Pagar biru' });
  assert.equal(r.status, 200);
  assert.equal(r.data.location_source, 'manual');
  assert.ok(r.data.location_updated_at);
  r = await call(budi, 'POST', `/orders/${order.id}/location`, { lat: -7.6061, lng: 109.5150, source: 'gps-berkala' });
  assert.equal(r.data.location_source, 'gps-berkala');
  const map = (await call(admin, 'GET', '/map')).data.find((o) => o.id === order.id);
  assert.equal(map.location_source, 'gps-berkala');
  assert.ok(map.location_updated_at);
});
await test('pengantar lain tidak bisa mengubah lokasi pesanan ini', async () => {
  assert.equal((await call(agus, 'POST', `/orders/${order.id}/location`, { lat: -7.6, lng: 109.5, source: 'manual' })).status, 404);
});
await test('selesai terlambat: biaya dihitung sampai tanggal pengembalian aktual & stok kembali', async () => {
  await call(admin, 'POST', `/orders/${order.id}/status`, { status: 'Sedang Disewa' });
  const r = await call(admin, 'POST', `/orders/${order.id}/status`, { status: 'Selesai', return_date: addDays(today(), 6), damage_notes: '1 frame bengkok' });
  assert.equal(r.status, 200);
  assert.equal(r.data.totals.days, 6);
  assert.equal(r.data.totals.subtotal, 300000); // 6 × 10 × 5000
  assert.equal(r.data.damage_notes, '1 frame bengkok');
  assert.ok(r.data.history.length >= 5);
  const now = (await call(admin, 'GET', '/types')).data.find((t) => t.id === mainFrame.id).available;
  assert.equal(now, before);
});
await test('dashboard & pencarian/filter pesanan', async () => {
  const d = (await call(admin, 'GET', '/dashboard')).data;
  assert.ok(d.active_orders >= 1 && Array.isArray(d.stock) && Array.isArray(d.due_soon));
  const f = (await call(admin, 'GET', '/orders?q=Pelanggan%20Uji&status=Selesai')).data;
  assert.equal(f.length, 1);
  assert.equal((await call(admin, 'GET', '/orders?loc=yes')).data.every((o) => o.lat !== null), true);
});

console.log(`\n${passed} tes lulus${process.exitCode ? ', ADA YANG GAGAL' : ''}`);
server.close();
process.exit(process.exitCode || 0);
