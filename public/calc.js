// Dipakai bersama oleh server (otoritatif) dan browser (pratinjau langsung).
export const STATUSES = [
  'Menunggu Konfirmasi',
  'Siap Dikirim',
  'Dalam Pengiriman',
  'Sedang Disewa',
  'Menunggu Penjemputan',
  'Selesai',
  'Dibatalkan',
];
export const CLOSED = ['Selesai', 'Dibatalkan'];

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

/**
 * Hitung total sewa.
 * - Lama sewa (hari) = selisih tanggal mulai s/d tanggal kembali aktual (atau perkiraan selesai), minimal 1.
 * - Satuan 'day'  : qty * harga * jumlah hari
 * - Satuan 'week' : qty * harga * ceil(hari / 7)
 */
export function computeTotals({
  start_date, due_date, return_date, delivery_fee = 0, other_fee = 0, discount = 0, items = [], paid = 0,
}) {
  const end = return_date || due_date;
  const days = Math.max(1, daysBetween(start_date, end));
  const weeks = Math.ceil(days / 7);
  const lines = items.map((i) => {
    const periods = i.unit === 'week' ? weeks : days;
    return { ...i, periods, line_total: i.qty * i.unit_price * periods };
  });
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const total = Math.max(0, subtotal + delivery_fee + other_fee - discount);
  return { days, weeks, lines, subtotal, delivery_fee, other_fee, discount, total, paid, remaining: total - paid };
}
