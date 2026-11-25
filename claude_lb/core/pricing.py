"""Model price table, used to attribute a USD cost to each proxied request.

Prices are USD per million tokens at Anthropic's published first-party API rates.

Cache writes bill as a multiple of the input price: 1.25x for the default 5-minute
TTL, 2x for the 1-hour TTL. Cache reads used to be a flat 0.1x of input, but newer
models price them separately (0.05x on Opus 5.5 / Sonnet 5.5, 0.025x on Fable 5.1+),
so each entry may carry its own cache-read rate.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

CACHE_WRITE_5M_MULTIPLIER = 1.25
CACHE_WRITE_1H_MULTIPLIER = 2.0
DEFAULT_CACHE_READ_MULTIPLIER = 0.1


@dataclass(frozen=True)
class ModelPrice:
    input_per_mtok: float
    output_per_mtok: float
    cache_read_per_mtok: float | None = None
    """Explicit cache-read rate; ``None`` means 0.1x input."""
    long_context_threshold: int | None = None
    """Prompt size (input + cache tokens) above which ``long_context`` applies."""
    long_context: ModelPrice | None = None

    @property
    def cache_read_rate(self) -> float:
        if self.cache_read_per_mtok is not None:
            return self.cache_read_per_mtok
        return self.input_per_mtok * DEFAULT_CACHE_READ_MULTIPLIER

    def for_prompt(self, prompt_tokens: int) -> ModelPrice:
        if self.long_context is not None and self.long_context_threshold is not None:
            if prompt_tokens > self.long_context_threshold:
                return self.long_context
        return self


# Keys are bare model ids. Lookup takes the longest matching prefix, so dated snapshots
# (claude-haiku-4-5-20251001), Vertex "@" versions, and point releases that are not
# listed resolve to their family. List a point release whenever its price differs from
# the family's, or the prefix match will silently charge the family rate.
PRICES: dict[str, ModelPrice] = {
    "claude-fable-5-2": ModelPrice(8.00, 40.00, cache_read_per_mtok=0.20),
    "claude-mythos-5-2": ModelPrice(8.00, 40.00, cache_read_per_mtok=0.20),
    "claude-fable-5-1": ModelPrice(10.00, 50.00, cache_read_per_mtok=0.25),
    "claude-mythos-5-1": ModelPrice(10.00, 50.00, cache_read_per_mtok=0.25),
    "claude-fable-5": ModelPrice(10.00, 50.00, cache_read_per_mtok=1.00),
    "claude-mythos-5": ModelPrice(10.00, 50.00, cache_read_per_mtok=1.00),
    "claude-opus-5-5": ModelPrice(4.00, 20.00, cache_read_per_mtok=0.20),
    "claude-opus-5": ModelPrice(5.00, 25.00),
    "claude-opus-4-8": ModelPrice(5.00, 25.00),
    "claude-opus-4-7": ModelPrice(5.00, 25.00),
    "claude-opus-4-6": ModelPrice(5.00, 25.00),
    "claude-opus-4-5": ModelPrice(5.00, 25.00),
    "claude-sonnet-5-5": ModelPrice(2.00, 10.00, cache_read_per_mtok=0.10),
    "claude-sonnet-5": ModelPrice(2.00, 10.00),
    "claude-sonnet-4-6": ModelPrice(3.00, 15.00),
    "claude-sonnet-4-5": ModelPrice(3.00, 15.00),
    "claude-haiku-5-5": ModelPrice(
        0.10,
        0.50,
        long_context_threshold=100_000,
        long_context=ModelPrice(0.50, 2.50),
    ),
    "claude-haiku-4-5": ModelPrice(1.00, 5.00),
}

_UNKNOWN = ModelPrice(0.0, 0.0)
_warned_unknown: set[str] = set()


def _normalize(model: str) -> str:
    # Bedrock ids carry a provider prefix and sometimes a region in front of it:
    # "anthropic.claude-…", "us.anthropic.claude-…", "global.anthropic.claude-…".
    _, sep, rest = model.partition("anthropic.")
    return rest if sep else model


def lookup(model: str | None) -> ModelPrice:
    if not model:
        return _UNKNOWN
    normalized = _normalize(model)
    if normalized in PRICES:
        return PRICES[normalized]
    best: ModelPrice | None = None
    best_len = 0
    for key, price in PRICES.items():
        if normalized.startswith(key) and len(key) > best_len:
            best, best_len = price, len(key)
    return best or _UNKNOWN


def is_priced(model: str | None) -> bool:
    return lookup(model) is not _UNKNOWN


def estimate_cost_usd(
    model: str | None,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cache_creation_input_tokens: int = 0,
    cache_read_input_tokens: int = 0,
    cache_creation_1h_input_tokens: int = 0,
) -> float:
    """USD cost of one response.

    ``cache_creation_1h_input_tokens`` is the 1-hour-TTL share of
    ``cache_creation_input_tokens`` (Anthropic reports the total and the breakdown),
    not an addition to it.
    """
    price = lookup(model)
    if price is _UNKNOWN:
        if model and model not in _warned_unknown:
            _warned_unknown.add(model)
            logger.warning("no price for model %r; its spend is recorded as $0", model)
        return 0.0

    prompt_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
    price = price.for_prompt(prompt_tokens)

    write_1h = min(cache_creation_1h_input_tokens, cache_creation_input_tokens)
    write_5m = cache_creation_input_tokens - write_1h
    input_cost = (
        input_tokens + write_5m * CACHE_WRITE_5M_MULTIPLIER + write_1h * CACHE_WRITE_1H_MULTIPLIER
    ) * price.input_per_mtok
    cache_read_cost = cache_read_input_tokens * price.cache_read_rate
    output_cost = output_tokens * price.output_per_mtok
    return (input_cost + cache_read_cost + output_cost) / 1_000_000


def cache_read_savings_usd(model: str | None, cache_read_input_tokens: int, prompt_tokens: int = 0) -> float:
    """What the cache reads would have cost as uncached input, minus what they did cost."""
    price = lookup(model)
    if price is _UNKNOWN or cache_read_input_tokens <= 0:
        return 0.0
    price = price.for_prompt(prompt_tokens)
    return cache_read_input_tokens * (price.input_per_mtok - price.cache_read_rate) / 1_000_000
