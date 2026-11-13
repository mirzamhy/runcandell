"""Export XAUUSD M1 candles from the local MetaTrader 5 terminal to monthly Parquet files.

Output: data/raw/XAUUSD_M1_YYYY-MM.parquet  (schema in candles_io.py, prices as integer points)
        data/raw/symbol.json                (symbol, digits, point, export time)
        data/raw/XAUUSD_M1_YYYY-MM.csv      (only with --csv, for manual checking)

Usage:
  python tools/export_mt5.py                      # last 3 months until now
  python tools/export_mt5.py --months 6
  python tools/export_mt5.py --start 2016-01-01   # as far back as the broker has history
  python tools/export_mt5.py --tz-offset 2        # if broker server clock is UTC+2

The MT5 terminal must be installed and logged in (a demo account is enough).
Exness server clock is UTC, so the default offset is 0.
"""
import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import MetaTrader5 as mt5
import pandas as pd

from candles_io import prices_to_points, read_candles, write_candles

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
DEFAULT_TERMINAL = r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe"
SYMBOL_CANDIDATES = ["XAUUSD", "XAUUSDc", "XAUUSDm", "XAUUSDz"]


def pick_symbol(preferred):
    names = [s.name for s in mt5.symbols_get() or []]
    if preferred:
        if preferred not in names:
            raise SystemExit(f"symbol {preferred} not found")
        return preferred
    for cand in SYMBOL_CANDIDATES:
        if cand in names:
            return cand
    gold = [n for n in names if n.upper().startswith("XAUUSD")]
    if not gold:
        raise SystemExit(f"no XAUUSD symbol among {len(names)} symbols")
    return gold[0]


def month_chunks(start, end):
    cur = start
    while cur < end:
        nxt = (cur.replace(day=1) + timedelta(days=32)).replace(day=1, hour=0, minute=0, second=0)
        yield cur, min(nxt, end)
        cur = nxt


def fetch(sym, a, b, tz_offset_h):
    # The MetaTrader5 package treats naive datetimes as local PC time, so pass tz-aware UTC.
    off = timedelta(hours=tz_offset_h)
    a_utc = (a + off).replace(tzinfo=timezone.utc)
    b_utc = (b + off).replace(tzinfo=timezone.utc)
    r = None
    for _ in range(6):  # old history downloads asynchronously, retry a few times
        r = mt5.copy_rates_range(sym, mt5.TIMEFRAME_M1, a_utc, b_utc)
        if r is not None and len(r) > 0:
            break
        time.sleep(2)
    if r is None or len(r) == 0:
        return None
    df = pd.DataFrame(r)
    df["time"] = df["time"] - int(off.total_seconds())  # server clock -> UTC
    # copy_rates_range includes both ends: keep [a, b) so month files don't overlap
    # and the still-forming bar at "now" is left out.
    lo = int(a.replace(tzinfo=timezone.utc).timestamp())
    hi = int(b.replace(tzinfo=timezone.utc).timestamp())
    df = df[(df["time"] >= lo) & (df["time"] < hi)]
    if df.empty:
        return None
    return df[["time", "open", "high", "low", "close", "tick_volume", "spread"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--start", help="YYYY-MM-DD (UTC)")
    ap.add_argument("--end", help="YYYY-MM-DD (UTC), default now")
    ap.add_argument("--symbol")
    ap.add_argument("--terminal", default=DEFAULT_TERMINAL)
    ap.add_argument("--tz-offset", type=float, default=0.0, help="broker server clock minus UTC, hours")
    ap.add_argument("--csv", action="store_true", help="also write CSV copies for manual checking")
    args = ap.parse_args()

    now = datetime.now(timezone.utc).replace(tzinfo=None, second=0, microsecond=0)
    end = datetime.fromisoformat(args.end) if args.end else now
    start = datetime.fromisoformat(args.start) if args.start else end - timedelta(days=31 * args.months)

    if not mt5.initialize(path=args.terminal):
        raise SystemExit(f"MT5 initialize failed: {mt5.last_error()}")
    try:
        info = mt5.terminal_info()
        sym = pick_symbol(args.symbol)
        mt5.symbol_select(sym, True)
        si = mt5.symbol_info(sym)
        print(f"terminal connected={info.connected} maxbars={info.maxbars}")
        print(f"symbol={sym} digits={si.digits} point={si.point}")
        print(f"range UTC {start} .. {end}")

        RAW.mkdir(parents=True, exist_ok=True)
        total = 0
        for a, b in month_chunks(start, end):
            df = fetch(sym, a, b, args.tz_offset)
            tag = a.strftime("%Y-%m")
            if df is None:
                print(f"  {tag}: no data ({mt5.last_error()})")
                continue
            df = prices_to_points(df, si.point)
            path = RAW / f"XAUUSD_M1_{tag}.parquet"
            if path.exists():  # merge with an earlier export of the same month
                df = pd.concat([read_candles(path), df]).drop_duplicates("time", keep="last")
            write_candles(df, path)
            if args.csv:
                c = df.sort_values("time").copy()
                for col in ["open", "high", "low", "close"]:
                    c[col] = (c[col] * si.point).round(si.digits)
                c.to_csv(RAW / f"XAUUSD_M1_{tag}.csv", index=False)
            first = datetime.fromtimestamp(int(df.time.min()), timezone.utc)
            last = datetime.fromtimestamp(int(df.time.max()), timezone.utc)
            kb = path.stat().st_size / 1024
            print(f"  {tag}: {len(df):>6} bars  {first:%Y-%m-%d %H:%M} .. {last:%Y-%m-%d %H:%M} UTC  {kb:.0f} KB")
            total += len(df)

        meta = {
            "symbol": sym,
            "digits": si.digits,
            "point": si.point,
            "tz_offset_hours": args.tz_offset,
            "exported_at": now.isoformat() + "Z",
        }
        (RAW / "symbol.json").write_text(json.dumps(meta, indent=2))
        print(f"total bars: {total}")
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
