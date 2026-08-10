from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.db.models import Account
from app.modules.proxy import load_balancer as lb


def make_account(name: str, **kwargs) -> Account:
    defaults = dict(
        id=name,
        name=name,
        encrypted_credential="x",
        weight=1.0,
        enabled=True,
        priority=0,
        consecutive_failures=0,
        total_requests=0,
        total_input_tokens=0,
        total_output_tokens=0,
        total_cost_usd=0.0,
    )
    return Account(**{**defaults, **kwargs})


NOW = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)


class TestAvailability:
    def test_disabled_account_is_unavailable(self):
        assert not lb.is_available(make_account("a", enabled=False), now=NOW)

    def test_cooling_down_account_is_unavailable(self):
        account = make_account("a", cooldown_until=NOW + timedelta(seconds=30))
        assert not lb.is_available(account, now=NOW)

    def test_expired_cooldown_is_available_again(self):
        account = make_account("a", cooldown_until=NOW - timedelta(seconds=1))
        assert lb.is_available(account, now=NOW)

    def test_naive_datetime_from_sqlite_is_treated_as_utc(self):
        # SQLite returns naive datetimes even for timezone-aware columns.
        account = make_account("a", cooldown_until=(NOW + timedelta(seconds=30)).replace(tzinfo=None))
        assert not lb.is_available(account, now=NOW)


class TestHeadroom:
    def test_unknown_limits_report_full_headroom(self):
        assert lb.headroom(make_account("a"), now=NOW) == 1.0

    def test_uses_the_tightest_of_request_and_token_budgets(self):
        account = make_account(
            "a",
            rl_requests_limit=100,
            rl_requests_remaining=90,
            rl_tokens_limit=1000,
            rl_tokens_remaining=100,
            rl_reset_at=NOW + timedelta(minutes=1),
        )
        assert lb.headroom(account, now=NOW) == pytest.approx(0.1)

    def test_stale_window_resets_to_full(self):
        account = make_account(
            "a",
            rl_tokens_limit=1000,
            rl_tokens_remaining=0,
            rl_reset_at=NOW - timedelta(seconds=1),
        )
        assert lb.headroom(account, now=NOW) == 1.0


class TestSelection:
    def test_raises_when_no_accounts_configured(self):
        with pytest.raises(lb.NoAccountAvailable, match="no accounts configured"):
            lb.select_account([], now=NOW)

    def test_raises_when_every_account_is_down(self):
        accounts = [make_account("a", enabled=False), make_account("b", enabled=False)]
        with pytest.raises(lb.NoAccountAvailable, match="disabled or cooling down"):
            lb.select_account(accounts, now=NOW)

    def test_excluded_accounts_are_not_reselected(self):
        accounts = [make_account("a"), make_account("b")]
        chosen = lb.select_account(accounts, strategy="round_robin", exclude_ids=["a"], now=NOW)
        assert chosen.name == "b"

    def test_exhausting_the_pool_reports_that_all_were_tried(self):
        accounts = [make_account("a")]
        with pytest.raises(lb.NoAccountAvailable, match="already tried"):
            lb.select_account(accounts, exclude_ids=["a"], now=NOW)

    def test_pinned_account_is_honoured(self):
        accounts = [make_account("a"), make_account("b")]
        chosen = lb.select_account(accounts, pinned_account_id="b", now=NOW)
        assert chosen.name == "b"

    def test_pinned_but_unavailable_account_raises_rather_than_falling_back(self):
        accounts = [make_account("a"), make_account("b", enabled=False)]
        with pytest.raises(lb.NoAccountAvailable, match="pinned account b is unavailable"):
            lb.select_account(accounts, pinned_account_id="b", now=NOW)

    def test_round_robin_cycles_through_the_pool(self):
        accounts = [make_account("a"), make_account("b"), make_account("c")]
        picked = {lb.select_account(accounts, strategy="round_robin", now=NOW).name for _ in range(9)}
        assert picked == {"a", "b", "c"}

    def test_least_used_picks_the_lowest_request_count(self):
        accounts = [
            make_account("a", total_requests=10),
            make_account("b", total_requests=2),
            make_account("c", total_requests=7),
        ]
        assert lb.select_account(accounts, strategy="least_used", now=NOW).name == "b"

    def test_fill_first_drains_the_highest_priority_account(self):
        accounts = [make_account("low", priority=0), make_account("high", priority=10)]
        assert lb.select_account(accounts, strategy="fill_first", now=NOW).name == "high"

    def test_fill_first_moves_on_when_the_top_account_is_spent(self):
        spent = make_account(
            "high",
            priority=10,
            rl_tokens_limit=1000,
            rl_tokens_remaining=0,
            rl_reset_at=NOW + timedelta(minutes=5),
        )
        accounts = [spent, make_account("low", priority=0)]
        assert lb.select_account(accounts, strategy="fill_first", now=NOW).name == "low"

    def test_capacity_weighted_never_returns_an_exhausted_account_when_one_has_room(self):
        empty = make_account(
            "empty",
            rl_tokens_limit=1000,
            rl_tokens_remaining=0,
            rl_reset_at=NOW + timedelta(minutes=5),
        )
        roomy = make_account(
            "roomy",
            rl_tokens_limit=1000,
            rl_tokens_remaining=1000,
            rl_reset_at=NOW + timedelta(minutes=5),
        )
        picks = {
            lb.select_account([empty, roomy], strategy="capacity_weighted", now=NOW).name for _ in range(50)
        }
        assert picks == {"roomy"}

    def test_capacity_weighted_falls_back_to_soonest_reset_when_all_are_spent(self):
        soon = make_account(
            "soon",
            rl_tokens_limit=100,
            rl_tokens_remaining=0,
            rl_reset_at=NOW + timedelta(minutes=1),
        )
        later = make_account(
            "later",
            rl_tokens_limit=100,
            rl_tokens_remaining=0,
            rl_reset_at=NOW + timedelta(minutes=30),
        )
        chosen = lb.select_account([soon, later], strategy="capacity_weighted", now=NOW)
        assert chosen.name == "soon"


class TestRateLimitHeaders:
    def test_parses_request_and_token_buckets(self):
        account = make_account("a")
        lb.apply_rate_limit_headers(
            account,
            {
                "anthropic-ratelimit-requests-limit": "1000",
                "anthropic-ratelimit-requests-remaining": "999",
                "anthropic-ratelimit-tokens-limit": "80000",
                "anthropic-ratelimit-tokens-remaining": "79000",
                "anthropic-ratelimit-tokens-reset": "2026-08-10T12:05:00Z",
            },
        )
        assert account.rl_requests_remaining == 999
        assert account.rl_tokens_remaining == 79000
        assert account.rl_reset_at == datetime(2026, 8, 10, 12, 5, tzinfo=UTC)

    def test_falls_back_to_summing_input_and_output_buckets(self):
        account = make_account("a")
        lb.apply_rate_limit_headers(
            account,
            {
                "anthropic-ratelimit-input-tokens-limit": "60000",
                "anthropic-ratelimit-input-tokens-remaining": "50000",
                "anthropic-ratelimit-output-tokens-limit": "20000",
                "anthropic-ratelimit-output-tokens-remaining": "10000",
            },
        )
        assert account.rl_tokens_limit == 80000
        assert account.rl_tokens_remaining == 60000

    def test_header_casing_is_ignored(self):
        account = make_account("a")
        lb.apply_rate_limit_headers(account, {"Anthropic-RateLimit-Requests-Limit": "500"})
        assert account.rl_requests_limit == 500

    def test_garbage_values_are_ignored_rather_than_raising(self):
        account = make_account("a", rl_requests_limit=42)
        lb.apply_rate_limit_headers(
            account,
            {"anthropic-ratelimit-requests-limit": "n/a", "anthropic-ratelimit-tokens-reset": "soon"},
        )
        assert account.rl_requests_limit == 42


class TestCircuitBreaker:
    def test_auth_failure_disables_the_account_immediately(self):
        account = make_account("a")
        lb.record_failure(account, status_code=401, reason="bad key")
        assert account.enabled is False
        assert account.disabled_reason == "bad key"

    def test_rate_limit_cools_down_for_retry_after(self):
        account = make_account("a")
        lb.record_failure(account, status_code=429, retry_after_seconds=45)
        remaining = (account.cooldown_until - datetime.now(UTC)).total_seconds()
        assert 40 < remaining <= 45
        assert account.enabled is True

    def test_rate_limit_cooldown_is_capped(self):
        account = make_account("a")
        lb.record_failure(account, status_code=429, retry_after_seconds=99999)
        remaining = (account.cooldown_until - datetime.now(UTC)).total_seconds()
        assert remaining <= lb.MAX_BACKOFF_SECONDS

    def test_transient_failures_only_trip_the_breaker_at_the_threshold(self):
        account = make_account("a")
        for _ in range(lb.FAILURE_THRESHOLD - 1):
            lb.record_failure(account, status_code=500)
        assert account.cooldown_until is None

        lb.record_failure(account, status_code=500)
        assert account.cooldown_until is not None

    def test_success_clears_breaker_state(self):
        account = make_account("a", consecutive_failures=5, disabled_reason="flaky")
        account.cooldown_until = datetime.now(UTC) + timedelta(minutes=5)
        lb.record_success(account)
        assert account.consecutive_failures == 0
        assert account.cooldown_until is None
        assert account.disabled_reason is None
