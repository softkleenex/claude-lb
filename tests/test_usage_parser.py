from __future__ import annotations

import pytest

from app.core.pricing import cache_read_savings_usd, estimate_cost_usd, lookup
from app.modules.proxy.usage_parser import StreamUsageCollector, parse_json_usage

SSE = (
    b"event: message_start\n"
    b'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5",'
    b'"usage":{"input_tokens":120,"cache_read_input_tokens":900,"output_tokens":1}}}\n\n'
    b"event: content_block_delta\n"
    b'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'
    b"event: message_delta\n"
    b'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}\n\n'
    b"event: message_stop\n"
    b'data: {"type":"message_stop"}\n\n'
)


class TestStreamUsageCollector:
    def test_extracts_usage_from_a_whole_stream(self):
        collector = StreamUsageCollector()
        collector.feed(SSE)
        collector.close()

        assert collector.usage.model == "claude-opus-5"
        assert collector.usage.input_tokens == 120
        assert collector.usage.cache_read_input_tokens == 900
        assert collector.usage.output_tokens == 57

    def test_handles_chunk_boundaries_mid_line(self):
        collector = StreamUsageCollector()
        for i in range(0, len(SSE), 7):  # split at an offset that lands mid-JSON
            collector.feed(SSE[i : i + 7])
        collector.close()
        assert collector.usage.output_tokens == 57
        assert collector.usage.input_tokens == 120

    def test_output_tokens_takes_the_running_maximum_not_a_sum(self):
        collector = StreamUsageCollector()
        collector.feed(b'data: {"type":"message_delta","usage":{"output_tokens":10}}\n')
        collector.feed(b'data: {"type":"message_delta","usage":{"output_tokens":25}}\n')
        collector.close()
        assert collector.usage.output_tokens == 25

    def test_malformed_json_is_skipped(self):
        collector = StreamUsageCollector()
        collector.feed(b"data: {not json\n")
        collector.feed(b'data: {"usage":{"output_tokens":5}}\n')
        collector.close()
        assert collector.usage.output_tokens == 5

    def test_done_sentinel_is_ignored(self):
        collector = StreamUsageCollector()
        collector.feed(b"data: [DONE]\n")
        collector.close()
        assert collector.usage.output_tokens == 0

    def test_empty_stream_yields_zero_usage(self):
        collector = StreamUsageCollector()
        collector.close()
        assert collector.usage.as_dict() == {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        }


class TestJsonUsage:
    def test_parses_a_non_streaming_response(self):
        body = (
            b'{"id":"msg_1","model":"claude-sonnet-5","content":[{"type":"text","text":"hi"}],'
            b'"usage":{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":5}}'
        )
        usage = parse_json_usage(body)
        assert usage.model == "claude-sonnet-5"
        assert usage.input_tokens == 10
        assert usage.output_tokens == 20
        assert usage.cache_creation_input_tokens == 5

    def test_error_body_yields_empty_usage(self):
        usage = parse_json_usage(b'{"type":"error","error":{"type":"not_found_error"}}')
        assert usage.input_tokens == 0
        assert usage.model is None

    def test_non_json_body_does_not_raise(self):
        assert parse_json_usage(b"<html>502</html>").output_tokens == 0


class TestPricing:
    def test_exact_model_id(self):
        assert lookup("claude-opus-5").input_per_mtok == 5.00

    def test_dated_snapshot_resolves_by_prefix(self):
        assert lookup("claude-haiku-4-5-20251001").output_per_mtok == 5.00

    def test_bedrock_prefix_is_stripped(self):
        assert lookup("anthropic.claude-sonnet-4-6").input_per_mtok == 3.00

    def test_bedrock_region_prefix_is_stripped(self):
        assert lookup("us.anthropic.claude-opus-4-8").input_per_mtok == 5.00
        assert lookup("global.anthropic.claude-haiku-4-5-20251001").input_per_mtok == 1.00

    def test_point_release_is_not_charged_the_family_rate(self):
        # The prefix match used to bill these at the older family's price.
        assert lookup("claude-opus-5-5").input_per_mtok == 4.00
        assert lookup("claude-sonnet-5-5").input_per_mtok == 2.00
        assert lookup("claude-fable-5-2").input_per_mtok == 8.00

    def test_current_haiku_is_priced(self):
        # It had no entry at all, so its spend was recorded as $0.
        assert estimate_cost_usd("claude-haiku-5-5", input_tokens=100_000) == pytest.approx(
            100_000 * 0.10 / 1e6
        )

    def test_haiku_long_context_tier(self):
        cost = estimate_cost_usd("claude-haiku-5-5", input_tokens=200_000, output_tokens=1_000_000)
        assert cost == pytest.approx(200_000 * 0.50 / 1e6 + 2.50)

    def test_unknown_model_costs_zero_rather_than_guessing(self):
        assert estimate_cost_usd("some-future-model", input_tokens=1_000_000) == 0.0

    def test_cost_applies_cache_multipliers(self):
        # 1M input @ $5 + 1M cache-write @ 1.25x + 1M cache-read @ 0.1x + 1M output @ $25
        cost = estimate_cost_usd(
            "claude-opus-5",
            input_tokens=1_000_000,
            cache_creation_input_tokens=1_000_000,
            cache_read_input_tokens=1_000_000,
            output_tokens=1_000_000,
        )
        assert cost == pytest.approx(5.0 + 6.25 + 0.5 + 25.0)

    def test_model_specific_cache_read_rate(self):
        assert estimate_cost_usd("claude-opus-5-5", cache_read_input_tokens=1_000_000) == pytest.approx(0.20)
        assert estimate_cost_usd("claude-fable-5-1", cache_read_input_tokens=1_000_000) == pytest.approx(0.25)

    def test_one_hour_cache_writes_bill_at_twice_input(self):
        cost = estimate_cost_usd(
            "claude-opus-5",
            cache_creation_input_tokens=1_000_000,
            cache_creation_1h_input_tokens=400_000,
        )
        assert cost == pytest.approx(600_000 * 5 * 1.25 / 1e6 + 400_000 * 5 * 2.0 / 1e6)

    def test_cache_read_savings(self):
        assert cache_read_savings_usd("claude-opus-5-5", 1_000_000) == pytest.approx(4.00 - 0.20)
        assert cache_read_savings_usd("some-future-model", 1_000_000) == 0.0


class TestOneHourCacheBreakdown:
    def test_json_usage_reads_the_ttl_breakdown(self):
        usage = parse_json_usage(
            b'{"model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":1,'
            b'"cache_creation_input_tokens":300,'
            b'"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}}}'
        )
        assert usage.cache_creation_input_tokens == 300
        assert usage.cache_creation_1h_input_tokens == 200
        assert "cache_creation_1h_input_tokens" not in usage.as_dict(), "it is not a stored column"
