import { db, tx, nowIso } from './db.js';
import {
  HttpError, today, addDays, reqDate, reqStr, optStr, int, oneOf, coords, validPhone,
} from './util.js';
import { computeTotals, CLOSED, STATUSES } from '../public/calc.js';
import { hashPassword, checkPasswordPolicy, destroyUserSessions } from './auth.js';

export { STATUSES };
export const ACTIVE_RENTAL = ['Sedang Disewa', 'Menunggu Penjemputan'];
export const METHODS = ['tunai', 'transfer', 'qris', 'lainnya'];
// Alur yang boleh dilakukan pengantar
const COURIER_FLOW = {
  'Siap Dikirim': ['Dalam Pengiriman'],
  'Dalam Pengiriman': ['Sedang Disewa'],
  'Menunggu Penjemputan': ['Selesai'],
};
const COURIER_VISIBLE = ['Siap Dikirim', 'Dalam Pengiriman', 'Sedang Disewa', 'Menunggu Penjemputan'];

/* ------------------------------ STOK ------------------------------ */

// Stok tersedia = total - jumlah pada pesanan yang belum Selesai/Dibatalkan.
// Dihitung langsung dari data pesanan, jadi tidak pernah "melenceng" dari kenyataan.
export function stockList(excludeOrderId = -1) {
  return db.prepare(`
    SELECT t.id, t.name, t.description, t.unit, t.price, t.stock_total, t.active, t.is_sample,
      COALESCE(SUM(CASE WHEN o.status NOT IN ('Selesai','Dibatalkan') AND o.id != ? THEN i.qty ELSE 0 END),0) AS reserved,
      COALESCE(SUM(CASE WHEN o.status IN ('Sedang Disewa','Menunggu Penjemputan') AND o.id != ? THEN i.qty ELSE 0 END),0) AS rented
    FROM scaffold_types t
    LEFT JOIN order_items i ON i.type_id = t.id
    LEFT JOIN orders o ON o.id = i.order_id
    GROUP BY t.id ORDER BY t.name`).all(excludeOrderId, excludeOrderId)
    .map((r) => ({ ...r, available: r.stock_total - r.reserved }));
}

function resolveItems(rawItems, excludeId, existing = []) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, 'Tambahkan minimal satu barang');
  if (rawItems.length > 50) throw new HttpError(400, 'Terlalu banyak baris barang');
  const merged = new Map();
  for (const it of rawItems) {
    const type_id = int(it?.type_id, 'Jenis barang', { min: 1 });
    const qty = int(it?.qty, 'Jumlah barang', { min: 1, max: 100000 });
    merged.set(type_id, (merged.get(type_id) || 0) + qty);
  }
  const stock = new Map(stockList(excludeId).map((s) => [s.id, s]));
  const old = new Map(existing.map((e) => [e.type_id, e]));
  const out = [];
  for (const [type_id, qty] of merged) {
    const s = stock.get(type_id);
    if (!s) throw new HttpError(400, 'Jenis barang tidak ditemukan');
    if (!s.active && !old.has(type_id)) throw new HttpError(400, `${s.name} sedang tidak aktif`);
    if (qty > s.available) {
      throw new HttpError(409, `Stok ${s.name} tidak cukup: tersedia ${s.available}, diminta ${qty}`);
    }
    const o = old.get(type_id);
    out.push({ type_id, qty, unit_price: o ? o.unit_price : s.price, unit: o ? o.unit : s.unit });
  }
  return out;
}

/* ----------------------------- PESANAN ---------------------------- */

const ORDER_SQL = `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
  u.name AS courier_name
  FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN users u ON u.id = o.courier_id`;

function hydrate(row, role, withHistory = false) {
  const items = db.prepare(`SELECT i.id, i.type_id, t.name, i.qty, i.unit_price, i.unit
    FROM order_items i JOIN scaffold_types t ON t.id = i.type_id WHERE i.order_id = ? ORDER BY i.id`).all(row.id);
  const overdue = ACTIVE_RENTAL.includes(row.status) && row.due_date < today();
  const history = withHistory
    ? db.prepare(`SELECT h.status, h.note, h.at, u.name AS by_name FROM status_history h
        LEFT JOIN users u ON u.id = h.by_user WHERE h.order_id = ? ORDER BY h.id`).all(row.id)
    : undefined;

  if (role === 'courier') {
    // Pengantar tidak melihat harga, pembayaran, atau diskon.
    return {
      id: row.id, code: row.code, status: row.status, is_sample: row.is_sample, overdue,
      customer_name: row.customer_name, customer_phone: row.customer_phone,
      address: row.address || row.customer_address, project_notes: row.project_notes,
      start_date: row.start_date, due_date: row.due_date, return_date: row.return_date,
      items: items.map((i) => ({ type_id: i.type_id, name: i.name, qty: i.qty })),
      lat: row.lat, lng: row.lng, location_source: row.location_source,
      location_updated_at: row.location_updated_at,
      courier_notes: row.courier_notes, damage_notes: row.damage_notes, history,
    };
  }
  const payments = db.prepare(`SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by
    WHERE p.order_id = ? ORDER BY p.paid_at, p.id`).all(row.id);
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const totals = computeTotals({ ...row, items, paid });
  return {
    id: row.id, code: row.code, status: row.status, is_sample: row.is_sample, overdue,
    customer_id: row.customer_id, customer_name: row.customer_name, customer_phone: row.customer_phone,
    customer_address: row.customer_address, address: row.address,
    courier_id: row.courier_id, courier_name: row.courier_name,
    start_date: row.start_date, due_date: row.due_date, return_date: row.return_date,
    delivery_fee: row.delivery_fee, other_fee: row.other_fee, other_fee_label: row.other_fee_label,
    discount: row.discount, project_notes: row.project_notes,
    courier_notes: row.courier_notes, damage_notes: row.damage_notes,
    lat: row.lat, lng: row.lng, location_source: row.location_source,
    location_updated_at: row.location_updated_at,
    items, payments, totals, history, created_at: row.created_at,
  };
}

function loadRow(id) {
  const row = db.prepare(`${ORDER_SQL} WHERE o.id = ?`).get(id);
  if (!row) throw new HttpError(404, 'Pesanan tidak ditemukan');
  return row;
}

function assertCourierAccess(row, user) {
  if (user.role === 'courier' && (row.courier_id !== user.id || !COURIER_VISIBLE.includes(row.status))) {
    throw new HttpError(404, 'Pesanan tidak ditemukan');
  }
}

export function getOrder(id, user) {
  const row = loadRow(id);
  assertCourierAccess(row, user);
  return hydrate(row, user.role, true);
}

export function listOrders(q, user) {
  const where = [];
  const params = [];
  if (user.role === 'courier') {
    where.push('o.courier_id = ?', `o.status IN (${COURIER_VISIBLE.map(() => '?').join(',')})`);
    params.push(user.id, ...COURIER_VISIBLE);
  }
  if (q.q) {
    where.push('(c.name LIKE ? OR c.phone LIKE ? OR o.code LIKE ?)');
    const like = `%${String(q.q).slice(0, 100)}%`;
    params.push(like, like, like);
  }
  if (q.place) {
    where.push('(o.address LIKE ? OR c.address LIKE ?)');
    const like = `%${String(q.place).slice(0, 100)}%`;
    params.push(like, like);
  }
  if (q.status && STATUSES.includes(q.status)) { where.push('o.status = ?'); params.push(q.status); }
  if (q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from)) { where.push('o.start_date >= ?'); params.push(q.from); }
  if (q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to)) { where.push('o.start_date <= ?'); params.push(q.to); }
  if (q.loc === 'yes') where.push('o.lat IS NOT NULL');
  if (q.loc === 'no') where.push('o.lat IS NULL');
  const rows = db.prepare(`${ORDER_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN o.status IN ('Selesai','Dibatalkan') THEN 1 ELSE 0 END, o.start_date DESC, o.id DESC LIMIT 300`)
    .all(...params);
  return rows.map((r) => hydrate(r, user.role));
}

function resolveCourier(v) {
  if (v === undefined || v === null || v === '') return null;
  const id = int(v, 'Pengantar', { min: 1 });
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'courier' AND active = 1").get(id);
  if (!u) throw new HttpError(400, 'Pengantar tidak ditemukan atau tidak aktif');
  return id;
}

function resolveCustomer(d) {
  if (d.customer_id) {
    const id = int(d.customer_id, 'Pelanggan', { min: 1 });
    const c = db.prepare('SELECT id, address FROM customers WHERE id = ?').get(id);
    if (!c) throw new HttpError(400, 'Pelanggan tidak ditemukan');
    return c;
  }
  const n = d.new_customer;
  if (!n || typeof n !== 'object') throw new HttpError(400, 'Pilih pelanggan atau isi data pelanggan baru');
  const name = reqStr(n.name, 'Nama pelanggan', { max: 120 });
  const phone = validPhone(n.phone);
  const address = optStr(n.address, 'Alamat pelanggan', 300);
  const r = db.prepare('INSERT INTO customers (name, phone, address) VALUES (?,?,?)').run(name, phone, address);
  return { id: Number(r.lastInsertRowid), address };
}

function parseOrderFields(d) {
  const start_date = reqDate(d.start_date, 'Tanggal mulai sewa');
  const due_date = reqDate(d.due_date, 'Perkiraan tanggal selesai');
  if (due_date < start_date) throw new HttpError(400, 'Perkiraan tanggal selesai tidak boleh sebelum tanggal mulai');
  return {
    start_date, due_date,
    delivery_fee: int(d.delivery_fee ?? 0, 'Ongkos kirim'),
    other_fee: int(d.other_fee ?? 0, 'Biaya tambahan'),
    other_fee_label: optStr(d.other_fee_label, 'Keterangan biaya tambahan', 100),
    discount: int(d.discount ?? 0, 'Diskon'),
    project_notes: optStr(d.project_notes, 'Catatan proyek', 1000),
    address: optStr(d.address, 'Alamat pengantaran', 300),
    courier_id: resolveCourier(d.courier_id),
  };
}

function assertDiscount(f, items) {
  const t = computeTotals({ ...f, items, paid: 0 });
  if (f.discount > t.subtotal + f.delivery_fee + f.other_fee) {
    throw new HttpError(400, 'Diskon tidak boleh melebihi subtotal ditambah biaya lain');
  }
}

function writeItems(orderId, items) {
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(orderId);
  const ins = db.prepare('INSERT INTO order_items (order_id, type_id, qty, unit_price, unit) VALUES (?,?,?,?,?)');
  for (const i of items) ins.run(orderId, i.type_id, i.qty, i.unit_price, i.unit);
}

function logStatus(orderId, status, note, userId) {
  db.prepare('INSERT INTO status_history (order_id, status, note, by_user, at) VALUES (?,?,?,?,?)')
    .run(orderId, status, note || '', userId, nowIso());
}

export function createOrder(d, user, { sample = 0 } = {}) {
  return tx(() => {
    const f = parseOrderFields(d);
    const cust = resolveCustomer(d);
    const items = resolveItems(d.items, -1);
    assertDiscount(f, items);
    const address = f.address || cust.address;
    const r = db.prepare(`INSERT INTO orders (customer_id, status, start_date, due_date, delivery_fee, other_fee,
      other_fee_label, discount, project_notes, address, courier_id, is_sample)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(cust.id, 'Menunggu Konfirmasi', f.start_date, f.due_date, f.delivery_fee, f.other_fee,
        f.other_fee_label, f.discount, f.project_notes, address, f.courier_id, sample);
    const id = Number(r.lastInsertRowid);
    const code = `SW-${f.start_date.slice(0, 4)}-${String(id).padStart(4, '0')}`;
    db.prepare('UPDATE orders SET code = ? WHERE id = ?').run(code, id);
    writeItems(id, items);
    logStatus(id, 'Menunggu Konfirmasi', 'Pesanan dibuat', user.id);
    return hydrate(loadRow(id), 'admin', true);
  });
}

export function updateOrder(id, d, user) {
  return tx(() => {
    const row = loadRow(id);
    if (CLOSED.includes(row.status)) throw new HttpError(409, 'Pesanan yang sudah selesai/dibatalkan tidak dapat diubah');
    const f = parseOrderFields(d);
    const existing = db.prepare('SELECT type_id, unit_price, unit FROM order_items WHERE order_id = ?').all(id);
    const items = resolveItems(d.items, id, existing);
    assertDiscount(f, items);
    db.prepare(`UPDATE orders SET start_date=?, due_date=?, delivery_fee=?, other_fee=?, other_fee_label=?, discount=?,
      project_notes=?, address=?, courier_id=?, updated_at=? WHERE id=?`)
      .run(f.start_date, f.due_date, f.delivery_fee, f.other_fee, f.other_fee_label, f.discount,
        f.project_notes, f.address, f.courier_id, nowIso(), id);
    writeItems(id, items);
    logStatus(id, row.status, 'Data pesanan diubah', user.id);
    return hydrate(loadRow(id), 'admin', true);
  });
}

export function setStatus(id, d, user) {
  return tx(() => {
    const row = loadRow(id);
    assertCourierAccess(row, user);
    const next = oneOf(d.status, STATUSES, 'Status');
    if (next === row.status) throw new HttpError(400, 'Status sudah sama');
    if (user.role === 'courier' && !(COURIER_FLOW[row.status] || []).includes(next)) {
      throw new HttpError(403, 'Anda tidak dapat mengubah ke status tersebut');
    }
    // Membuka kembali pesanan yang sudah ditutup harus lolos cek stok.
    if (CLOSED.includes(row.status) && !CLOSED.includes(next)) {
      const stock = new Map(stockList().map((s) => [s.id, s]));
      for (const it of db.prepare('SELECT type_id, qty FROM order_items WHERE order_id = ?').all(id)) {
        const s = stock.get(it.type_id);
        if (it.qty > s.available) throw new HttpError(409, `Stok ${s.name} tidak cukup untuk membuka kembali pesanan (tersedia ${s.available})`);
      }
    }
    let return_date = row.return_date;
    if (next === 'Selesai') {
      return_date = user.role === 'admin' && d.return_date ? reqDate(d.return_date, 'Tanggal pengembalian') : today();
      if (return_date < row.start_date) throw new HttpError(400, 'Tanggal pengembalian tidak boleh sebelum tanggal mulai');
    } else if (row.status === 'Selesai') {
      return_date = null;
    }
    const damage = d.damage_notes !== undefined ? optStr(d.damage_notes, 'Catatan kerusakan/kehilangan', 1000) : row.damage_notes;
    db.prepare('UPDATE orders SET status=?, return_date=?, damage_notes=?, updated_at=? WHERE id=?')
      .run(next, return_date, damage, nowIso(), id);
    logStatus(id, next, optStr(d.note, 'Catatan', 300), user.id);
    return hydrate(loadRow(id), user.role, true);
  });
}

export function addPayment(id, d, user) {
  return tx(() => {
    const row = loadRow(id);
    if (row.status === 'Dibatalkan') throw new HttpError(409, 'Pesanan dibatalkan tidak dapat menerima pembayaran');
    const kind = oneOf(d.kind, ['dp', 'pelunasan'], 'Jenis pembayaran');
    const method = oneOf(d.method, METHODS, 'Metode pembayaran');
    const amount = int(d.amount, 'Jumlah pembayaran', { min: 1 });
    const paid_at = reqDate(d.paid_at, 'Tanggal pembayaran');
    const note = optStr(d.note, 'Catatan pembayaran', 200);
    const cur = hydrate(row, 'admin').totals;
    if (amount > cur.remaining) throw new HttpError(409, `Pembayaran melebihi sisa tagihan (sisa Rp ${cur.remaining.toLocaleString('id-ID')})`);
    if (kind === 'pelunasan' && amount !== cur.remaining) {
      throw new HttpError(409, `Pelunasan harus sebesar sisa tagihan (Rp ${cur.remaining.toLocaleString('id-ID')}). Untuk cicilan, pilih jenis "Uang muka".`);
    }
    db.prepare('INSERT INTO payments (order_id, kind, amount, method, paid_at, note, created_by) VALUES (?,?,?,?,?,?,?)')
      .run(id, kind, amount, method, paid_at, note, user.id);
    return hydrate(loadRow(id), 'admin', true);
  });
}

export function saveLocation(id, d, user) {
  return tx(() => {
    const row = loadRow(id);
    assertCourierAccess(row, user);
    if (CLOSED.includes(row.status)) throw new HttpError(409, 'Pesanan sudah ditutup');
    const [lat, lng] = coords(d.lat, d.lng);
    const source = oneOf(d.source, ['manual', 'gps', 'gps-berkala'], 'Sumber lokasi');
    const at = nowIso();
    const address = d.address !== undefined ? optStr(d.address, 'Alamat pengantaran', 300) : row.address;
    const notes = d.courier_notes !== undefined ? optStr(d.courier_notes, 'Catatan pengantar', 500) : row.courier_notes;
    db.prepare(`UPDATE orders SET lat=?, lng=?, location_source=?, location_updated_at=?, address=?, courier_notes=?, updated_at=? WHERE id=?`)
      .run(lat, lng, source, at, address, notes, at, id);
    db.prepare('INSERT INTO location_log (order_id, lat, lng, source, by_user, at) VALUES (?,?,?,?,?,?)')
      .run(id, lat, lng, source, user.id, at);
    return hydrate(loadRow(id), user.role, true);
  });
}

export function saveCourierNotes(id, d, user) {
  const row = loadRow(id);
  assertCourierAccess(row, user);
  const notes = optStr(d.courier_notes, 'Catatan pengantar', 500);
  const damage = d.damage_notes !== undefined ? optStr(d.damage_notes, 'Catatan kerusakan/kehilangan', 1000) : row.damage_notes;
  db.prepare('UPDATE orders SET courier_notes=?, damage_notes=?, updated_at=? WHERE id=?').run(notes, damage, nowIso(), id);
  return hydrate(loadRow(id), user.role, true);
}

export function mapOrders(q) {
  const rows = db.prepare(`${ORDER_SQL} WHERE o.lat IS NOT NULL AND o.status != 'Dibatalkan'
    ${q.all === '1' ? '' : "AND o.status != 'Selesai'"} ORDER BY o.location_updated_at DESC`).all();
  return rows.map((r) => {
    const h = hydrate(r, 'admin');
    return {
      id: h.id, code: h.code, status: h.status, customer_name: h.customer_name, address: h.address,
      lat: h.lat, lng: h.lng, location_source: h.location_source, location_updated_at: h.location_updated_at,
      courier_name: h.courier_name, overdue: h.overdue, remaining: h.totals.remaining, is_sample: h.is_sample,
    };
  });
}

export function dashboard() {
  const stock = stockList();
  const rows = db.prepare(`${ORDER_SQL} WHERE o.status != 'Dibatalkan' ORDER BY o.due_date`).all();
  const orders = rows.map((r) => hydrate(r, 'admin'));
  const active = orders.filter((o) => !CLOSED.includes(o.status));
  const unpaid = orders.filter((o) => o.totals.remaining > 0);
  const t = today();
  const soon = addDays(t, 2);
  const dueSoon = active
    .filter((o) => ACTIVE_RENTAL.includes(o.status) && o.due_date <= soon)
    .map((o) => ({ id: o.id, code: o.code, customer_name: o.customer_name, status: o.status, due_date: o.due_date, overdue: o.due_date < t }));
  return {
    today: t,
    active_orders: active.length,
    waiting_confirm: active.filter((o) => o.status === 'Menunggu Konfirmasi').length,
    ready_to_send: active.filter((o) => o.status === 'Siap Dikirim').length,
    units_rented: stock.reduce((s, x) => s + x.rented, 0),
    units_available: stock.reduce((s, x) => s + Math.max(0, x.available), 0),
    unpaid_count: unpaid.length,
    unpaid_amount: unpaid.reduce((s, o) => s + o.totals.remaining, 0),
    due_soon: dueSoon,
    no_location: active.filter((o) => o.lat === null && ['Siap Dikirim', 'Dalam Pengiriman', 'Sedang Disewa'].includes(o.status)).length,
    stock,
  };
}

/* ---------------------------- PELANGGAN --------------------------- */

export function listCustomers(q) {
  const like = `%${String(q.q || '').slice(0, 100)}%`;
  return db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count
    FROM customers c WHERE c.name LIKE ? OR c.phone LIKE ? ORDER BY c.name LIMIT 300`).all(like, like);
}

function parseCustomer(d) {
  return {
    name: reqStr(d.name, 'Nama pelanggan', { max: 120 }),
    phone: validPhone(d.phone),
    address: optStr(d.address, 'Alamat', 300),
    notes: optStr(d.notes, 'Catatan', 500),
  };
}

export function createCustomer(d) {
  const c = parseCustomer(d);
  const r = db.prepare('INSERT INTO customers (name, phone, address, notes) VALUES (?,?,?,?)').run(c.name, c.phone, c.address, c.notes);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(r.lastInsertRowid));
}

export function updateCustomer(id, d) {
  const c = parseCustomer(d);
  const r = db.prepare('UPDATE customers SET name=?, phone=?, address=?, notes=? WHERE id=?').run(c.name, c.phone, c.address, c.notes, id);
  if (!r.changes) throw new HttpError(404, 'Pelanggan tidak ditemukan');
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

export function customerDetail(id) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'Pelanggan tidak ditemukan');
  const orders = db.prepare(`${ORDER_SQL} WHERE o.customer_id = ? ORDER BY o.start_date DESC`).all(id)
    .map((r) => hydrate(r, 'admin'))
    .map((o) => ({ id: o.id, code: o.code, status: o.status, start_date: o.start_date, due_date: o.due_date, total: o.totals.total, remaining: o.totals.remaining, damage_notes: o.damage_notes }));
  return { ...c, orders };
}

export function deleteCustomer(id) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?').get(id).n;
  if (n > 0) throw new HttpError(409, 'Pelanggan memiliki riwayat pesanan dan tidak dapat dihapus');
  const r = db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  if (!r.changes) throw new HttpError(404, 'Pelanggan tidak ditemukan');
}

/* ------------------------ JENIS SCAFFOLDING ----------------------- */

function parseType(d) {
  return {
    name: reqStr(d.name, 'Nama jenis', { max: 80 }),
    description: optStr(d.description, 'Deskripsi', 200),
    unit: oneOf(d.unit, ['day', 'week'], 'Satuan harga'),
    price: int(d.price, 'Harga sewa'),
    stock_total: int(d.stock_total, 'Total stok', { max: 1000000 }),
    active: d.active === false || d.active === 0 ? 0 : 1,
  };
}

export function createType(d) {
  const t = parseType(d);
  try {
    const r = db.prepare('INSERT INTO scaffold_types (name, description, unit, price, stock_total, active) VALUES (?,?,?,?,?,?)')
      .run(t.name, t.description, t.unit, t.price, t.stock_total, t.active);
    return stockList().find((s) => s.id === Number(r.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Nama jenis sudah ada');
    throw e;
  }
}

export function updateType(id, d) {
  const t = parseType(d);
  const cur = stockList().find((s) => s.id === id);
  if (!cur) throw new HttpError(404, 'Jenis tidak ditemukan');
  if (t.stock_total < cur.reserved) {
    throw new HttpError(409, `Total stok tidak boleh di bawah jumlah yang sedang dipakai pesanan aktif (${cur.reserved})`);
  }
  try {
    db.prepare('UPDATE scaffold_types SET name=?, description=?, unit=?, price=?, stock_total=?, active=? WHERE id=?')
      .run(t.name, t.description, t.unit, t.price, t.stock_total, t.active, id);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Nama jenis sudah ada');
    throw e;
  }
  return stockList().find((s) => s.id === id);
}

/* ----------------------------- PENGGUNA --------------------------- */

export function listUsers() {
  return db.prepare('SELECT id, username, name, role, active, is_sample FROM users ORDER BY role, name').all();
}

export function createUser(d, { sample = 0 } = {}) {
  const username = reqStr(d.username, 'Username', { min: 3, max: 32 });
  if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw new HttpError(400, 'Username hanya boleh huruf, angka, titik, strip, dan garis bawah');
  const name = reqStr(d.name, 'Nama', { max: 80 });
  const role = oneOf(d.role, ['admin', 'courier'], 'Peran');
  checkPasswordPolicy(d.password);
  try {
    const r = db.prepare('INSERT INTO users (username, name, role, password_hash, is_sample) VALUES (?,?,?,?,?)')
      .run(username, name, role, hashPassword(d.password), sample);
    return { id: Number(r.lastInsertRowid), username, name, role, active: 1 };
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Username sudah dipakai');
    throw e;
  }
}

export function updateUser(id, d, me) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, 'Pengguna tidak ditemukan');
  const name = d.name !== undefined ? reqStr(d.name, 'Nama', { max: 80 }) : u.name;
  const active = d.active === undefined ? u.active : (d.active ? 1 : 0);
  if (id === me.id && !active) throw new HttpError(400, 'Anda tidak dapat menonaktifkan akun sendiri');
  db.prepare('UPDATE users SET name=?, active=? WHERE id=?').run(name, active, id);
  if (d.password) {
    checkPasswordPolicy(d.password);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(d.password), id);
    destroyUserSessions(id);
  }
  if (!active) destroyUserSessions(id);
  return db.prepare('SELECT id, username, name, role, active FROM users WHERE id = ?').get(id);
}
