import { computeTotals, STATUSES, CLOSED } from './calc.js';
import {
  h, clear, api, state, rp, fmtDate, fmtDT, ago, unitLabel, badge, sampleTag, toast, run,
  loading, empty, field, openDialog, runLeave, SOURCE_LABEL,
} from './ui.js';
import { makeMap, pinIcon, lastSavedText, locationPicker } from './maps.js';

const app = document.getElementById('app');
let main = null;
let nav = null;
let routeSeq = 0;

/* ====================================================================
   LOGIN & SHELL
   ==================================================================== */
function renderLogin() {
  runLeave();
  document.body.classList.remove('courier');
  const err = h('p', { class: 'err-text', role: 'alert' });
  const u = h('input', { type: 'text', autocomplete: 'username', required: true, autocapitalize: 'none' });
  const p = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Masuk');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        const r = await api('/login', { method: 'POST', body: { username: u.value.trim(), password: p.value } });
        state.me = r.user;
        renderShell();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  }, field('Username', u), field('Kata sandi', p), err, btn);
  app.replaceChildren(h('div', { class: 'login' },
    h('h1', null, 'Sewa Scaffolding'),
    h('div', { class: 'card' }, form),
    state.config.demo ? h('p', { class: 'hint' }, 'Mode demo (data contoh): akun admin, budi, atau agus — kata sandi demo1234.') : null));
  u.focus();
}

function changePasswordDialog() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan');
  let dlg;
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const r = await run(btn, () => api('/me/password', { method: 'POST', body: { current: cur.value, password: nw.value } }), 'Kata sandi diganti');
      if (r) dlg.close();
    },
  }, field('Kata sandi saat ini', cur), field('Kata sandi baru', nw, 'Minimal 8 karakter'), btn);
  dlg = openDialog('Ganti kata sandi', form);
}

function renderShell() {
  const isAdmin = state.me.role === 'admin';
  document.body.classList.toggle('courier', !isAdmin);
  const links = isAdmin
    ? [['#/dashboard', 'Dashboard'], ['#/orders', 'Pesanan'], ['#/map', 'Peta'], ['#/customers', 'Pelanggan'], ['#/catalog', 'Stok & Harga'], ['#/users', 'Pengguna']]
    : [['#/tasks', 'Tugas Saya']];
  nav = h('nav', { class: 'nav' }, links.map(([href, t]) => h('a', { href, 'data-href': href }, t)));
  main = h('main', { id: 'main' });
  const logout = h('button', { class: 'btn sm', type: 'button', onclick: async () => {
    try { await api('/logout', { method: 'POST', body: {} }); } catch { /* abaikan */ }
    state.me = null; renderLogin();
  } }, 'Keluar');
  const top = h('header', { class: 'topbar' }, h('div', { class: 'topbar-in' },
    h('span', { class: 'brand' }, 'SEWA SCAFFOLDING'), nav,
    h('div', { class: 'userbox' }, h('span', null, state.me.name),
      h('button', { class: 'btn sm', type: 'button', onclick: changePasswordDialog }, 'Sandi'), logout)));
  app.replaceChildren(
    state.config.demo ? h('div', { class: 'demo-banner' }, 'MODE DEMO — seluruh data berlabel “CONTOH” adalah data contoh, bukan data nyata.') : null,
    top, main);
  const home = isAdmin ? '#/dashboard' : '#/tasks';
  if (!location.hash || location.hash === '#/') location.hash = home; else router();
}

/* ====================================================================
   ROUTER
   ==================================================================== */
const adminRoutes = [
  [/^#\/dashboard$/, pgDashboard],
  [/^#\/orders$/, pgOrders],
  [/^#\/orders\/new$/, () => pgOrderForm(null)],
  [/^#\/orders\/(\d+)\/edit$/, pgOrderForm],
  [/^#\/orders\/(\d+)$/, pgOrderDetail],
  [/^#\/map$/, pgMap],
  [/^#\/customers$/, pgCustomers],
  [/^#\/catalog$/, pgCatalog],
  [/^#\/users$/, pgUsers],
];
const courierRoutes = [
  [/^#\/tasks$/, pgTasks],
  [/^#\/tasks\/(\d+)$/, pgTask],
];

async function router() {
  if (!state.me || !main) return;
  runLeave();
  const my = ++routeSeq;
  const hash = location.hash || '#/';
  const table = state.me.role === 'admin' ? adminRoutes : courierRoutes;
  for (const [re, fn] of table) {
    const m = hash.match(re);
    if (!m) continue;
    for (const a of nav.querySelectorAll('a')) a.classList.toggle('on', hash.startsWith(a.dataset.href));
    clear(main).append(loading());
    let el;
    try { el = await fn(...m.slice(1)); } catch (e) { el = h('div', { class: 'alert' }, e.message); }
    if (my !== routeSeq) return; // pengguna sudah pindah halaman
    clear(main).append(el);
    window.scrollTo(0, 0);
    return;
  }
  location.hash = state.me.role === 'admin' ? '#/dashboard' : '#/tasks';
}
window.addEventListener('hashchange', router);

/* ====================================================================
   KOMPONEN BERSAMA
   ==================================================================== */
const pageHead = (title, ...actions) => h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'btn-row' }, ...actions));
const stat = (value, label, sub, bad) => h('div', { class: `stat${bad ? ' bad' : ''}` }, h('div', { class: 'n' }, value), h('div', { class: 'l' }, label), sub ? h('div', { class: 'hint' }, sub) : null);
const numInput = (value, attrs = {}) => h('input', { type: 'number', min: 0, step: 1, inputmode: 'numeric', value: value ?? 0, ...attrs });
const itemsText = (items) => items.map((i) => `${i.qty}× ${i.name}`).join(', ');

function orderCard(o) {
  const courierView = !o.totals;
  return h('a', { class: 'ocard', href: courierView ? `#/tasks/${o.id}` : `#/orders/${o.id}` },
    h('div', { class: 'top' }, h('div', null, h('span', { class: 'code' }, o.code), sampleTag(o)), badge(o.status)),
    h('div', null, h('strong', null, o.customer_name)),
    h('div', { class: 'meta' }, `${fmtDate(o.start_date)} → ${fmtDate(o.due_date)}`, o.overdue ? h('span', { class: 'late' }, ' · TERLAMBAT') : null),
    h('div', { class: 'meta' }, o.address || o.customer_address || ''),
    courierView ? h('div', { class: 'meta' }, itemsText(o.items)) : null,
    h('div', { class: 'meta' }, o.lat != null ? `📍 Lokasi tersimpan (${ago(o.location_updated_at)})` : '📍 Belum ada lokasi'),
    courierView ? null : h('div', { class: 'money' }, h('span', null, `Total ${rp(o.totals.total)}`),
      h('span', { class: o.totals.remaining > 0 && o.status !== 'Dibatalkan' ? 'late' : 'muted' }, o.totals.remaining > 0 ? `Sisa ${rp(o.totals.remaining)}` : 'Lunas')));
}

/* ====================================================================
   ADMIN: DASHBOARD
   ==================================================================== */
async function pgDashboard() {
  const d = await api('/dashboard');
  const root = h('div');
  root.append(pageHead('Dashboard', h('a', { class: 'btn primary', href: '#/orders/new' }, '+ Pesanan baru')));
  if (d.no_location > 0) root.append(h('div', { class: 'alert soft' }, `${d.no_location} pesanan yang sedang berjalan belum memiliki lokasi proyek. Minta pengantar mengisinya.`));
  root.append(h('div', { class: 'grid c4' },
    stat(d.active_orders, 'Pesanan aktif', `${d.waiting_confirm} menunggu konfirmasi · ${d.ready_to_send} siap dikirim`),
    stat(d.units_rented, 'Unit scaffolding sedang disewa'),
    stat(d.units_available, 'Unit stok tersedia'),
    stat(rp(d.unpaid_amount), 'Tagihan belum lunas', `${d.unpaid_count} pesanan`, d.unpaid_amount > 0)));

  const due = h('div', { class: 'card' }, h('h2', null, 'Pengembalian mendekati jatuh tempo (≤ 2 hari)'));
  if (!d.due_soon.length) due.append(h('p', { class: 'muted' }, 'Tidak ada pengembalian yang mendekati jatuh tempo.'));
  else {
    due.append(h('div', { class: 'tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Pesanan', 'Pelanggan', 'Status', 'Jatuh tempo'].map((t) => h('th', null, t)))),
      h('tbody', null, d.due_soon.map((o) => h('tr', null,
        h('td', null, h('a', { href: `#/orders/${o.id}` }, o.code)), h('td', null, o.customer_name), h('td', null, badge(o.status)),
        h('td', { class: o.overdue ? 'late' : '' }, fmtDate(o.due_date), o.overdue ? ' — terlambat' : '')))))));
  }
  const stock = h('div', { class: 'card' }, h('h2', null, 'Stok per jenis'),
    h('div', { class: 'tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Jenis', 'Tersedia', '', 'Disewa'].map((t) => h('th', null, t)))),
      h('tbody', null, d.stock.map((s) => h('tr', null,
        h('td', null, s.name, s.is_sample ? sampleTag(s) : null),
        h('td', { class: 'num' }, `${s.available} / ${s.stock_total}`),
        h('td', null, h('progress', { value: Math.max(0, s.available), max: Math.max(1, s.stock_total), 'aria-label': `Stok ${s.name}` })),
        h('td', { class: 'num' }, s.rented)))))));
  root.append(due, stock);
  return root;
}

/* ====================================================================
   ADMIN: DAFTAR PESANAN
   ==================================================================== */
const orderFilters = { q: '', status: '', from: '', to: '', place: '', loc: '' };

async function pgOrders() {
  const list = h('div');
  async function load() {
    clear(list).append(loading());
    const qs = new URLSearchParams(Object.entries(orderFilters).filter(([, v]) => v));
    try {
      const rows = await api('/orders?' + qs);
      clear(list);
      if (!rows.length) list.append(empty('Tidak ada pesanan yang cocok dengan filter.', h('a', { class: 'btn primary', href: '#/orders/new' }, 'Buat pesanan')));
      else list.append(h('div', { class: 'orders' }, rows.map(orderCard)));
    } catch (e) { clear(list).append(h('div', { class: 'alert' }, e.message)); }
  }
  let timer;
  const bind = (key, el, debounce) => {
    el.addEventListener(debounce ? 'input' : 'change', () => {
      orderFilters[key] = el.value;
      clearTimeout(timer);
      timer = setTimeout(load, debounce ? 300 : 0);
    });
    return el;
  };
  const filters = h('div', { class: 'card filters' },
    field('Cari pelanggan / kode / telepon', bind('q', h('input', { type: 'search', value: orderFilters.q, placeholder: 'mis. Budi atau SW-2026-0001' }), true)),
    field('Status', bind('status', h('select', { value: orderFilters.status }, h('option', { value: '' }, 'Semua status'), STATUSES.map((s) => h('option', { value: s }, s))))),
    field('Mulai sewa dari', bind('from', h('input', { type: 'date', value: orderFilters.from }))),
    field('Mulai sewa sampai', bind('to', h('input', { type: 'date', value: orderFilters.to }))),
    field('Lokasi / alamat', bind('place', h('input', { type: 'search', value: orderFilters.place, placeholder: 'mis. Gombong' }), true)),
    field('Pin lokasi', bind('loc', h('select', { value: orderFilters.loc }, h('option', { value: '' }, 'Semua'), h('option', { value: 'yes' }, 'Sudah ada pin'), h('option', { value: 'no' }, 'Belum ada pin')))));
  const root = h('div', null, pageHead('Pesanan', h('a', { class: 'btn primary', href: '#/orders/new' }, '+ Pesanan baru')), filters, list);
  load();
  return root;
}

/* ====================================================================
   ADMIN: FORM PESANAN (BUAT / UBAH)
   ==================================================================== */
async function pgOrderForm(id) {
  const [o, allTypes, customers, users] = await Promise.all([
    id ? api('/orders/' + id) : null, api('/types'), api('/customers'), api('/users')]);
  if (o && CLOSED.includes(o.status)) throw new Error('Pesanan yang sudah selesai/dibatalkan tidak dapat diubah.');
  const types = allTypes.filter((t) => t.active || (o && o.items.some((i) => i.type_id === t.id)));
  const couriers = users.filter((u) => u.role === 'courier' && u.active);
  const mine = (tid) => (o ? o.items.find((i) => i.type_id === tid) : null);
  const avail = (t) => t.available + (mine(t.id)?.qty || 0);
  let items = o ? o.items.map((i) => ({ type_id: String(i.type_id), qty: i.qty })) : [{ type_id: '', qty: 1 }];

  const customer = h('select', { disabled: !!o },
    h('option', { value: '' }, '— Pilih pelanggan —'),
    customers.map((c) => h('option', { value: c.id }, `${c.name} · ${c.phone}`)),
    h('option', { value: '__new' }, '+ Pelanggan baru…'));
  customer.value = o ? String(o.customer_id) : '';
  const nName = h('input', { type: 'text', maxlength: 120, placeholder: 'Nama pelanggan' });
  const nPhone = h('input', { type: 'tel', maxlength: 20, placeholder: 'Nomor telepon' });
  const nAddr = h('input', { type: 'text', maxlength: 300, placeholder: 'Alamat pelanggan' });
  const newBox = h('div', { class: 'card' }, h('h3', null, 'Pelanggan baru'), field('Nama', nName), field('Telepon', nPhone), field('Alamat', nAddr));
  newBox.hidden = true;
  customer.addEventListener('change', () => { newBox.hidden = customer.value !== '__new'; });

  const start = h('input', { type: 'date', required: true, value: o ? o.start_date : state.config.today });
  const due = h('input', { type: 'date', required: true, value: o ? o.due_date : state.config.today });
  if (!o) { const d = new Date(state.config.today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); due.value = d.toISOString().slice(0, 10); }
  const address = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Alamat pengantaran (kosongkan untuk memakai alamat pelanggan)' }, o ? o.address : '');
  const notes = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Catatan proyek' }, o ? o.project_notes : '');
  const courier = h('select', null, h('option', { value: '' }, '— Belum ditugaskan —'), couriers.map((c) => h('option', { value: c.id }, c.name)));
  courier.value = o && o.courier_id ? String(o.courier_id) : '';
  const delivery = numInput(o?.delivery_fee);
  const other = numInput(o?.other_fee);
  const otherLabel = h('input', { type: 'text', maxlength: 100, placeholder: 'Keterangan (mis. pemasangan)', value: o?.other_fee_label || '' });
  const discount = numInput(o?.discount);

  const itemsBox = h('div');
  const summary = h('div', { class: 'card' });

  function refreshSummary() {
    clear(summary).append(h('h2', null, 'Ringkasan biaya'));
    if (!start.value || !due.value || due.value < start.value) {
      summary.append(h('p', { class: 'warn' }, 'Periksa tanggal: perkiraan selesai tidak boleh sebelum tanggal mulai.'));
      return;
    }
    const calcItems = items.filter((i) => i.type_id && Number(i.qty) > 0).map((i) => {
      const t = types.find((x) => String(x.id) === String(i.type_id));
      const snap = mine(Number(i.type_id));
      return { name: t.name, qty: Number(i.qty), unit_price: snap ? snap.unit_price : t.price, unit: snap ? snap.unit : t.unit };
    });
    const t = computeTotals({
      start_date: start.value, due_date: due.value, return_date: o?.return_date || null,
      delivery_fee: Number(delivery.value) || 0, other_fee: Number(other.value) || 0, discount: Number(discount.value) || 0,
      items: calcItems, paid: o ? o.totals.paid : 0,
    });
    summary.append(
      h('p', { class: 'hint' }, `Lama sewa: ${t.days} hari${t.lines.some((l) => l.unit === 'week') ? ` (${t.weeks} minggu untuk harga mingguan)` : ''}`),
      t.lines.length ? h('div', { class: 'tbl-wrap' }, h('table', null, h('tbody', null, t.lines.map((l) => h('tr', null,
        h('td', null, `${l.qty} × ${l.name}`), h('td', { class: 'muted' }, `${rp(l.unit_price)} × ${l.periods} ${unitLabel(l.unit)}`), h('td', { class: 'num' }, rp(l.line_total))))))) : h('p', { class: 'muted' }, 'Belum ada barang.'),
      h('div', { class: 'sum' },
        h('div', { class: 'r' }, h('span', null, 'Subtotal'), h('span', null, rp(t.subtotal))),
        h('div', { class: 'r' }, h('span', null, 'Ongkos kirim'), h('span', null, rp(t.delivery_fee))),
        h('div', { class: 'r' }, h('span', null, otherLabel.value || 'Biaya tambahan'), h('span', null, rp(t.other_fee))),
        h('div', { class: 'r' }, h('span', null, 'Diskon'), h('span', null, `− ${rp(t.discount)}`)),
        h('div', { class: 'r big' }, h('span', null, 'Total akhir'), h('span', null, rp(t.total))),
        o ? h('div', { class: 'r' }, h('span', null, 'Sudah dibayar'), h('span', null, rp(t.paid))) : null,
        o ? h('div', { class: 'r due' }, h('span', null, 'Sisa tagihan'), h('span', null, rp(t.remaining))) : null));
  }

  function renderItems() {
    clear(itemsBox);
    items.forEach((it, idx) => {
      const sel = h('select', { 'aria-label': 'Jenis barang' }, h('option', { value: '' }, '— Pilih jenis —'),
        types.map((t) => h('option', { value: t.id }, `${t.name} — ${rp(t.price)}/${unitLabel(t.unit)} (tersedia ${avail(t)})`)));
      sel.value = it.type_id;
      sel.addEventListener('change', () => { it.type_id = sel.value; refreshSummary(); });
      const qty = h('input', { type: 'number', min: 1, step: 1, inputmode: 'numeric', value: it.qty, 'aria-label': 'Jumlah' });
      qty.addEventListener('input', () => { it.qty = qty.value; refreshSummary(); });
      const rm = h('button', { type: 'button', class: 'btn danger sm', 'aria-label': 'Hapus baris', onclick: () => { items.splice(idx, 1); if (!items.length) items.push({ type_id: '', qty: 1 }); renderItems(); refreshSummary(); } }, '✕');
      itemsBox.append(h('div', { class: 'item-row' }, sel, qty, rm));
    });
  }
  for (const el of [start, due, delivery, other, discount, otherLabel]) el.addEventListener('input', refreshSummary);

  const submit = h('button', { class: 'btn primary', type: 'submit' }, o ? 'Simpan perubahan' : 'Buat pesanan');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const body = {
        start_date: start.value, due_date: due.value, address: address.value, project_notes: notes.value,
        courier_id: courier.value || null, delivery_fee: Number(delivery.value) || 0, other_fee: Number(other.value) || 0,
        other_fee_label: otherLabel.value, discount: Number(discount.value) || 0,
        items: items.filter((i) => i.type_id).map((i) => ({ type_id: Number(i.type_id), qty: Number(i.qty) })),
      };
      if (!o) {
        if (customer.value === '__new') body.new_customer = { name: nName.value, phone: nPhone.value, address: nAddr.value };
        else if (customer.value) body.customer_id = Number(customer.value);
        else { toast('Pilih pelanggan atau isi pelanggan baru', 'err'); return; }
      }
      const r = await run(submit, () => api(o ? `/orders/${id}` : '/orders', { method: o ? 'PUT' : 'POST', body }), o ? 'Pesanan diperbarui' : 'Pesanan dibuat');
      if (r) location.hash = `#/orders/${r.id}`;
    },
  },
  h('div', { class: 'card' }, h('h2', null, 'Pelanggan'), field('Pelanggan', customer, o ? 'Pelanggan tidak dapat diganti setelah pesanan dibuat.' : null), newBox),
  h('div', { class: 'card' }, h('h2', null, 'Jadwal & pengantaran'),
    h('div', { class: 'row2' }, field('Tanggal mulai sewa', start), field('Perkiraan tanggal selesai', due)),
    field('Alamat pengantaran', address), field('Catatan proyek', notes), field('Pengantar', courier)),
  h('div', { class: 'card' }, h('h2', null, 'Barang yang disewa'), itemsBox,
    h('button', { type: 'button', class: 'btn sm', onclick: () => { items.push({ type_id: '', qty: 1 }); renderItems(); } }, '+ Tambah barang'),
    h('p', { class: 'hint' }, 'Stok tersedia dihitung dari pesanan aktif. Jumlah yang melebihi stok akan ditolak.')),
  h('div', { class: 'card' }, h('h2', null, 'Biaya tambahan & diskon'),
    h('div', { class: 'row3' }, field('Ongkos kirim (Rp)', delivery), field('Biaya tambahan (Rp)', other), field('Diskon (Rp)', discount)),
    field('Keterangan biaya tambahan', otherLabel)),
  summary,
  h('div', { class: 'btn-row' }, submit, h('a', { class: 'btn', href: o ? `#/orders/${id}` : '#/orders' }, 'Batal')));

  renderItems();
  refreshSummary();
  return h('div', null, pageHead(o ? `Ubah ${o.code}` : 'Pesanan baru'), form);
}

/* ====================================================================
   ADMIN: DETAIL PESANAN
   ==================================================================== */
const NEXT = {
  'Menunggu Konfirmasi': 'Siap Dikirim', 'Siap Dikirim': 'Dalam Pengiriman', 'Dalam Pengiriman': 'Sedang Disewa',
  'Sedang Disewa': 'Menunggu Penjemputan', 'Menunggu Penjemputan': 'Selesai',
};

async function pgOrderDetail(id) {
  const o = await api('/orders/' + id);
  const t = o.totals;
  const closed = CLOSED.includes(o.status);
  const root = h('div');
  root.append(pageHead(h('span', null, o.code, sampleTag(o)),
    h('a', { class: 'btn', href: '#/orders' }, '← Daftar'),
    closed ? null : h('a', { class: 'btn', href: `#/orders/${o.id}/edit` }, 'Ubah pesanan')));
  root.append(h('p', null, badge(o.status)));
  if (o.overdue) root.append(h('div', { class: 'alert' }, `Terlambat: perkiraan selesai ${fmtDate(o.due_date)} sudah lewat dan barang belum dikembalikan. Biaya dihitung hingga tanggal pengembalian aktual.`));

  const info = h('div', { class: 'card' }, h('h2', null, 'Pelanggan & proyek'),
    h('p', null, h('strong', null, o.customer_name)),
    h('p', null, '📞 ', h('a', { href: `tel:${o.customer_phone.replace(/[^+\d]/g, '')}` }, o.customer_phone)),
    h('p', { class: 'muted' }, 'Alamat pelanggan: ', o.customer_address || '—'),
    h('p', null, 'Alamat pengantaran: ', o.address || '—'),
    h('p', null, 'Catatan proyek: ', o.project_notes || '—'),
    h('p', null, 'Pengantar: ', o.courier_name || 'Belum ditugaskan'),
    h('hr'),
    h('p', null, 'Mulai sewa: ', h('strong', null, fmtDate(o.start_date))),
    h('p', null, 'Perkiraan selesai: ', h('strong', null, fmtDate(o.due_date))),
    h('p', null, 'Pengembalian aktual: ', h('strong', null, fmtDate(o.return_date))),
    h('p', null, `Lama sewa dihitung: ${t.days} hari`),
    o.courier_notes ? h('p', null, 'Catatan pengantar: ', o.courier_notes) : null,
    o.damage_notes ? h('p', { class: 'late' }, 'Kerusakan/kehilangan: ', o.damage_notes) : null);

  const bill = h('div', { class: 'card' }, h('h2', null, 'Ringkasan biaya'),
    h('div', { class: 'tbl-wrap' }, h('table', null, h('tbody', null, t.lines.map((l) => h('tr', null,
      h('td', null, `${l.qty} × ${l.name}`), h('td', { class: 'muted' }, `${rp(l.unit_price)} × ${l.periods} ${unitLabel(l.unit)}`), h('td', { class: 'num' }, rp(l.line_total))))))),
    h('div', { class: 'sum' },
      h('div', { class: 'r' }, h('span', null, 'Subtotal'), h('span', null, rp(t.subtotal))),
      h('div', { class: 'r' }, h('span', null, 'Ongkos kirim'), h('span', null, rp(t.delivery_fee))),
      h('div', { class: 'r' }, h('span', null, o.other_fee_label || 'Biaya tambahan'), h('span', null, rp(t.other_fee))),
      h('div', { class: 'r' }, h('span', null, 'Diskon'), h('span', null, `− ${rp(t.discount)}`)),
      h('div', { class: 'r big' }, h('span', null, 'Total akhir'), h('span', null, rp(t.total))),
      h('div', { class: 'r' }, h('span', null, 'Sudah dibayar'), h('span', null, rp(t.paid))),
      h('div', { class: `r ${t.remaining > 0 ? 'due' : ''}` }, h('span', null, 'Sisa tagihan'), h('span', null, t.remaining > 0 ? rp(t.remaining) : 'LUNAS'))));
  root.append(h('div', { class: 'grid c2' }, info, bill));

  /* --- Status --- */
  const sel = h('select', null, STATUSES.filter((s) => s !== o.status).map((s) => h('option', { value: s }, s)));
  const note = h('input', { type: 'text', maxlength: 300, placeholder: 'Catatan perubahan (opsional)' });
  const ret = h('input', { type: 'date', value: state.config.today });
  const dmg = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Catatan kerusakan/kehilangan (opsional)' }, o.damage_notes || '');
  const extra = h('div');
  const syncExtra = () => { clear(extra); if (sel.value === 'Selesai') extra.append(field('Tanggal pengembalian aktual', ret), field('Catatan kerusakan/kehilangan', dmg)); };
  sel.addEventListener('change', syncExtra);
  async function change(btn, st) {
    if (st === 'Dibatalkan' && !confirm('Batalkan pesanan ini? Stok akan dikembalikan.')) return;
    const body = { status: st, note: note.value };
    if (st === 'Selesai') { body.return_date = ret.value; body.damage_notes = dmg.value; }
    const r = await run(btn, () => api(`/orders/${o.id}/status`, { method: 'POST', body }), 'Status diperbarui');
    if (r) router();
  }
  const applyBtn = h('button', { class: 'btn', type: 'button', onclick: () => change(applyBtn, sel.value) }, 'Ubah status');
  const nextSt = NEXT[o.status];
  const quick = nextSt ? h('button', { class: 'btn primary', type: 'button', onclick: () => {
    if (nextSt === 'Selesai') { sel.value = 'Selesai'; syncExtra(); ret.focus(); toast('Isi tanggal pengembalian lalu tekan “Ubah status”'); } else change(quick, nextSt);
  } }, `Lanjut: ${nextSt}`) : null;
  root.append(h('div', { class: 'card' }, h('h2', null, 'Status pesanan'),
    h('div', { class: 'btn-row' }, quick),
    h('div', { class: 'row2' }, field('Ubah ke status', sel), field('Catatan', note)), extra, applyBtn));

  /* --- Pembayaran --- */
  const pay = h('div', { class: 'card' }, h('h2', null, 'Pembayaran'));
  if (!o.payments.length) pay.append(h('p', { class: 'muted' }, 'Belum ada pembayaran tercatat.'));
  else pay.append(h('div', { class: 'tbl-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['Tanggal', 'Jenis', 'Metode', 'Catatan', 'Jumlah'].map((x, i) => h('th', { class: i === 4 ? 'num' : '' }, x)))),
    h('tbody', null, o.payments.map((p) => h('tr', null, h('td', null, fmtDate(p.paid_at)), h('td', null, p.kind === 'dp' ? 'Uang muka' : 'Pelunasan'),
      h('td', null, p.method), h('td', null, p.note || ''), h('td', { class: 'num' }, rp(p.amount))))))));
  if (o.status !== 'Dibatalkan' && t.remaining > 0) {
    const kind = h('select', null, h('option', { value: 'dp' }, 'Uang muka / cicilan'), h('option', { value: 'pelunasan' }, 'Pelunasan'));
    const amount = numInput('', { min: 1, placeholder: 'Jumlah (Rp)' });
    const method = h('select', null, ['tunai', 'transfer', 'qris', 'lainnya'].map((m) => h('option', { value: m }, m.toUpperCase())));
    const date = h('input', { type: 'date', value: state.config.today });
    const pnote = h('input', { type: 'text', maxlength: 200, placeholder: 'Catatan (opsional)' });
    kind.addEventListener('change', () => { if (kind.value === 'pelunasan') amount.value = t.remaining; });
    const add = h('button', { class: 'btn primary', type: 'submit' }, 'Catat pembayaran');
    pay.append(h('h3', null, 'Catat pembayaran baru'), h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const r = await run(add, () => api(`/orders/${o.id}/payments`, { method: 'POST', body: { kind: kind.value, amount: Number(amount.value), method: method.value, paid_at: date.value, note: pnote.value } }), 'Pembayaran dicatat');
        if (r) router();
      },
    }, h('div', { class: 'row3' }, field('Jenis', kind), field('Jumlah (Rp)', amount), field('Metode', method), field('Tanggal', date)), field('Catatan', pnote), add));
  }
  root.append(pay);

  /* --- Lokasi --- */
  root.append(h('div', { class: 'card' }, h('h2', null, 'Lokasi proyek'), locationPicker(o, { periodic: false })));

  /* --- Riwayat --- */
  root.append(h('div', { class: 'card' }, h('h2', null, 'Riwayat status'), h('ul', { class: 'timeline' },
    [...o.history].reverse().map((x) => h('li', null, badge(x.status), ' ', h('span', { class: 'muted' }, `${fmtDT(x.at)} · ${x.by_name || '—'}`), x.note ? h('div', null, x.note) : null)))));
  return root;
}

/* ====================================================================
   ADMIN: PETA SEMUA PESANAN
   ==================================================================== */
async function pgMap() {
  const root = h('div');
  const showDone = h('input', { type: 'checkbox' });
  const mapEl = h('div', { class: 'map tall', role: 'application', 'aria-label': 'Peta lokasi pesanan' });
  const list = h('div', { class: 'maplist' });
  root.append(pageHead('Peta lokasi pesanan'),
    h('div', { class: 'alert soft' }, 'Peta menampilkan ', h('strong', null, 'lokasi terakhir yang disimpan'), ' oleh pengantar (manual atau GPS) beserta waktunya. Ini bukan pelacakan langsung.'),
    h('label', { class: 'check' }, showDone, ' Tampilkan juga pesanan selesai'),
    h('div', { class: 'map-layout' }, mapEl, list));

  let map = null;
  let layer = null;
  async function draw() {
    const rows = await api('/map' + (showDone.checked ? '?all=1' : ''));
    clear(list);
    if (layer) layer.clearLayers();
    if (!rows.length) list.append(empty('Belum ada pesanan dengan lokasi tersimpan.'));
    const pts = [];
    for (const r of rows) {
      const text = lastSavedText(r);
      const stale = r.location_source === 'gps-berkala' && Date.now() - new Date(r.location_updated_at).getTime() > 15 * 60000;
      const entry = h('button', { type: 'button' }, h('div', null, h('strong', null, r.code), ' ', badge(r.status), sampleTag(r)),
        h('div', null, r.customer_name), h('div', { class: 'hint' }, text, stale ? ' · mungkin sudah tidak terbaru' : ''));
      if (map) {
        const popup = h('div', null, h('div', { class: 'popup-title' }, `${r.code} — ${r.customer_name}`), badge(r.status),
          h('div', null, r.address || ''), h('div', { class: 'hint' }, text),
          r.remaining > 0 ? h('div', { class: 'late' }, `Sisa tagihan ${rp(r.remaining)}`) : null,
          h('a', { href: `#/orders/${r.id}` }, 'Buka pesanan →'));
        const m = window.L.marker([r.lat, r.lng], { icon: pinIcon(r.status) }).bindPopup(popup).addTo(layer);
        entry.addEventListener('click', () => { map.setView([r.lat, r.lng], 16); m.openPopup(); });
        pts.push([r.lat, r.lng]);
      }
      list.append(entry);
    }
    if (map && pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
  }
  showDone.addEventListener('change', () => run(null, draw));
  if (typeof window.L === 'undefined') {
    mapEl.replaceWith(h('p', { class: 'warn' }, 'Pustaka peta gagal dimuat (periksa koneksi internet). Daftar lokasi tetap ditampilkan.'));
    await draw();
  } else {
    setTimeout(async () => {
      map = makeMap(mapEl, {});
      layer = window.L.layerGroup().addTo(map);
      await run(null, draw);
    }, 0);
  }
  return root;
}

/* ====================================================================
   ADMIN: PELANGGAN
   ==================================================================== */
async function pgCustomers() {
  const list = h('div');
  const q = h('input', { type: 'search', placeholder: 'Cari nama atau telepon…' });
  async function load() {
    const rows = await api('/customers?q=' + encodeURIComponent(q.value));
    clear(list);
    if (!rows.length) { list.append(empty('Belum ada pelanggan yang cocok.')); return; }
    list.append(h('div', { class: 'card tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Nama', 'Telepon', 'Alamat', 'Pesanan', ''].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((c) => h('tr', null,
        h('td', null, c.name, sampleTag(c)), h('td', null, c.phone), h('td', null, c.address), h('td', null, c.order_count),
        h('td', null, h('div', { class: 'btn-row' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => history(c) }, 'Riwayat'),
          h('button', { class: 'btn sm', type: 'button', onclick: () => edit(c) }, 'Ubah'),
          h('button', { class: 'btn sm danger', type: 'button', onclick: () => remove(c) }, 'Hapus')))))))));
  }
  async function history(c) {
    const d = await run(null, () => api('/customers/' + c.id));
    if (!d) return;
    openDialog(`Riwayat — ${d.name}`, d.orders.length ? h('div', { class: 'tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Kode', 'Status', 'Mulai', 'Total', 'Sisa'].map((x) => h('th', null, x)))),
      h('tbody', null, d.orders.map((o) => h('tr', null, h('td', null, h('a', { href: `#/orders/${o.id}`, onclick: () => document.querySelector('dialog')?.close() }, o.code)),
        h('td', null, badge(o.status)), h('td', null, fmtDate(o.start_date)), h('td', null, rp(o.total)), h('td', null, rp(o.remaining))))))) : h('p', { class: 'muted' }, 'Belum ada pesanan.'));
  }
  async function remove(c) {
    if (!confirm(`Hapus pelanggan ${c.name}?`)) return;
    if (await run(null, () => api('/customers/' + c.id, { method: 'DELETE' }), 'Pelanggan dihapus')) load();
  }
  function edit(c) {
    const f = {
      name: h('input', { type: 'text', required: true, maxlength: 120, value: c?.name || '' }),
      phone: h('input', { type: 'tel', required: true, maxlength: 20, value: c?.phone || '' }),
      address: h('input', { type: 'text', maxlength: 300, value: c?.address || '' }),
      notes: h('textarea', { rows: 2, maxlength: 500 }, c?.notes || ''),
    };
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan');
    let dlg;
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: f.name.value, phone: f.phone.value, address: f.address.value, notes: f.notes.value };
        const r = await run(btn, () => api(c ? '/customers/' + c.id : '/customers', { method: c ? 'PUT' : 'POST', body }), 'Pelanggan disimpan');
        if (r) { dlg.close(); load(); }
      },
    }, field('Nama', f.name), field('Telepon', f.phone), field('Alamat', f.address), field('Catatan', f.notes), btn);
    dlg = openDialog(c ? 'Ubah pelanggan' : 'Pelanggan baru', form);
  }
  let timer;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => run(null, load), 300); });
  const root = h('div', null, pageHead('Pelanggan', h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, '+ Pelanggan baru')), h('div', { class: 'card' }, q), list);
  await load();
  return root;
}

/* ====================================================================
   ADMIN: JENIS, HARGA & STOK
   ==================================================================== */
async function pgCatalog() {
  const list = h('div');
  async function load() {
    const rows = await api('/types');
    clear(list);
    list.append(h('div', { class: 'card tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Jenis', 'Harga sewa', 'Total', 'Dipakai', 'Tersedia', 'Status', ''].map((x, i) => h('th', { class: i >= 1 && i <= 4 ? 'num' : '' }, x)))),
      h('tbody', null, rows.map((s) => h('tr', null,
        h('td', null, h('strong', null, s.name), sampleTag(s), h('div', { class: 'hint' }, s.description)),
        h('td', { class: 'num' }, `${rp(s.price)} / ${unitLabel(s.unit)}`), h('td', { class: 'num' }, s.stock_total),
        h('td', { class: 'num' }, s.reserved), h('td', { class: 'num' }, s.available), h('td', null, s.active ? 'Aktif' : 'Nonaktif'),
        h('td', null, h('button', { class: 'btn sm', type: 'button', onclick: () => edit(s) }, 'Ubah'))))))),
    h('p', { class: 'hint' }, 'Ongkos kirim dan biaya tambahan lain diisi per pesanan. Perubahan harga tidak mengubah pesanan yang sudah dibuat (harga dikunci saat pesanan dibuat).'));
  }
  function edit(s) {
    const f = {
      name: h('input', { type: 'text', required: true, maxlength: 80, value: s?.name || '' }),
      description: h('input', { type: 'text', maxlength: 200, value: s?.description || '' }),
      unit: h('select', null, h('option', { value: 'day' }, 'per unit per hari'), h('option', { value: 'week' }, 'per unit per minggu')),
      price: numInput(s?.price, { required: true }),
      stock: numInput(s?.stock_total, { required: true }),
      active: h('input', { type: 'checkbox' }),
    };
    f.unit.value = s?.unit || 'day';
    f.active.checked = s ? !!s.active : true;
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan');
    let dlg;
    const form = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { name: f.name.value, description: f.description.value, unit: f.unit.value, price: Number(f.price.value), stock_total: Number(f.stock.value), active: f.active.checked };
        const r = await run(btn, () => api(s ? '/types/' + s.id : '/types', { method: s ? 'PUT' : 'POST', body }), 'Jenis disimpan');
        if (r) { dlg.close(); load(); }
      },
    }, field('Nama jenis', f.name), field('Deskripsi', f.description), field('Satuan harga', f.unit), field('Harga sewa (Rp)', f.price),
    field('Total stok (unit)', f.stock, s ? `Sedang dipakai pesanan aktif: ${s.reserved}` : null),
    h('label', { class: 'check' }, f.active, ' Aktif (dapat dipilih pada pesanan baru)'), btn);
    dlg = openDialog(s ? 'Ubah jenis' : 'Jenis baru', form);
  }
  const root = h('div', null, pageHead('Jenis, harga & stok', h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, '+ Jenis baru')), list);
  await load();
  return root;
}

/* ====================================================================
   ADMIN: PENGGUNA
   ==================================================================== */
async function pgUsers() {
  const list = h('div');
  async function load() {
    const rows = await api('/users');
    clear(list).append(h('div', { class: 'card tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Nama', 'Username', 'Peran', 'Status', ''].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((u) => h('tr', null, h('td', null, u.name), h('td', null, u.username),
        h('td', null, u.role === 'admin' ? 'Admin/Pemilik' : 'Pengantar'), h('td', null, u.active ? 'Aktif' : 'Nonaktif'),
        h('td', null, h('div', { class: 'btn-row' },
          h('button', { class: 'btn sm', type: 'button', onclick: () => resetPw(u) }, 'Reset sandi'),
          u.id === state.me.id ? null : h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (await run(null, () => api('/users/' + u.id, { method: 'PUT', body: { active: !u.active } }), 'Status pengguna diubah')) load(); } }, u.active ? 'Nonaktifkan' : 'Aktifkan')))))))));
  }
  function resetPw(u) {
    const pw = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Simpan');
    let dlg;
    dlg = openDialog(`Reset sandi — ${u.username}`, h('form', {
      onsubmit: async (e) => { e.preventDefault(); if (await run(btn, () => api('/users/' + u.id, { method: 'PUT', body: { password: pw.value } }), 'Kata sandi diganti')) dlg.close(); },
    }, field('Kata sandi baru', pw, 'Minimal 8 karakter. Semua sesi pengguna ini akan diakhiri.'), btn));
  }
  function create() {
    const f = {
      name: h('input', { type: 'text', required: true, maxlength: 80 }),
      username: h('input', { type: 'text', required: true, minlength: 3, maxlength: 32, autocapitalize: 'none' }),
      role: h('select', null, h('option', { value: 'courier' }, 'Pengantar'), h('option', { value: 'admin' }, 'Admin/Pemilik')),
      password: h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }),
    };
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Buat pengguna');
    let dlg;
    dlg = openDialog('Pengguna baru', h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        if (await run(btn, () => api('/users', { method: 'POST', body: { name: f.name.value, username: f.username.value, role: f.role.value, password: f.password.value } }), 'Pengguna dibuat')) { dlg.close(); load(); }
      },
    }, field('Nama', f.name), field('Username', f.username), field('Peran', f.role), field('Kata sandi', f.password, 'Minimal 8 karakter'), btn));
  }
  const root = h('div', null, pageHead('Pengguna', h('button', { class: 'btn primary', type: 'button', onclick: create }, '+ Pengguna baru')), list);
  await load();
  return root;
}

/* ====================================================================
   PENGANTAR: TUGAS
   ==================================================================== */
async function pgTasks() {
  const rows = await api('/orders');
  const root = h('div', null, pageHead('Tugas pengiriman'));
  if (!rows.length) root.append(empty('Belum ada tugas untuk Anda saat ini.'));
  else root.append(h('div', { class: 'orders' }, rows.map(orderCard)));
  return root;
}

const COURIER_NEXT = { 'Siap Dikirim': 'Dalam Pengiriman', 'Dalam Pengiriman': 'Sedang Disewa', 'Menunggu Penjemputan': 'Selesai' };
const COURIER_LABEL = {
  'Dalam Pengiriman': 'Mulai pengantaran', 'Sedang Disewa': 'Barang sudah diterima pelanggan', Selesai: 'Barang sudah dijemput — selesai',
};

async function pgTask(id) {
  const o = await api('/orders/' + id);
  const root = h('div');
  root.append(pageHead(h('span', null, o.code, sampleTag(o)), h('a', { class: 'btn', href: '#/tasks' }, '← Tugas')), h('p', null, badge(o.status)));
  if (o.overdue) root.append(h('div', { class: 'alert' }, 'Pengembalian sudah melewati jatuh tempo.'));
  const route = o.lat != null ? h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer', href: `https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}` }, '🧭 Buka rute di aplikasi peta') : null;
  root.append(h('div', { class: 'card' },
    h('p', null, h('strong', null, o.customer_name)),
    h('p', null, h('a', { class: 'btn', href: `tel:${o.customer_phone.replace(/[^+\d]/g, '')}` }, `📞 ${o.customer_phone}`)),
    h('p', null, 'Alamat: ', o.address || '—'), h('p', null, 'Proyek: ', o.project_notes || '—'),
    h('p', null, `Jadwal: ${fmtDate(o.start_date)} → ${fmtDate(o.due_date)}`),
    h('h3', null, 'Barang'), h('ul', null, o.items.map((i) => h('li', null, `${i.qty} × ${i.name}`))),
    route));

  const next = COURIER_NEXT[o.status];
  if (next) {
    const dmg = h('textarea', { rows: 2, maxlength: 1000, placeholder: 'Catatan kerusakan/kehilangan saat penjemputan (opsional)' }, o.damage_notes || '');
    const btn = h('button', { class: 'btn primary stepbtn', type: 'button', onclick: async () => {
      const body = { status: next };
      if (next === 'Selesai') body.damage_notes = dmg.value;
      if (await run(btn, () => api(`/orders/${o.id}/status`, { method: 'POST', body }), 'Status diperbarui')) { if (next === 'Selesai') location.hash = '#/tasks'; else router(); }
    } }, COURIER_LABEL[next]);
    root.append(h('div', { class: 'card' }, h('h2', null, 'Langkah berikutnya'), next === 'Selesai' ? field('Kondisi barang', dmg) : null, btn));
  }
  root.append(h('div', { class: 'card' }, h('h2', null, 'Lokasi proyek'), locationPicker(o, { periodic: true })));
  return root;
}

/* ====================================================================
   START
   ==================================================================== */
async function boot() {
  state.onUnauthorized = () => { state.me = null; renderLogin(); };
  try { state.config = await api('/config'); } catch {
    app.replaceChildren(h('p', { class: 'alert' }, 'Server tidak dapat dihubungi. Pastikan aplikasi berjalan.'));
    return;
  }
  try { state.me = (await api('/me')).user; } catch { state.me = null; }
  if (state.me) renderShell(); else renderLogin();
}
boot();
