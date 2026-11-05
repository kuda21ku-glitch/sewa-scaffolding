import { db } from './db.js';
import { today, addDays } from './util.js';
import {
  createUser, createType, createCustomer, createOrder, setStatus, addPayment, saveLocation, getOrder,
} from './services.js';

export const DEMO_PASSWORD = 'demo1234';

export function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return { seeded: false };

  if (process.env.DEMO_MODE !== 'true') {
    const u = process.env.ADMIN_USERNAME;
    const p = process.env.ADMIN_PASSWORD;
    if (!u || !p) {
      console.error('DEMO_MODE=false dan belum ada pengguna. Isi ADMIN_USERNAME dan ADMIN_PASSWORD di .env untuk membuat admin pertama.');
      process.exit(1);
    }
    createUser({ username: u, name: 'Pemilik', role: 'admin', password: p });
    console.log(`Admin pertama "${u}" dibuat.`);
    return { seeded: false };
  }

  // ---- DATA CONTOH (semua ditandai is_sample = 1 dan tampil sebagai "CONTOH" di aplikasi) ----
  const mark = (table, ids) => ids.forEach((id) => db.prepare(`UPDATE ${table} SET is_sample = 1 WHERE id = ?`).run(id));
  const admin = createUser({ username: 'admin', name: 'Pemilik (Contoh)', role: 'admin', password: DEMO_PASSWORD }, { sample: 1 });
  const budi = createUser({ username: 'budi', name: 'Budi (Pengantar Contoh)', role: 'courier', password: DEMO_PASSWORD }, { sample: 1 });
  const agus = createUser({ username: 'agus', name: 'Agus (Pengantar Contoh)', role: 'courier', password: DEMO_PASSWORD }, { sample: 1 });
  const A = { id: admin.id, role: 'admin' };
  const B = { id: budi.id, role: 'courier' };
  const G = { id: agus.id, role: 'courier' };

  const types = [
    ['Main Frame 170 cm', 'Rangka utama', 'day', 5000, 120],
    ['Cross Brace', 'Penyilang rangka', 'day', 1500, 200],
    ['Join Pin', 'Sambungan antar frame', 'day', 500, 300],
    ['U-Head Jack', 'Penyangga atas', 'day', 2000, 100],
    ['Base Jack', 'Penyangga bawah', 'day', 2000, 100],
    ['Catwalk / Papan Pijakan', 'Alas pijak', 'day', 3000, 80],
    ['Set Scaffolding Lengkap', '1 set = 2 main frame, 2 brace, 4 jack, 1 catwalk', 'week', 120000, 30],
  ].map(([name, description, unit, price, stock_total]) => createType({ name, description, unit, price, stock_total }));
  mark('scaffold_types', types.map((t) => t.id));
  const [mf, cb, jp, uh, , cw, set] = types.map((t) => t.id);

  const custs = [
    ['Budi Santoso (CV Maju Jaya) [contoh]', '081234560001', 'Jl. Yos Sudarso, Gombong'],
    ['Toko Bangunan Sinar [contoh]', '081234560002', 'Jl. Pahlawan, Kebumen'],
    ['Pak Hendra [contoh]', '081234560003', 'Perum Griya Asri, Purwokerto'],
    ['Ibu Sari [contoh]', '081234560004', 'Jl. Kenanga, Cilacap'],
    ['PT Karya Bangun [contoh]', '081234560005', 'Kawasan Industri, Gombong'],
  ].map(([name, phone, address]) => createCustomer({ name, phone, address }));
  mark('customers', custs.map((c) => c.id));
  const t = today();

  function make(cust, items, start, due, extra, steps, loc, pay) {
    const o = createOrder({ customer_id: cust.id, items, start_date: addDays(t, start), due_date: addDays(t, due), ...extra }, A, { sample: 1 });
    for (const s of steps) setStatus(o.id, typeof s === 'string' ? { status: s } : s, A);
    if (loc) saveLocation(o.id, loc, extra.courier_id === budi.id ? B : G);
    if (pay) {
      const total = getOrder(o.id, A).totals.total;
      addPayment(o.id, { kind: 'dp', amount: Math.round(total * pay), method: 'transfer', paid_at: addDays(t, start), note: 'Data contoh' }, A);
    }
    return o;
  }

  make(custs[0], [{ type_id: mf, qty: 20 }, { type_id: cb, qty: 40 }, { type_id: jp, qty: 40 }], -5, 2,
    { courier_id: budi.id, delivery_fee: 150000, project_notes: 'Pengecatan ruko 2 lantai' },
    ['Siap Dikirim', 'Dalam Pengiriman', 'Sedang Disewa'],
    { lat: -7.6058, lng: 109.5144, source: 'manual', courier_notes: 'Pagar hijau, parkir truk di samping' }, 0.3);

  make(custs[1], [{ type_id: set, qty: 3 }], -10, -1,
    { courier_id: agus.id, delivery_fee: 200000, discount: 50000, project_notes: 'Renovasi fasad toko' },
    ['Siap Dikirim', 'Dalam Pengiriman', 'Sedang Disewa', 'Menunggu Penjemputan'],
    { lat: -7.6682, lng: 109.6529, source: 'gps' }, 0.5);

  make(custs[2], [{ type_id: mf, qty: 10 }, { type_id: uh, qty: 10 }, { type_id: cw, qty: 6 }], 1, 8,
    { courier_id: agus.id, delivery_fee: 250000, project_notes: 'Renovasi rumah 2 lantai' }, ['Siap Dikirim'], null, 0.2);

  make(custs[3], [{ type_id: mf, qty: 8 }, { type_id: cb, qty: 16 }], 0, 3,
    { courier_id: budi.id, delivery_fee: 300000, other_fee: 50000, other_fee_label: 'Pemasangan', project_notes: 'Pengecatan pagar' },
    ['Siap Dikirim', 'Dalam Pengiriman'],
    { lat: -7.7199, lng: 109.0092, source: 'gps-berkala' }, null);

  make(custs[4], [{ type_id: mf, qty: 30 }, { type_id: cb, qty: 60 }, { type_id: jp, qty: 60 }], 3, 10,
    { delivery_fee: 175000, project_notes: 'Menunggu konfirmasi jadwal' }, [], null, null);

  const done = make(custs[0], [{ type_id: cb, qty: 10 }], -20, -13, { courier_id: budi.id, delivery_fee: 100000 }, [], null, null);
  setStatus(done.id, { status: 'Selesai', return_date: addDays(t, -12), damage_notes: 'Contoh: 1 cross brace bengkok.' }, A);
  const rem = getOrder(done.id, A).totals.remaining;
  addPayment(done.id, { kind: 'pelunasan', amount: rem, method: 'tunai', paid_at: addDays(t, -12), note: 'Data contoh' }, A);

  const canceled = make(custs[1], [{ type_id: mf, qty: 5 }], -3, 4, {}, [], null, null);
  setStatus(canceled.id, { status: 'Dibatalkan', note: 'Contoh: pelanggan membatalkan' }, A);

  return { seeded: true };
}
