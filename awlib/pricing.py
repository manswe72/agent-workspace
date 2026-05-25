"""Per-model token pricing + per-usage cost estimator.

Defaults baked in; overridden via ~/.config/agent-workspace/pricing.json
(partial overrides merge on top of defaults). Cached on first call.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

HOME = Path.home()
_CONFIG_PATH = HOME / ".config" / "agent-workspace" / "pricing.json"

# Default per-Mtok pricing in USD. Override by writing
# ~/.config/agent-workspace/pricing.json with the same shape — partial
# overrides merge on top of defaults.
DEFAULT_PRICING: dict[str, dict[str, float]] = {
    "default":           {"in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75},
    "claude-opus-4-7":   {"in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75},
    "claude-opus-4-6":   {"in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75},
    "claude-opus-4-5":   {"in": 15.00, "out": 75.00, "cache_r": 1.50, "cache_w": 18.75},
    "claude-sonnet-4-6": {"in":  3.00, "out": 15.00, "cache_r": 0.30, "cache_w":  3.75},
    "claude-haiku-4-5":  {"in":  1.00, "out":  5.00, "cache_r": 0.10, "cache_w":  1.25},
}

_PRICING_CACHE: dict | None = None

# Caller wires in a logger so this module stays import-cycle-free.
# A no-op default keeps the module usable standalone.
_log: Callable[..., None] = lambda *a, **k: None


def configure_logger(log_fn: Callable[..., None]) -> None:
    """Plug a structured-log function (e.g. awlib.logbuf.log_event)
    so override-config load failures get reported through the usual
    channel."""
    global _log
    _log = log_fn


def load_pricing() -> dict:
    """Pricing per model. First call loads + caches; subsequent calls
    return the cached dict."""
    global _PRICING_CACHE
    if _PRICING_CACHE is not None:
        return _PRICING_CACHE
    pricing = {k: dict(v) for k, v in DEFAULT_PRICING.items()}
    cfg = _CONFIG_PATH
    if cfg.is_file():
        try:
            override = json.loads(cfg.read_text())
            for model, rates in override.items():
                base = pricing.get(model, dict(pricing["default"]))
                base.update({k: float(v) for k, v in rates.items()
                             if k in ("in", "out", "cache_r", "cache_w")})
                pricing[model] = base
        except (OSError, ValueError) as ex:
            _log("warn", "pricing",
                 "failed to load override config",
                 path=str(cfg), error=str(ex))
    _PRICING_CACHE = pricing
    return pricing


def estimate_cost(model: str | None, tokens: dict) -> float:
    """USD cost estimate for a token usage dict {in,out,cache_r,cache_w}."""
    p = load_pricing()
    rates = p.get(model or "default") or p["default"]
    cost = 0.0
    for k in ("in", "out", "cache_r", "cache_w"):
        n = tokens.get(k) or 0
        cost += (n / 1_000_000.0) * rates.get(k, 0.0)
    return cost
