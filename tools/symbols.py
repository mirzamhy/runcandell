"""Instruments the app offers. Name = what users see; sources = broker symbol names to try, in order.

d1: where a daily candle starts.
  ny17  17:00 New York (gold, FX, index CFDs: the broker's trading day)
  utc   00:00 UTC (crypto trades 24/7)
"""

SYMBOLS = {
    "XAUUSD": {"label": "Emas / USD", "sources": ["XAUUSD", "XAUUSDm", "XAUUSDc"], "d1": "ny17"},
    "EURUSD": {"label": "Euro / USD", "sources": ["EURUSD", "EURUSDm"], "d1": "ny17"},
    "USDJPY": {"label": "USD / Yen", "sources": ["USDJPY", "USDJPYm"], "d1": "ny17"},
    "US100": {"label": "Nasdaq 100", "sources": ["USTEC", "US100", "NAS100", "USTECm"], "d1": "ny17"},
    "BTCUSD": {"label": "Bitcoin / USD", "sources": ["BTCUSD", "BTCUSDm"], "d1": "utc"},
}
