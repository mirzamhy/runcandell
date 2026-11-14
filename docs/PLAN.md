# runcandell — Planning Fitur

Tempat belajar trading XAUUSD gratis: chart mirip TradingView, bar replay, backtest, dan duel antar user di chart yang sama.

Data: XAUUSD M1 dari MetaTrader 5 (gratis), mulai 1 tahun (akun Exness standar, simbol `XAUUSD`, spread mengambang). Field: `time` (UTC), `open`, `high`, `low`, `close`, `tick_volume`, `spread`.

## Stack

| Bagian | Pilihan | Alasan |
|---|---|---|
| Export data | Python + package `MetaTrader5` | gratis, langsung dari terminal MT5 |
| Simpan data | Parquet (int point + delta + zstd), piramida timeframe | ±8 B/candle, 10 tahun ±29 MB |
| Baca data di browser | `hyparquet` + `fzstd` | file statis via CDN, VPS tidak terbebani |
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

### F5 — Akun & jurnal (selesai; login Google ada, magic link email belum)
- Login nickname + kode pemulihan. Magic link email belum (butuh layanan kirim email).
- Simpan sesi replay, hasil backtest, strategi.
- Jurnal trade: alasan entry, screenshot chart otomatis, tag setup, emosi.
- Statistik pribadi lintas sesi.

### F6 — Duel (mode async + latihan selesai; live pindah ke F7)
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

### F9 — Candle realtime (saat deploy)
Tujuan: chart di web ikut bergerak seperti di MT5, untuk semua pair. Data historis tetap Parquet; realtime hanya menambal ujungnya.

**Sumber: MT5 yang sama dengan data historis** (Exness). Harga, spread, dan jam candle konsisten dengan 5 tahun data yang sudah ada. API pihak ketiga (Twelve Data, Polygon, dll.) tidak dipakai: harga dan spread beda dari broker, candle realtime tidak akan nyambung dengan histori.

```
[Windows VPS: MT5 + live_feed.py] --HTTPS POST tiap 1 dtk--> [server Hono] --SSE--> [browser]
                                                          \-> SQLite live_m1 (tambalan sejak build terakhir)
[cron harian: export_mt5 --start <bulan ini> + build_data] --> Parquet baru, live_m1 lama dipangkas
```

- **Feeder** `tools/live_feed.py` jalan di sebelah MT5 (package `MetaTrader5` hanya untuk Windows; di Linux lihat poin Linux di bawah). Tiap ±1 dtk per pair: `symbol_info_tick` (bid/ask) + `copy_rates_from_pos(M1, 0, 2)` (candle terbentuk + candle yang baru tutup). Kirim batch ke `POST /api/feed` dengan token rahasia (`Authorization: Bearer`, env `RC_FEED_TOKEN`). Setelah restart: kirim ulang M1 sejak waktu terakhir yang diterima server (`GET /api/feed/last`), jadi tidak ada lubang.
- **Server**: simpan M1 yang sudah tutup di tabel `live_m1(symbol, time, o, h, l, c, v, spread)`; candle terbentuk + tick terakhir di memori. Endpoint:
  - `GET /api/live/:sym/bars?since=` — M1 setelah ujung Parquet (`manifest.to`).
  - `GET /api/live/:sym/stream` — SSE (`streamSSE` Hono): `tick` (bid/ask) dan `bar` (M1 terbentuk/tutup), maks ±2×/dtk. SSE dipilih karena satu arah, lolos reverse proxy biasa, reconnect otomatis.
- **Browser**: setelah chunk Parquet terakhir dimuat, ambil tambalan `bars?since=`, rakit ke TF aktif (pakai `aggregate` yang sama dengan duel), lalu subscribe stream dan `candles.update` ekor saja (jalur inkremental replay sudah ada, indikator ikut). Garis Bid/Ask, legend, dan judul tab ikut harga live. Tanda "LIVE" + status koneksi (hijau / abu saat pasar tutup / merah saat putus).
- **Malam hari** (cron di VPS, mis. 00:10 UTC): export bulan berjalan + build, server baca manifest baru, `live_m1` sebelum `manifest.to` dihapus.
- **Duel tidak berubah**: titik potong tetap diambil dari data historis, minimal 2 hari sebelum ujung data, jadi pasar live tidak bisa dipakai menebak hasil ronde.
- **Linux**: MT5 bisa jalan di Wine (ada image Docker komunitas, MT5 + VNC). Feeder lalu salah satu dari: (a) Python Windows di dalam Wine yang sama, atau jembatan `mt5linux` (Python Linux memanggil package `MetaTrader5` di Wine lewat RPyC); (b) Expert Advisor MQL5 di MT5 yang mengirim `WebRequest` ke `/api/feed` (tanpa Python, URL server wajib di-whitelist di MT5). Pilihan (b) paling sedikit bagian bergerak. Butuh ±2 GB RAM. Kekurangan Wine: update MT5 kadang merusak, perlu cek otomatis "data terakhir > 2 menit = alarm".
- **Biaya**: Linux VPS 2 GB (±$5–12/bulan, server web + MT5 Wine satu mesin), atau Windows VPS ±$10–20/bulan (paling stabil untuk MT5), atau PC sendiri yang menyala 24 jam selama masa uji.
- **Cek dulu sebelum publik**: syarat broker soal menampilkan ulang data harga mereka di website umum.

Opsi lanjutan: paper trading di harga live (forward test, akun terpisah dari replay); alert harga.

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
- Hosting: VPS yang sudah ada atau baru? Untuk F9: Linux + MT5 di Wine, Windows VPS, atau feeder di PC sendiri dan server di VPS Linux.
