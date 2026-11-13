# runcandell — Planning Fitur

Tempat belajar trading XAUUSD gratis: chart mirip TradingView, bar replay, backtest, dan duel antar user di chart yang sama.

Data: XAUUSD M1 dari MetaTrader 5 (gratis), mulai 3 bulan. Field: `time` (UTC), `open`, `high`, `low`, `close`, `tick_volume`, `spread`.

## Stack

| Bagian | Pilihan | Alasan |
|---|---|---|
| Export data | Python + package `MetaTrader5` | gratis, langsung dari terminal MT5 |
| Simpan data | Parquet (int point + delta + zstd), piramida timeframe | ±8 B/candle, 10 tahun ±29 MB |
| Baca data di browser | `hyparquet` + `hyparquet-compressors` | file statis via CDN, VPS tidak terbebani |
| Frontend | Vite + TypeScript + `lightweight-charts` | chart open-source TradingView, Apache 2.0 |
| Hitung indikator & backtest | TypeScript di Web Worker | UI tidak macet |
| Server (mulai fase 5) | Node + Hono + SQLite + WebSocket | murah, satu VPS cukup |
| Login | nickname guest dulu, lalu email magic link | tanpa biaya pihak ketiga |

## Fase

### F0 — Data pipeline
- Script `tools/export_mt5.py`: tarik M1 range tanggal, simpan `data/raw/XAUUSD_M1_YYYY-MM.parquet`.
- Konversi jam server broker ke UTC.
- Validasi: candle duplikat, gap weekend/libur, high < low, spread aneh.
- Script build: piramida timeframe Parquet (M1 per bulan, M5–H1 per tahun, H4/D1 satu file) + `manifest.json`.
- Data tidak masuk git; dibuat ulang dari MT5, nanti di-host di CDN.

### F1 — Chart viewer
- Candlestick, zoom, pan, crosshair dengan OHLC + volume.
- Ganti timeframe: M1, M5, M15, M30, H1, H4, D1 (resample dari M1 di client).
- Panel `tick_volume` di bawah chart.
- Pilih tanggal (go to date).
- Drawing dasar: horizontal line, trendline, rectangle (zona), fib retracement.
- Simpan layout & drawing di localStorage.

### F2 — Indikator
- Overlay: SMA, EMA, Bollinger, VWAP, Ichimoku, Supertrend, Donchian, Pivot harian.
- Panel bawah: RSI, MACD, Stochastic, ATR, OBV, MFI.
- Setting tiap indikator (periode, warna), bisa tambah/hapus.
- Sesi pasar (Asia/London/NY) sebagai background warna, penting untuk emas.

### F3 — Bar replay + paper trading manual (inti belajar)
- Pilih titik mulai, candle masa depan disembunyikan.
- Kontrol: next candle, play/pause, kecepatan (1x–60x), mundur ke titik mulai.
- Order: market buy/sell, limit, stop, dengan SL/TP (drag di chart).
- Ukuran posisi dalam lot, saldo awal (misal $10.000), leverage, spread dari data.
- Eksekusi: SL/TP dicek ke high/low candle. Kalau SL dan TP kena di candle sama, ambil skenario terburuk (SL).
- Riwayat trade + equity curve.
- Mode "tanggal disembunyikan" untuk latihan tanpa bias tahu berita.

### F4 — Backtest strategi otomatis
- Strategy builder tanpa kode: kondisi entry/exit dari indikator (contoh: EMA20 cross EMA50 dan RSI > 50), SL/TP pakai pips, ATR, atau risk:reward.
- Mode kode: tulis strategi di editor TypeScript sederhana, jalan di Worker (sandbox).
- Order masuk di open candle berikutnya (tanpa lookahead).
- Biaya: spread dari data + komisi opsional + slippage opsional.
- Laporan: net profit, win rate, profit factor, max drawdown, avg R, expectancy, jumlah trade, Sharpe, equity & drawdown curve, distribusi per jam/hari/sesi.
- Marker trade di chart, klik trade lompat ke candle-nya.
- Optimasi parameter sederhana (grid kecil) + peringatan overfitting.
- Bandingkan 2 hasil backtest berdampingan.

### F5 — Akun & jurnal
- Login nickname/magic link.
- Simpan sesi replay, hasil backtest, strategi.
- Jurnal trade: alasan entry, screenshot chart otomatis, tag setup, emosi.
- Statistik pribadi lintas sesi.

### F6 — Duel (konsep: snapshot → keputusan → reveal)
Dua user dapat potongan chart yang sama, analisa dalam batas waktu, pasang satu keputusan, lalu hasilnya diputar ke depan bersama.

**Satu ronde:**
1. **Snapshot.** Server pilih titik potong acak (`cut`) di data. Semua candle sampai `cut` dikirim, semua timeframe boleh dipakai (multi-timeframe analysis bebas: M1 sampai D1).
2. **Analisa.** Timer bersama, misal 60–120 detik (diatur pembuat duel).
3. **Keputusan**, salah satu:
   - Buy atau Sell (market di harga `cut`, opsional limit), **SL wajib**, TP opsional.
   - **Skip**: tidak ambil trade, hasil 0R. Skip itu skill juga.
   - Timer habis tanpa keputusan = skip otomatis.
4. **Reveal.** Setelah dua pemain submit atau timer habis, order keduanya ditampilkan di chart.
5. **Run.** Candle setelah `cut` diputar cepat sampai jendela maksimal (misal 1–2 jam waktu market = 60–120 candle M1). Posisi tutup di SL, TP, atau harga close di akhir jendela (timeout). Limit yang tidak tersentuh = tidak ada trade.

**Satu duel = beberapa ronde** (misal 5), tiap ronde titik potong berbeda. Pemenang = total R terbanyak.

**Skor pakai R (kelipatan risiko), bukan dolar:**
- 1R = jarak entry ke SL. Kena SL = -1R, kena TP 3x jarak SL = +3R, timeout = R sesuai harga close.
- Spread dari data dihitung sebagai biaya.
- Skor kebal terhadap normalisasi harga dan ukuran lot. Tidak ada keuntungan dari lot besar.
- SL minimal, misal 0.5 × ATR(14) M1 atau 3 × spread, supaya SL super tipis tidak jadi lotre R besar.

**Normalisasi harga (sembunyikan range asli):**
- Harga di-rebase: `p' = (p - anchor) × k + 1000`, dengan `anchor` = close di `cut` dan `k` faktor skala acak per ronde (misal 0.7–1.4).
- Bentuk candle, rasio, dan indikator tetap sama secara relatif. Angka harga tidak bisa dicocokkan dengan XAUUSD asli.
- Tanggal disembunyikan. Jam sesi (Asia/London/NY) tetap tampil karena penting untuk emas. Opsi mode hardcore: jam juga disembunyikan.
- Indikator dihitung setelah normalisasi. Semua indikator invariant terhadap transformasi linear, kecuali yang pakai nilai absolut (ATR dalam dolar), yang ikut terskala konsisten.

**Anti-curang:**
- **Candle setelah `cut` tidak pernah dikirim** sebelum dua keputusan terkunci di server.
- **Candle timeframe besar yang sedang berjalan dibangun dari M1 sampai `cut` saja.** Kalau tidak, candle H4/D1 yang sudah "jadi" membocorkan high/low masa depan.
- Timer divalidasi di server (timestamp kirim snapshot vs timestamp submit).
- Server hitung hasil sendiri dengan engine yang sama. Angka dari client tidak dipercaya.

**Mode:**
- **Live:** dua pemain online, room code, WebSocket. Timer jalan bersama, reveal dan run ditonton bersama.
- **Async:** pemain A main dulu, kirim link. B dapat ronde yang sama (`cut` + `k` sama), timer tetap ditegakkan server. Hasil keduanya ditampilkan setelah B selesai.
- Mode solo (latihan) memakai alur yang sama tanpa lawan, dan jadi bahan daily challenge.

**Parameter duel (diatur pembuat):** jumlah ronde, waktu analisa, jendela run (menit), timeframe default yang dibuka, mode hardcore.

### F7 — Duel lanjutan
- Matchmaking antrian acak (selain room code).
- Lebih dari 2 pemain dalam satu room (battle royale ronde).
- Opsi manajemen posisi saat run: geser SL ke breakeven atau close manual (run diperlambat, server tetap pegang candle).
- Replay duel lama: lihat keputusan kedua pemain + chart asli (tanggal dan harga asli dibuka setelah duel selesai).

### F8 — Komunitas & belajar
- Leaderboard mingguan (dari duel dan "daily challenge": semua orang main potongan chart yang sama hari itu).
- Rating ELO dari duel.
- Materi belajar singkat: candlestick, support/resistance, sesi pasar emas, manajemen risiko, tiap materi ada latihan replay.
- Share hasil (gambar equity curve + statistik).

## Model data server (draft)

```
users(id, nickname, email?, created_at)
duels(id, mode[async|live], rounds, analysis_sec, run_minutes, rules_json,
      status, created_by, created_at)
duel_rounds(duel_id, round_no, cut_index, scale_k, revealed_at)
duel_players(duel_id, user_id, status, total_r, finished_at)
duel_decisions(duel_id, round_no, user_id, side[buy|sell|skip], entry_type,
      entry, sl, tp, snapshot_sent_at, submitted_at, result_r, exit_reason)
backtests(id, user_id, strategy_json, params_json, result_json, created_at)
journal(id, user_id, session_ref, note, tags, screenshot_url, created_at)
```

## Urutan kerja

1. F0 + F1: data masuk, chart tampil. Bisa dipakai sendiri.
2. F2 + F3: indikator + bar replay. Ini inti belajar.
3. F4: backtest otomatis.
4. F5 + F6: server, akun, duel async.
5. F7: duel live.
6. F8: leaderboard, rating, materi.

Engine eksekusi order (F3) ditulis sekali di TypeScript dan dipakai di client, Worker backtest, dan server duel. Hasilnya identik di semua tempat.

## Pertanyaan terbuka
- Pakai satu broker MT5 saja? Spread dan tick_volume beda antar broker.
- Data ditambah rutin (update mingguan) atau tetap 3 bulan?
- Duel: berapa ronde default, berapa detik analisa, berapa jam jendela run?
- Duel: entry cuma market, atau limit/stop juga boleh?
- Duel: ada manajemen posisi saat run (geser SL, close manual) atau murni set-and-forget?
- Hosting: VPS yang sudah ada atau baru?
