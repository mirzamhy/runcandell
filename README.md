# runcandell

Tempat belajar trading XAUUSD gratis: chart, indikator, bar replay, backtest, dan duel antar user. Planning lengkap di [docs/PLAN.md](docs/PLAN.md).

## Web (F1: chart viewer)

```bash
cd web
npm install
npm run dev        # http://localhost:5200, data dibaca dari ../data/build
npm run build      # hasil di web/dist
```

Fitur: candlestick + panel volume, timeframe M1–D1, zona waktu (UTC/WIB/London/New York), lompat ke tanggal, tombol ke candle terbaru, legend OHLC/volume/spread, data dimuat per file saat chart digeser. Alat gambar: garis horizontal, trendline, zona, Fibonacci; bisa dipilih, digeser, dihapus (Delete), tersimpan di browser.

Indikator (F2), lewat tombol **Indikator**:
- Di chart: EMA, SMA, Bollinger Bands, VWAP harian, Supertrend, Ichimoku, Donchian, Pivot harian (classic), sesi pasar Asia/London/New York.
- Panel bawah: RSI, MACD, Stochastic, ATR, OBV, MFI. VWAP, OBV, MFI pakai tick volume.
- Nilai tampil di chip kiri atas (ikut crosshair); ikon gerigi untuk ubah periode dan warna; tersimpan di browser.
- Rumus mengikuti default TradingView (RSI/ATR pakai Wilder, EMA diawali SMA); sudah dicocokkan dengan hitungan pandas.

Bar replay + paper trading (F3), lewat tombol **Replay**:
- Klik candle untuk titik mulai (atau **Acak**). Candle sesudahnya disembunyikan; candle timeframe besar yang sedang berjalan dibangun dari M1 sampai titik replay, jadi high/low masa depan tidak bocor.
- Kontrol: putar/jeda (Spasi), maju 1 candle (Shift+→), kecepatan 1–20 candle/detik, ulang dari awal, sembunyikan tanggal (jam tetap tampil).
- Order market, limit, stop dengan SL/TP; risiko per trade dan R:R tampil sebelum order. Garis SL/TP/order pending bisa digeser di chart.
- Akun $10.000, leverage 1:100, 1 lot = 100 oz, spread dari data. Buy masuk di Ask keluar di Bid; sell sebaliknya. Kalau SL dan TP kena di candle yang sama, dianggap SL.
- Panel: saldo, equity, posisi, order, riwayat, statistik (win rate, profit factor, max drawdown), kurva equity. Sesi tersimpan dan bisa dilanjutkan.
- Tes engine: `npm test` di folder `web`.

Backtest (F4), lewat tombol **Backtest**:
- Strategi tanpa kode (kondisi dari indikator, contoh siap pakai) atau kode JavaScript, jalan di Web Worker.
- Sinyal dibaca saat candle tutup, order masuk di open candle berikutnya; SL/TP dicek per menit pakai data M1.
- SL/TP: jarak $, kelipatan ATR, atau R:R. Ukuran: lot tetap atau % saldo. Filter jam entry, balik posisi, tutup setelah N candle, komisi, slippage.
- Laporan: net profit, win rate, profit factor, max drawdown, rata-rata R, expectancy, Sharpe, kurva equity + drawdown, per jam/hari/sesi. Marker trade di chart, klik trade untuk lompat.
- Optimasi grid 1–2 parameter (maks 200 kombinasi) dengan data latih 70% / uji 30% dan peringatan overfitting. Bandingkan dua hasil (A/B).

Akun & jurnal (F5), lewat tombol **Masuk** di kanan atas (butuh server API):
- Akun cukup nickname. Setelah dibuat muncul kode pemulihan untuk masuk dari perangkat lain (tidak ada email/password).
- Jurnal trade: di replay, tab **Riwayat** → **Jurnal** di trade yang selesai. Isi setup, emosi, alasan entry, tag; screenshot chart dilampirkan otomatis.
- Statistik pribadi lintas sesi: win rate, net, rata-rata R, per setup dan per emosi.
- Simpan sesi replay ke akun (tombol **Simpan** di bar replay) dan lanjutkan dari perangkat mana pun. Simpan hasil backtest, pakai lagi strateginya, atau jadikan pembanding A.

Duel (F6), lewat tombol **Duel** (butuh server API dan login):
- Buat duel lawan (kirim link/kode ke teman) atau latihan sendiri. Atur jumlah ronde, waktu analisa, jendela run, mode hardcore (jam juga disembunyikan).
- Tiap ronde: chart dipotong di titik acak, harga dinormalisasi (`p' = (p - anchor) × k + 1000`) dan tanggal disembunyikan. Semua timeframe dan indikator boleh dipakai.
- Pilih BUY/SELL dengan SL wajib (TP opsional; bisa klik chart untuk set harga) atau Skip, sebelum waktu habis.
- Candle sesudah titik potong baru dikirim server setelah keputusan terkunci, lalu diputar. Skor dalam R (kena SL = -1R, spread dihitung). Waktu habis = skip.
- Hasil lawan baru terlihat setelah dua pemain selesai; tanggal asli tiap ronde dibuka di akhir.

```bash
cd server
npm install
npm run dev        # API di http://localhost:5201, database SQLite di data/server/runcandell.db
npm test
```

Web dev mem-proxy `/api` ke port 5201. Server pakai `node:sqlite` bawaan Node 24 (tanpa modul native).

Produksi: set `VITE_DATA_URL` ke URL folder data di CDN (default `/data`).

## Data (F0)

Sumber: XAUUSD M1 dari terminal MetaTrader 5 (Windows, terminal terpasang dan login). Data tidak disimpan di repo; buat ulang dengan:

```bash
pip install -r tools/requirements.txt
python tools/export_mt5.py            # 12 bulan terakhir -> data/raw/*.parquet
python tools/build_data.py --strict   # validasi + piramida timeframe -> data/build/
```

Opsi export: `--months N`, `--start YYYY-MM-DD --end YYYY-MM-DD`, `--symbol`, `--terminal`, `--tz-offset` (jam server broker dikurangi UTC; Exness = 0), `--csv` (salinan CSV untuk dicek manual).

Format: Parquet, semua kolom integer.

| kolom | tipe | isi |
|---|---|---|
| `time` | uint32 | unix detik UTC, waktu buka candle |
| `open, high, low, close` | int32 | harga dalam point (`harga = nilai × point`, lihat `manifest.json`) |
| `tick_volume` | uint32 | jumlah tick |
| `spread` | uint16 | spread minimum dalam point |

Delta encoding + zstd: ±8 byte per candle M1 (1 tahun ±2,9 MB, 10 tahun ±29 MB).

`data/build/`:
- `M1/YYYY-MM.parquet` per bulan
- `M5|M15|M30|H1/YYYY.parquet` per tahun
- `H4|D1/all.parquet` satu file (D1 = hari trading 17:00 New York)
- `manifest.json` daftar file, range, jumlah candle

Browser membaca Parquet dengan [`hyparquet`](https://github.com/hyparam/hyparquet) + `hyparquet-compressors`.

Data sekarang: akun Exness standar, simbol `XAUUSD`, 1 tahun, spread mengambang (median ±$0,17). History M1 lebih dari ~3 bulan butuh `Max bars in chart` dinaikkan di MT5.
