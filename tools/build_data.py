"""Validate raw M1 Parquet files and build the timeframe pyramid for the web app.

Input:  data/raw/XAUUSD_M1_YYYY-MM.parquet, data/raw/symbol.json
Output: data/build/
          M1/YYYY-MM.parquet                 one file per month
          M5|M15|M30|H1/YYYY.parquet         one file per year
          H4|D1/all.parquet                  single file
          manifest.json                      file list + ranges + schema

Higher timeframes are aggregated from M1 on UTC boundaries (H4 at 00/04/08.. UTC).
D1 uses the gold trading day: 17:00 New York to 17:00 New York (DST aware).
The browser loads only the files it needs: zoomed-out charts use H4/D1 without touching M1.
Replay/duel must NOT use these prebuilt higher-TF files for the forming candle at the cut;
they rebuild it from M1 up to the cut so future high/low never leaks.

Usage: python tools/build_data.py [--strict]
  --strict  exit with code 1 if validation finds errors
"""
import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from candles_io import SCHEMA, read_candles, write_candles

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
BUILD = ROOT / "data" / "build"

# timeframe -> (seconds, file grouping)
PYRAMID = {
    "M5": (300, "year"),
    "M15": (900, "year"),
    "M30": (1800, "year"),
    "H1": (3600, "year"),
    "H4": (14400, "all"),
    "D1": (86400, "all"),
}


def is_expected_gap(t0, t1):
    """Gold CFD closes daily ~21:00-23:00 UTC (DST dependent) and from Friday close to Sunday open."""
    a = datetime.fromtimestamp(t0, timezone.utc)
    b = datetime.fromtimestamp(t1, timezone.utc)
    if a.weekday() == 4 and b.weekday() == 6:  # weekend
        return True
    if 20 <= a.hour <= 22 and (t1 - t0) <= 3 * 3600:  # daily break
        return True
    return False


def validate(df, tag):
    issues, errors = [], 0
    dup = int(df["time"].duplicated().sum())
    if dup:
        issues.append(f"{dup} duplicate timestamps")
        errors += dup
    if not df["time"].is_monotonic_increasing:
        issues.append("timestamps not sorted")
        errors += 1
    if (df["time"] % 60 != 0).any():
        issues.append("timestamps not aligned to minute")
        errors += 1
    oc_max = df[["open", "close"]].max(axis=1)
    oc_min = df[["open", "close"]].min(axis=1)
    bad_hl = (df["high"] < oc_max) | (df["low"] > oc_min)
    if bad_hl.any():
        issues.append(f"{int(bad_hl.sum())} bars with high/low outside open/close")
        errors += int(bad_hl.sum())
    if (df[["open", "high", "low", "close"]] <= 0).any().any():
        issues.append("non-positive prices")
        errors += 1

    # warnings: data still usable
    t = df["time"].astype("int64").to_numpy()
    gaps = pd.Series(t[1:] - t[:-1])
    unexpected = [
        (int(t[i]), int(t[i + 1]))
        for i in gaps[gaps > 300].index
        if not is_expected_gap(int(t[i]), int(t[i + 1]))
    ]
    if unexpected:
        issues.append(f"warn: {len(unexpected)} unexpected gaps > 5 min")
        for t0, t1 in unexpected[:5]:
            a = datetime.fromtimestamp(t0, timezone.utc)
            issues.append(f"warn:   {a:%Y-%m-%d %a %H:%M} UTC  +{(t1 - t0) // 60} min")
    zero_vol = int((df["tick_volume"] == 0).sum())
    if zero_vol:
        issues.append(f"warn: {zero_vol} bars with tick_volume 0")
    spikes = int((df["close"].astype("int64").pct_change().abs() > 0.01).sum())
    if spikes:
        issues.append(f"warn: {spikes} bars with |close change| > 1%")

    print(f"  {tag}: {len(df)} bars, errors={errors}")
    for s in issues:
        print(f"    {s}")
    return errors


def trading_day_bucket(times):
    """Gold trading day starts 17:00 New York (handles DST), so Sunday's open joins Monday."""
    ny = pd.to_datetime(times.astype("int64"), unit="s", utc=True).dt.tz_convert("America/New_York")
    start = (ny + pd.Timedelta(hours=7)).dt.floor("D") - pd.Timedelta(hours=7)
    # floor("D") on tz-aware values can land on an ambiguous/nonexistent local time; 17:00 never does
    return (start.dt.tz_convert("UTC").astype("int64") // 10**9).to_numpy()


def resample(m1, seconds):
    df = m1.copy()
    if seconds == 86400:
        df["bucket"] = trading_day_bucket(df["time"])
    else:
        df["bucket"] = (df["time"].astype("int64") // seconds) * seconds
    g = df.groupby("bucket", sort=True)
    out = pd.DataFrame({
        "time": g["bucket"].first(),
        "open": g["open"].first(),
        "high": g["high"].max(),
        "low": g["low"].min(),
        "close": g["close"].last(),
        "tick_volume": g["tick_volume"].sum(),
        "spread": g["spread"].min(),
    })
    return out.reset_index(drop=True)


def entry(path, df):
    return {
        "file": path.relative_to(BUILD).as_posix(),
        "bars": int(len(df)),
        "from": int(df["time"].iloc[0]),
        "to": int(df["time"].iloc[-1]),
        "bytes": path.stat().st_size,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()

    meta = json.loads((RAW / "symbol.json").read_text())
    files = sorted(RAW.glob("XAUUSD_M1_*.parquet"))
    if not files:
        raise SystemExit("no raw Parquet files, run tools/export_mt5.py first")

    if BUILD.exists():
        shutil.rmtree(BUILD)
    timeframes = {"M1": []}
    total_errors = 0
    months = []

    print("validate:")
    for f in files:
        tag = f.stem.split("_")[-1]
        df = read_candles(f)
        total_errors += validate(df, tag)
        df = df.drop_duplicates("time").sort_values("time").reset_index(drop=True)
        out = BUILD / "M1" / f"{tag}.parquet"
        write_candles(df, out)
        timeframes["M1"].append(entry(out, df))
        months.append(df)

    m1 = pd.concat(months, ignore_index=True)
    years = pd.to_datetime(m1["time"].astype("int64"), unit="s", utc=True).dt.year

    print("pyramid:")
    for tf, (sec, group) in PYRAMID.items():
        timeframes[tf] = []
        if group == "year":
            for y in sorted(years.unique()):
                part = resample(m1[years == y], sec)
                out = BUILD / tf / f"{y}.parquet"
                write_candles(part, out)
                timeframes[tf].append(entry(out, part))
        else:
            part = resample(m1, sec)
            out = BUILD / tf / "all.parquet"
            write_candles(part, out)
            timeframes[tf].append(entry(out, part))
        n = sum(e["bars"] for e in timeframes[tf])
        kb = sum(e["bytes"] for e in timeframes[tf]) / 1024
        print(f"  {tf:>3}: {n:>6} bars  {kb:7.1f} KB")

    manifest = {
        "symbol": "XAUUSD",
        "source_symbol": meta["symbol"],
        "digits": meta["digits"],
        "point": meta["point"],
        "price_encoding": "integer points: price = value * point",
        "time": "unix seconds UTC, bar open time",
        "d1_session": "D1 bar = gold trading day from 17:00 America/New_York; its time is that start, "
                      "so the calendar date shown to users is the next day",
        "columns": [{"name": f.name, "type": str(f.type)} for f in SCHEMA],
        "timeframes": timeframes,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (BUILD / "manifest.json").write_text(json.dumps(manifest, indent=2))

    size = sum(e["bytes"] for tf in timeframes.values() for e in tf)
    print(f"build: {len(m1)} M1 bars, all files {size / 1e6:.2f} MB -> {BUILD}")
    if args.strict and total_errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
