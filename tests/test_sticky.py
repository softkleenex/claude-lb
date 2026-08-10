from __future__ import annotations

import json

import pytest

from app.modules.proxy import sticky
from tests.test_load_balancer import make_account


@pytest.fixture(autouse=True)
def clean_affinity():
    sticky.clear()
    yield
    sticky.clear()


def body(**overrides) -> bytes:
    payload = {
        "model": "claude-opus-5",
        "system": "You are a helpful assistant.",
        "messages": [{"role": "user", "content": "first question"}],
    }
    payload.update(overrides)
    return json.dumps(payload).encode()


class TestSessionKey:
    def test_same_prefix_yields_the_same_key(self):
        assert sticky.session_key(body()) == sticky.session_key(body())

    def test_key_survives_the_conversation_growing(self):
        """The whole point: turn 5 of a conversation must hash like turn 1."""
        turn_one = body()
        turn_five = body(
            messages=[
                {"role": "user", "content": "first question"},
                {"role": "assistant", "content": "answer"},
                {"role": "user", "content": "follow up"},
                {"role": "assistant", "content": "answer 2"},
                {"role": "user", "content": "another follow up"},
            ]
        )
        assert sticky.session_key(turn_one) == sticky.session_key(turn_five)

    def test_a_different_system_prompt_is_a_different_conversation(self):
        assert sticky.session_key(body()) != sticky.session_key(body(system="You are a poet."))

    def test_a_different_first_message_is_a_different_conversation(self):
        other = body(messages=[{"role": "user", "content": "unrelated"}])
        assert sticky.session_key(body()) != sticky.session_key(other)

    def test_changing_tools_breaks_the_cache_so_it_breaks_the_key(self):
        # Tools render at position 0 of the cached prefix, so a different tool set is a
        # different cache entry — it must not stick to the same account for cache reasons.
        with_tools = body(tools=[{"name": "search", "input_schema": {"type": "object"}}])
        assert sticky.session_key(body()) != sticky.session_key(with_tools)

    def test_different_api_keys_do_not_share_an_affinity_slot(self):
        assert sticky.session_key(body(), api_key_id="a") != sticky.session_key(body(), api_key_id="b")

    def test_key_ordering_in_the_payload_does_not_matter(self):
        a = json.dumps({"model": "m", "system": "s", "messages": [{"role": "user", "content": "x"}]})
        b = json.dumps({"messages": [{"role": "user", "content": "x"}], "system": "s", "model": "m"})
        assert sticky.session_key(a.encode()) == sticky.session_key(b.encode())

    @pytest.mark.parametrize(
        "payload",
        [b"", b"not json", b"[]", b'{"model":"m"}', b'{"model":"m","messages":[]}'],
        ids=["empty", "garbage", "array", "no-messages", "empty-messages"],
    )
    def test_unroutable_bodies_return_none(self, payload):
        assert sticky.session_key(payload) is None


class TestRendezvous:
    def test_is_deterministic(self):
        accounts = [make_account(f"a{i}") for i in range(5)]
        first = sticky.rendezvous("key", accounts)
        assert all(sticky.rendezvous("key", accounts) == first for _ in range(10))

    def test_ignores_account_ordering(self):
        accounts = [make_account(f"a{i}") for i in range(5)]
        assert sticky.rendezvous("key", accounts) == sticky.rendezvous("key", list(reversed(accounts)))

    def test_spreads_distinct_conversations_across_the_pool(self):
        accounts = [make_account(f"a{i}") for i in range(4)]
        picks = {sticky.rendezvous(f"conversation-{i}", accounts) for i in range(200)}
        assert len(picks) == 4, "every account should receive some share of conversations"

    def test_removing_an_account_only_remaps_its_own_conversations(self):
        """The property that makes rendezvous hashing worth the arithmetic."""
        accounts = [make_account(f"a{i}") for i in range(6)]
        keys = [f"conversation-{i}" for i in range(600)]
        before = {k: sticky.rendezvous(k, accounts) for k in keys}

        survivors = [a for a in accounts if a.name != "a3"]
        after = {k: sticky.rendezvous(k, survivors) for k in keys}

        moved = [k for k in keys if before[k] != after[k]]
        assert all(before[k] == "a3" for k in moved), "only conversations on the removed account move"
        # Should be roughly 1/6 of the pool, not a full reshuffle.
        assert len(moved) < len(keys) * 0.35

    def test_weight_zero_accounts_are_never_chosen(self):
        accounts = [make_account("zero", weight=0.0), make_account("normal", weight=1.0)]
        picks = {sticky.rendezvous(f"k{i}", accounts) for i in range(100)}
        assert picks == {"normal"}

    def test_heavier_accounts_win_more_conversations(self):
        accounts = [make_account("heavy", weight=9.0), make_account("light", weight=1.0)]
        picks = [sticky.rendezvous(f"conversation-{i}", accounts) for i in range(1000)]
        heavy_share = picks.count("heavy") / len(picks)
        assert 0.8 < heavy_share < 0.98, f"expected ~0.9, got {heavy_share}"

    def test_empty_pool_returns_none(self):
        assert sticky.rendezvous("key", []) is None


class TestResolveAndRemember:
    def test_remembered_account_is_returned(self):
        accounts = [make_account("a"), make_account("b")]
        sticky.remember("key", "b", ttl_seconds=60, now=1000.0)
        assert sticky.resolve("key", accounts, ttl_seconds=60, now=1001.0) == "b"

    def test_expired_affinity_falls_back_to_the_hash(self):
        accounts = [make_account("a"), make_account("b")]
        sticky.remember("key", "b", ttl_seconds=60, now=1000.0)
        resolved = sticky.resolve("key", accounts, ttl_seconds=60, now=2000.0)
        assert resolved == sticky.rendezvous("key", accounts)

    def test_affinity_to_an_unavailable_account_is_dropped(self):
        down = make_account("b", enabled=False)
        accounts = [make_account("a"), down]
        sticky.remember("key", "b", ttl_seconds=60, now=1000.0)
        assert sticky.resolve("key", accounts, ttl_seconds=60, now=1001.0) == "a"

    def test_cold_start_still_routes_consistently(self):
        """A restarted process has an empty map but must not reshuffle conversations."""
        accounts = [make_account(f"a{i}") for i in range(4)]
        first = sticky.resolve("key", accounts, ttl_seconds=60)
        sticky.clear()
        assert sticky.resolve("key", accounts, ttl_seconds=60) == first

    def test_disabled_by_zero_ttl(self):
        accounts = [make_account("a")]
        sticky.remember("key", "a", ttl_seconds=0)
        assert sticky.resolve("key", accounts, ttl_seconds=0) is None
        assert sticky.size() == 0

    def test_no_key_means_no_preference(self):
        assert sticky.resolve(None, [make_account("a")], ttl_seconds=60) is None

    def test_all_accounts_down_means_no_preference(self):
        accounts = [make_account("a", enabled=False)]
        assert sticky.resolve("key", accounts, ttl_seconds=60) is None

    def test_map_is_bounded(self):
        for i in range(sticky._MAX_ENTRIES + 250):
            sticky.remember(f"key-{i}", "a", ttl_seconds=600)
        assert sticky.size() == sticky._MAX_ENTRIES

    def test_eviction_drops_the_least_recently_used(self):
        pool = [make_account("a"), make_account("b")]
        sticky.remember("stale", "a", ttl_seconds=600)
        sticky.remember("fresh", "a", ttl_seconds=600)
        # Touch "fresh" so "stale" is the older end of the LRU order.
        assert sticky.resolve("fresh", pool, ttl_seconds=600) == "a"

        # 2 existing + (MAX - 1) fillers = MAX + 1, so exactly one entry is evicted.
        for i in range(sticky._MAX_ENTRIES - 1):
            sticky.remember(f"filler-{i}", "b", ttl_seconds=600)
        assert sticky.size() == sticky._MAX_ENTRIES

        # Assert on the map itself: `resolve` falls back to rendezvous on a miss, so a
        # non-None return would not distinguish "remembered" from "recomputed".
        assert "stale" not in sticky._affinity
        assert "fresh" in sticky._affinity
