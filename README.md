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

Produksi: set `VITE_DATA_URL` ke URL folder data di CDN (default `/data`).

## Data (F0)

Sumber: XAUUSD M1 dari terminal MetaTrader 5 (Windows, terminal terpasang dan login). Data tidak disimpan di repo; buat ulang dengan:

```bash
pip install -r tools/requirements.txt
python tools/export_mt5.py            # 3 bulan terakhir -> data/raw/*.parquet
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

Delta encoding + zstd: ±8 byte per candle M1 (3 bulan ±0,7 MB, 10 tahun ±29 MB).

`data/build/`:
- `M1/YYYY-MM.parquet` per bulan
- `M5|M15|M30|H1/YYYY.parquet` per tahun
- `H4|D1/all.parquet` satu file (D1 = hari trading 17:00 New York)
- `manifest.json` daftar file, range, jumlah candle

Browser membaca Parquet dengan [`hyparquet`](https://github.com/hyparam/hyparquet) + `hyparquet-compressors`.

History M1 lebih dari ~3 bulan butuh `Max bars in chart` dinaikkan di MT5.
