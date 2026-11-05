// Helper UI: pembuat DOM aman (tanpa innerHTML), API client, format, toast, dialog.
import { STATUSES } from './calc.js';

export const state = { config: null, me: null, onUnauthorized: () => {} };

/* ---------- DOM ---------- */
function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : String(k));
  }
}

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, kids);
  if (value !== undefined) el.value = value; // setelah <option> terpasang
  return el;
}

export const clear = (el) => { el.replaceChildren(); return el; };

/* ---------- Format ---------- */
export const rp = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
export const fmtDate = (d) => (d
  ? new Date(d + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const fmtDT = (iso) => (iso
  ? new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', ':') + ' WIB'
  : '—');
export function ago(iso) {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} menit lalu`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} jam lalu`;
  return `${Math.round(hr / 24)} hari lalu`;
}
export const unitLabel = (u) => (u === 'week' ? 'minggu' : 'hari');
export const SOURCE_LABEL = { manual: 'Manual (pin/alamat)', gps: 'GPS perangkat (sekali)', 'gps-berkala': 'GPS berkala' };

export function badge(status) {
  return h('span', { class: `badge s-${STATUSES.indexOf(status)}` }, status);
}
export const sampleTag = (o) => (o && o.is_sample ? h('span', { class: 'tag-sample', title: 'Data contoh' }, 'CONTOH') : null);

/* ---------- API ---------- */
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sewa' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* kosong */ }
  if (res.status === 401 && path !== '/login') {
    state.onUnauthorized();
    throw new Error('Sesi berakhir, silakan login kembali');
  }
  if (!res.ok) throw new Error((data && data.error) || 'Terjadi kesalahan');
  return data;
}

/* ---------- Toast ---------- */
export function toast(msg, type = 'ok') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${type}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
}

/* Jalankan aksi dengan tombol terkunci + pesan sukses/gagal */
export async function run(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- Komponen kecil ---------- */
export const loading = (txt = 'Memuat…') => h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner' }), txt);
export const empty = (msg, ...actions) => h('div', { class: 'empty' }, h('p', null, msg), ...actions);

export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'lbl' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);
}

export function openDialog(title, content) {
  const dlg = h('dialog', { class: 'dlg' });
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.append(
    h('div', { class: 'dlg-head' }, h('h2', null, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Tutup', onclick: close }, '×')),
    h('div', { class: 'dlg-body' }, content),
  );
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { close, el: dlg };
}

/* ---------- Pembersihan saat pindah halaman (peta, watchPosition) ---------- */
let leaveFns = [];
export const onLeave = (fn) => leaveFns.push(fn);
export function runLeave() {
  for (const f of leaveFns) { try { f(); } catch { /* abaikan */ } }
  leaveFns = [];
}
