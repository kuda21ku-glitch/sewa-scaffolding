# Sewa Scaffolding

Aplikasi web untuk mengelola penyewaan scaffolding: pesanan, pengantaran, lokasi di peta, stok, harga, pembayaran, dan pengembalian. Dua peran: **Admin/Pemilik** dan **Pengantar**.

## Teknologi (dan alasannya)

| Bagian | Pilihan | Alasan |
|---|---|---|
| Server | Node.js ≥ 22.5, modul `http` bawaan | Tanpa framework; tidak ada `npm install`, sedikit yang bisa rusak |
| Database | SQLite bawaan Node (`node:sqlite`) | Satu file, tanpa server DB; cukup untuk satu usaha. Transaksi menjaga stok tetap konsisten |
| Keamanan | `crypto.scrypt` (hash sandi), sesi acak di cookie HttpOnly | Tanpa dependensi |
| Frontend | HTML + JavaScript modul + CSS (tanpa build) | Mudah dibaca & dikembangkan; responsif untuk ponsel dan desktop |
| Peta | Leaflet + OpenStreetMap | Gratis, tanpa API key wajib |
| Cari alamat | Nominatim (default) atau LocationIQ, dipanggil dari **server** | API key tidak sampai ke browser |

> Catatan: `node:sqlite` berstatus *experimental* di Node 22 (peringatan disembunyikan oleh `--no-warnings` pada skrip `npm start`).

## Menjalankan secara lokal

```bash
cd sewa-scaffolding
cp .env.example .env        # opsional; tanpa .env pun berjalan dalam mode demo
npm start                   # buka http://localhost:3000
npm test                    # menjalankan smoke test (16 tes)
```

Mode demo (`DEMO_MODE=true`) membuat data contoh bertanda **CONTOH** dan tiga akun: `admin`, `budi`, `agus` — kata sandi `demo1234`.

### Mengakses dari ponsel pengantar
1. Set `HOST=0.0.0.0` di `.env`, lalu buka `http://<IP-komputer>:3000` dari ponsel di jaringan yang sama.
2. **GPS browser hanya bekerja lewat HTTPS atau `localhost`.** Untuk pemakaian nyata, pasang aplikasi di belakang HTTPS (mis. Caddy/Nginx atau layanan hosting) dan set `COOKIE_SECURE=true`. Tanpa HTTPS, pengantar tetap bisa memakai pencarian alamat dan pin manual.

### Beralih ke produksi
Set `DEMO_MODE=false`, isi `ADMIN_USERNAME` dan `ADMIN_PASSWORD` (admin pertama dibuat saat database masih kosong), hapus `data/sewa.db` bila sebelumnya memakai mode demo.

## Variabel lingkungan

| Variabel | Fungsi |
|---|---|
| `PORT`, `HOST` | Alamat server (default 3000, 127.0.0.1) |
| `DB_PATH` | Lokasi file SQLite (default `data/sewa.db`) |
| `APP_TZ` | Zona waktu untuk "hari ini" (default Asia/Jakarta) |
| `COOKIE_SECURE` | `true` bila lewat HTTPS |
| `DEMO_MODE`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Data contoh / pembuatan admin pertama |
| `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` | Sumber ubin peta. **Dikirim ke browser** — hanya isi key yang dibatasi domain |
| `MAP_DEFAULT_LAT`, `MAP_DEFAULT_LNG` | Pusat peta awal |
| `GEOCODER_PROVIDER`, `GEOCODER_API_KEY`, `GEOCODER_USER_AGENT` | Pencarian alamat. **Key hanya dipakai di server** |

### Mengatur API key peta dengan aman
- Taruh semua key di `.env` (sudah ada di `.gitignore`). Jangan menaruhnya di kode atau repositori.
- **Key geocoding** (LocationIQ, dsb.) bersifat rahasia → hanya dibaca server dari `GEOCODER_API_KEY`; browser memanggil `/api/geocode` milik server.
- **Key ubin peta** (mis. MapTiler/Stadia) tetap terlihat di browser karena ubin diambil langsung → buat key khusus *browser* dan batasi ke domain Anda di dashboard penyedia.
- Server tile publik OSM dan Nominatim publik punya kebijakan pemakaian wajar; untuk usaha yang aktif harian, gunakan penyedia berkey. Ganti `GEOCODER_USER_AGENT` dengan kontak Anda.
- Google Maps tidak diimplementasikan; bila ingin beralih, ganti `locationPicker`/`makeMap` di `public/maps.js` dan tambahkan proxy geocoding di `server/index.js`.

## Struktur proyek

```
sewa-scaffolding/
├── package.json  .env.example  .gitignore  README.md
├── server/
│   ├── index.js      # HTTP server, router, header keamanan, geocoding proxy
│   ├── db.js         # skema SQLite + helper transaksi
│   ├── auth.js       # scrypt, sesi, pembatasan percobaan login
│   ├── services.js   # aturan bisnis: pesanan, stok, harga, pembayaran, lokasi
│   ├── seed.js       # data contoh / admin pertama
│   └── util.js       # validasi & tanggal
├── public/
│   ├── index.html  style.css
│   ├── calc.js       # rumus total (dipakai server DAN browser)
│   ├── ui.js         # helper DOM aman, API client, toast, dialog
│   ├── maps.js       # Leaflet, pemilih lokasi manual/GPS
│   └── app.js        # halaman admin & pengantar, router
└── test/smoke.js
```

## Alur penggunaan

**Admin:** buat pelanggan/pesanan → pilih barang (stok tampil) → tentukan jadwal, pengantar, ongkir, diskon → total otomatis → ubah status sepanjang alur (Menunggu Konfirmasi → Siap Dikirim → Dalam Pengiriman → Sedang Disewa → Menunggu Penjemputan → Selesai, atau Dibatalkan) → catat uang muka/pelunasan → pantau dashboard dan peta.

**Pengantar:** buka *Tugas Saya* → lihat alamat, barang, telepon → tekan *Mulai pengantaran* → tentukan lokasi proyek (cari alamat / geser pin / GPS) → *Simpan lokasi* → tekan *Barang sudah diterima pelanggan*. Saat penjemputan: catat kondisi barang → *selesai*.

## Aturan perhitungan & stok

- Hari sewa = tanggal mulai s/d **tanggal kembali aktual** (atau perkiraan selesai bila belum kembali), minimal 1 hari. Pengembalian terlambat otomatis menambah biaya.
- Harga harian: `jumlah × harga × hari`. Harga mingguan: `jumlah × harga × ceil(hari / 7)`.
- Total = subtotal + ongkir + biaya tambahan − diskon. Sisa = total − pembayaran.
- Harga dikunci saat pesanan dibuat; mengubah katalog tidak mengubah pesanan lama.
- Stok tersedia = total − jumlah pada pesanan yang belum Selesai/Dibatalkan (termasuk *Menunggu Konfirmasi*). Dihitung dari data pesanan dalam transaksi, sehingga tidak bisa negatif.
- Pelunasan harus sebesar sisa tagihan; cicilan dicatat sebagai uang muka. Pembayaran tidak boleh melebihi sisa.

## Lokasi manual vs GPS

| | Manual | GPS sekali | GPS berkala (opsional) |
|---|---|---|---|
| Cara | Cari alamat, ketuk peta, atau geser pin → *Simpan* | Tombol *Gunakan lokasi GPS saya* → periksa pin → *Simpan* | Pengantar mencentang, memilih interval (1/2/5 menit) |
| Izin | Tidak perlu | Izin lokasi browser | Izin lokasi browser |
| Akurasi | Sesuai pin yang dipilih | Bergantung sinyal | Bergantung sinyal |
| Baterai | Tidak ada | Sekali | Boros — hanya aktif bila dicentang |
| Syarat | — | HTTPS/localhost | HTTPS/localhost, **halaman tetap terbuka** |

Admin selalu melihat **“lokasi terakhir disimpan”** lengkap dengan waktu dan sumbernya (Manual / GPS / GPS berkala). Aplikasi tidak menyebutnya pelacakan langsung. Pembaruan berkala berhenti saat pengantar mematikannya, berpindah halaman, atau menutup halaman.

## Keamanan yang diterapkan

- Sandi di-hash dengan scrypt + salt; minimal 8 karakter; ganti sandi menutup semua sesi pengguna tersebut.
- Sesi: token acak 256-bit, hanya hash-nya disimpan; cookie `HttpOnly`, `SameSite=Strict` (+`Secure` bila HTTPS); kedaluwarsa 12 jam.
- Kontrol akses per peran di server. Pengantar hanya melihat pesanan yang ditugaskan padanya dan **tanpa data harga/pembayaran**; transisi status pengantar dibatasi.
- Pembatasan percobaan login (5 gagal / 15 menit per IP+username).
- Perlindungan CSRF tambahan (header khusus + JSON), validasi semua input di server, query SQL berparameter, UI dibangun tanpa `innerHTML` (anti-XSS), CSP dan header keamanan.

## Keterbatasan & saran pengembangan

- Peta/geocoding membutuhkan internet. Tanpa pustaka peta, pengantar masih bisa mengisi koordinat manual.
- GPS berkala hanya berjalan selagi halaman terbuka (batasan browser). Untuk pelacakan andal di latar belakang perlu aplikasi native/PWA dengan layanan lokasi.
- Pembatas login berada di memori (reset saat server restart) dan satu proses server saja. Pasang di balik HTTPS, buat cadangan rutin file `data/sewa.db`.
- Leaflet dimuat dari CDN unpkg tanpa atribut `integrity`; untuk produksi, host sendiri file Leaflet.
- Belum ada: foto kondisi barang, tanda tangan penerima, notifikasi/pengingat otomatis (WhatsApp/email), cetak invoice/PDF, ekspor laporan, pembatalan pembayaran (koreksi), ganti pelanggan pada pesanan. Kolom catatan kerusakan/kehilangan dan riwayat pelanggan sudah tersedia sebagai dasar.
- Uji otomatis mencakup backend; tampilan diuji manual di Chrome headless tanpa akses ke CDN peta, sehingga rendering peta Leaflet sebenarnya perlu Anda coba sekali dengan internet.
