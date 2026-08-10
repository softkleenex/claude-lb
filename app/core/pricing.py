"""Model price table, used to attribute a USD cost to each proxied request.

Prices are USD per million tokens, matching Anthropic's published first-party API rates.
Cache writes bill at 1.25x input (5m TTL); cache reads at 0.1x input.
"""

from __future__ import annotations

from dataclasses import dataclass

CACHE_WRITE_MULTIPLIER = 1.25
CACHE_READ_MULTIPLIER = 0.1


@dataclass(frozen=True)
class ModelPrice:
    input_per_mtok: float
    output_per_mtok: float


# Keep keys as bare model ids. Lookup falls back to longest matching prefix so that
# dated snapshots (claude-haiku-4-5-20251001) and provider prefixes resolve too.
PRICES: dict[str, ModelPrice] = {
    "claude-fable-5": ModelPrice(10.00, 50.00),
    "claude-mythos-5": ModelPrice(10.00, 50.00),
    "claude-opus-5": ModelPrice(5.00, 25.00),
    "claude-opus-4-8": ModelPrice(5.00, 25.00),
    "claude-opus-4-7": ModelPrice(5.00, 25.00),
    "claude-opus-4-6": ModelPrice(5.00, 25.00),
    "claude-opus-4-5": ModelPrice(5.00, 25.00),
    "claude-sonnet-5": ModelPrice(3.00, 15.00),
    "claude-sonnet-4-6": ModelPrice(3.00, 15.00),
    "claude-sonnet-4-5": ModelPrice(3.00, 15.00),
    "claude-haiku-4-5": ModelPrice(1.00, 5.00),
}

_UNKNOWN = ModelPrice(0.0, 0.0)


def lookup(model: str | None) -> ModelPrice:
    if not model:
        return _UNKNOWN
    normalized = model.removeprefix("anthropic.")
    if normalized in PRICES:
        return PRICES[normalized]
    best: ModelPrice | None = None
    best_len = 0
    for key, price in PRICES.items():
        if normalized.startswith(key) and len(key) > best_len:
            best, best_len = price, len(key)
    return best or _UNKNOWN


def estimate_cost_usd(
    model: str | None,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
) -> float:
    price = lookup(model)
    if price is _UNKNOWN:
        return 0.0
    billable_input = (
        input_tokens
        + cache_creation_input_tokens * CACHE_WRITE_MULTIPLIER
        + cache_read_input_tokens * CACHE_READ_MULTIPLIER
    )
    return (billable_input * price.input_per_mtok + output_tokens * price.output_per_mtok) / 1_000_000
