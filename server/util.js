export class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}

const TZ = process.env.APP_TZ || 'Asia/Jakarta';

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

export function addDays(d, n) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
    && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
}

export function reqDate(v, label) {
  if (!isDate(v)) throw new HttpError(400, `${label} tidak valid (format YYYY-MM-DD)`);
  return v;
}

export function reqStr(v, label, { min = 1, max = 200 } = {}) {
  if (typeof v !== 'string') throw new HttpError(400, `${label} wajib diisi`);
  const s = v.trim();
  if (s.length < min) throw new HttpError(400, `${label} wajib diisi${min > 1 ? ` (minimal ${min} karakter)` : ''}`);
  if (s.length > max) throw new HttpError(400, `${label} maksimal ${max} karakter`);
  return s;
}

export function optStr(v, label, max = 1000) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw new HttpError(400, `${label} tidak valid`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${label} maksimal ${max} karakter`);
  return s;
}

export function int(v, label, { min = 0, max = 1e12 } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${label} harus bilangan bulat antara ${min} dan ${max}`);
  }
  return n;
}

export function oneOf(v, list, label) {
  if (!list.includes(v)) throw new HttpError(400, `${label} tidak valid`);
  return v;
}

export function coords(lat, lng) {
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) {
    throw new HttpError(400, 'Koordinat lokasi tidak valid');
  }
  return [a, b];
}

export function validPhone(v) {
  const s = reqStr(v, 'Nomor telepon', { max: 20 });
  if (!/^\+?[0-9 ()-]{6,20}$/.test(s)) throw new HttpError(400, 'Nomor telepon tidak valid');
  return s;
}
