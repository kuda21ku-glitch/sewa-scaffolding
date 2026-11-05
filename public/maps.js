// Peta (Leaflet + OpenStreetMap) dan pemilih lokasi: manual & GPS.
import { STATUSES } from './calc.js';
import {
  h, api, state, toast, run, fmtDT, ago, SOURCE_LABEL, onLeave,
} from './ui.js';

const hasLeaflet = () => typeof window.L !== 'undefined';

export function makeMap(el, { lat, lng, zoom = 13 } = {}) {
  const c = state.config.map;
  const map = window.L.map(el).setView([lat ?? c.lat, lng ?? c.lng], zoom);
  window.L.tileLayer(c.tile_url, { attribution: c.attribution, maxZoom: 19 }).addTo(map);
  new ResizeObserver(() => map.invalidateSize()).observe(el);
  onLeave(() => map.remove());
  return map;
}

export function pinIcon(status) {
  return window.L.divIcon({
    className: `pin s-${STATUSES.indexOf(status)}`,
    html: '<span class="pin-dot"></span>',
    iconSize: [26, 26],
    iconAnchor: [13, 26],
    popupAnchor: [0, -24],
  });
}

/** Teks jelas bahwa ini LOKASI TERAKHIR TERSIMPAN, bukan pelacakan langsung. */
export function lastSavedText(o) {
  if (o.lat === null || o.lat === undefined) return 'Belum ada lokasi yang disimpan';
  const src = SOURCE_LABEL[o.location_source] || o.location_source;
  return `Lokasi terakhir disimpan ${fmtDT(o.location_updated_at)} (${ago(o.location_updated_at)}) · sumber: ${src}`;
}

function geoErrorMessage(err) {
  if (!window.isSecureContext) return 'GPS browser hanya berfungsi lewat HTTPS atau localhost. Gunakan pencarian alamat atau pin manual.';
  if (err.code === 1) return 'Izin lokasi ditolak. Aktifkan izin lokasi untuk situs ini di pengaturan browser, atau pakai pencarian alamat/pin manual.';
  if (err.code === 2) return 'Posisi perangkat tidak dapat ditentukan. Coba di tempat terbuka atau pakai pin manual.';
  return 'Waktu habis saat mencari posisi GPS. Coba lagi atau pakai pin manual.';
}

/**
 * Pemilih lokasi untuk satu pesanan.
 *  - Manual: cari alamat / ketuk peta / geser pin → "Simpan lokasi"
 *  - GPS sekali: tombol "Gunakan lokasi GPS saya" (browser meminta izin)
 *  - GPS berkala (opsional): hanya aktif jika dicentang; berhenti saat halaman ditutup
 */
export function locationPicker(order, { periodic = false, onSaved } = {}) {
  const id = order.id;
  const root = h('div', { class: 'picker' });
  const status = h('p', { class: 'loc-status' }, lastSavedText(order));
  const note = h('p', { class: 'hint' }, 'Ini adalah lokasi terakhir yang disimpan, bukan pelacakan langsung.');

  if (!hasLeaflet()) {
    root.append(h('p', { class: 'warn' }, 'Pustaka peta (Leaflet) gagal dimuat — periksa koneksi internet. Anda masih dapat memasukkan koordinat secara manual.'));
  }

  let pending = order.lat === null || order.lat === undefined ? null : { lat: order.lat, lng: order.lng, source: order.location_source === 'gps-berkala' ? 'manual' : (order.location_source || 'manual') };
  const coordText = h('p', { class: 'coord' });
  const showCoord = () => { coordText.textContent = pending ? `Pin: ${pending.lat.toFixed(6)}, ${pending.lng.toFixed(6)}` : 'Pin belum ditentukan — cari alamat atau ketuk peta'; };
  showCoord();

  let map = null;
  let marker = null;
  function setPin(lat, lng, source, fly = true) {
    pending = { lat, lng, source };
    showCoord();
    if (!map) return;
    if (!marker) {
      marker = window.L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); setPin(p.lat, p.lng, 'manual', false); });
    } else marker.setLatLng([lat, lng]);
    if (fly) map.setView([lat, lng], Math.max(map.getZoom(), 17));
  }

  // --- Pencarian alamat ---
  const q = h('input', { type: 'search', placeholder: 'Cari alamat / nama tempat…', maxlength: 200, 'aria-label': 'Cari alamat' });
  const results = h('ul', { class: 'results' });
  const searchBtn = h('button', { type: 'button', class: 'btn' }, 'Cari');
  async function search() {
    results.replaceChildren();
    if (q.value.trim().length < 3) { toast('Ketik minimal 3 karakter alamat', 'err'); return; }
    const list = await run(searchBtn, () => api('/geocode?q=' + encodeURIComponent(q.value.trim())));
    if (!list) return;
    if (!list.length) { results.append(h('li', { class: 'muted' }, 'Alamat tidak ditemukan. Coba kata kunci lain atau ketuk peta untuk menaruh pin.')); return; }
    for (const r of list) {
      results.append(h('li', null, h('button', {
        type: 'button', class: 'link-btn',
        onclick: () => { setPin(r.lat, r.lng, 'manual'); results.replaceChildren(); },
      }, r.label)));
    }
  }
  searchBtn.addEventListener('click', search);
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });

  // --- Peta ---
  const mapEl = h('div', { class: 'map', role: 'application', 'aria-label': 'Peta pemilihan lokasi' });
  // --- Koordinat manual (cadangan bila peta tidak dapat dimuat) ---
  const latIn = h('input', { type: 'number', step: 'any', placeholder: 'Lintang (lat)', 'aria-label': 'Lintang' });
  const lngIn = h('input', { type: 'number', step: 'any', placeholder: 'Bujur (lng)', 'aria-label': 'Bujur' });
  const coordRow = hasLeaflet() ? null : h('div', { class: 'row2' }, latIn, lngIn);
  if (coordRow) {
    const sync = () => {
      const a = Number(latIn.value); const b = Number(lngIn.value);
      if (latIn.value !== '' && lngIn.value !== '' && Number.isFinite(a) && Number.isFinite(b)) setPin(a, b, 'manual');
    };
    latIn.addEventListener('input', sync); lngIn.addEventListener('input', sync);
  }

  // --- GPS sekali ---
  const gpsBtn = h('button', { type: 'button', class: 'btn' }, '📍 Gunakan lokasi GPS saya');
  gpsBtn.addEventListener('click', () => {
    if (!navigator.geolocation) { toast('Perangkat/browser ini tidak mendukung GPS', 'err'); return; }
    gpsBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => { gpsBtn.disabled = false; setPin(pos.coords.latitude, pos.coords.longitude, 'gps'); toast(`Posisi GPS didapat (akurasi ±${Math.round(pos.coords.accuracy)} m). Periksa pin lalu tekan Simpan.`); },
      (err) => { gpsBtn.disabled = false; toast(geoErrorMessage(err), 'err'); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  });

  // --- Alamat & catatan pengantar ---
  const addr = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Alamat pengantaran / patokan' }, order.address || '');
  const notes = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Catatan pengantar (akses jalan, kontak di lokasi, dll.)' }, order.courier_notes || '');

  const saveBtn = h('button', { type: 'button', class: 'btn primary' }, 'Simpan lokasi');
  saveBtn.addEventListener('click', async () => {
    if (!pending) { toast('Tentukan pin lokasi terlebih dahulu', 'err'); return; }
    const o = await run(saveBtn, () => api(`/orders/${id}/location`, {
      method: 'POST',
      body: { lat: pending.lat, lng: pending.lng, source: pending.source, address: addr.value, courier_notes: notes.value },
    }), 'Lokasi tersimpan');
    if (o) { order = o; status.textContent = lastSavedText(o); if (onSaved) onSaved(o); }
  });

  root.append(
    status, note,
    h('div', { class: 'search-row' }, q, searchBtn), results,
    mapEl, coordRow, coordText,
    h('div', { class: 'btn-row' }, gpsBtn),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Alamat pengantaran'), addr),
    h('label', { class: 'field' }, h('span', { class: 'lbl' }, 'Catatan pengantar'), notes),
    h('div', { class: 'btn-row' }, saveBtn),
  );

  // --- GPS berkala (opsional, hanya pengantar) ---
  if (periodic) root.append(periodicBox());

  function periodicBox() {
    const box = h('div', { class: 'periodic' });
    const toggle = h('input', { type: 'checkbox', id: `periodic-${id}` });
    const interval = h('select', { 'aria-label': 'Interval pembaruan' },
      h('option', { value: '60000' }, 'tiap 1 menit'),
      h('option', { value: '120000' }, 'tiap 2 menit'),
      h('option', { value: '300000' }, 'tiap 5 menit'));
    interval.value = '120000';
    const info = h('p', { class: 'hint' }, 'Nonaktif.');
    let watchId = null;
    let lastSent = 0;
    const stop = () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null; toggle.checked = false; info.textContent = 'Nonaktif.';
    };
    onLeave(stop);
    toggle.addEventListener('change', () => {
      if (!toggle.checked) { stop(); return; }
      if (!navigator.geolocation) { toast('Perangkat/browser ini tidak mendukung GPS', 'err'); toggle.checked = false; return; }
      if (!window.isSecureContext) { toast(geoErrorMessage({ code: 0 }), 'err'); toggle.checked = false; return; }
      lastSent = 0;
      info.textContent = 'Meminta izin lokasi…';
      watchId = navigator.geolocation.watchPosition(async (pos) => {
        const now = Date.now();
        if (now - lastSent < Number(interval.value)) return;
        lastSent = now;
        try {
          const o = await api(`/orders/${id}/location`, {
            method: 'POST',
            body: { lat: pos.coords.latitude, lng: pos.coords.longitude, source: 'gps-berkala' },
          });
          order = o;
          status.textContent = lastSavedText(o);
          info.textContent = `Aktif — terakhir terkirim ${fmtDT(o.location_updated_at)}.`;
          setPin(o.lat, o.lng, 'manual', false);
          if (map) map.setView([o.lat, o.lng], map.getZoom());
          if (onSaved) onSaved(o);
        } catch (e) { toast(e.message, 'err'); stop(); }
      }, (err) => { toast(geoErrorMessage(err), 'err'); stop(); }, { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
    });
    box.append(
      h('h3', null, 'Pembaruan lokasi GPS berkala (opsional)'),
      h('label', { class: 'check' }, toggle, ' Aktifkan dan bagikan lokasi GPS saya ', interval),
      info,
      h('ul', { class: 'hint-list' },
        h('li', null, 'Hanya berjalan saat Anda mengaktifkannya dan menyetujui izin lokasi browser.'),
        h('li', null, 'Halaman ini harus tetap terbuka (browser dapat menghentikan GPS saat layar mati/tab di latar belakang).'),
        h('li', null, 'Boros baterai: pilih interval lebih panjang bila perlu, matikan setelah barang tiba.'),
        h('li', null, 'Admin tetap melihatnya sebagai “lokasi terakhir disimpan”, bukan pelacakan langsung.')),
    );
    return box;
  }

  // Inisialisasi peta setelah elemen terpasang di DOM
  if (hasLeaflet()) {
    setTimeout(() => {
      map = makeMap(mapEl, { lat: order.lat ?? undefined, lng: order.lng ?? undefined, zoom: order.lat != null ? 17 : 13 });
      map.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng, 'manual', false));
      if (pending) setPin(pending.lat, pending.lng, pending.source, false);
    }, 0);
  }
  return root;
}
