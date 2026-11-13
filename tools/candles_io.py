"""Shared Parquet read/write for candle data.

Schema (all integers, so values are exact and delta encoding works well):
  time        uint32  unix seconds UTC, bar open time
  open/high/low/close  int32  price in points (price = value * point)
  tick_volume uint32
  spread      uint16  points (minimum spread inside the bar, as MT5 reports it)

Encoding: DELTA_BINARY_PACKED for the sorted/slow-moving columns + zstd level 19.
Measured ~8 bytes per M1 bar, about 3x smaller than CSV+gzip.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

SCHEMA = pa.schema([
    ("time", pa.uint32()),
    ("open", pa.int32()),
    ("high", pa.int32()),
    ("low", pa.int32()),
    ("close", pa.int32()),
    ("tick_volume", pa.uint32()),
    ("spread", pa.uint16()),
])
PRICE_COLS = ["open", "high", "low", "close"]
DELTA_COLS = ["time", "open", "high", "low", "close", "tick_volume"]


def prices_to_points(df, point):
    """Float prices from MT5 -> integer points."""
    out = df.copy()
    for c in PRICE_COLS:
        out[c] = np.rint(out[c].to_numpy() / point).astype("int64")
    return out


def write_candles(df, path: Path):
    df = df.sort_values("time").drop_duplicates("time", keep="last")
    table = pa.Table.from_pandas(df[SCHEMA.names], schema=SCHEMA, preserve_index=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        table,
        path,
        compression="zstd",
        compression_level=19,
        use_dictionary=["spread"],
        column_encoding={c: "DELTA_BINARY_PACKED" for c in DELTA_COLS},
        # one row group per file keeps browser reads to a single request
        row_group_size=1_000_000,
    )


def read_candles(path: Path) -> pd.DataFrame:
    return pq.read_table(path).to_pandas()


def read_many(paths) -> pd.DataFrame:
    frames = [read_candles(p) for p in paths]
    if not frames:
        return pd.DataFrame(columns=SCHEMA.names)
    return pd.concat(frames, ignore_index=True).sort_values("time").drop_duplicates("time")
