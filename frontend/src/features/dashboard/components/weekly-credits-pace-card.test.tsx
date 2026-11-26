import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WeeklyCreditsPaceCard } from "@/features/dashboard/components/weekly-credits-pace-card";
import { WeeklyPaceSchema } from "@/features/dashboard/schemas";
import { camelizeKeys } from "@/lib/casing";
import { createWeeklyPaceWire } from "@/test/mocks/factories";

function pace(overrides: Record<string, unknown> = {}) {
  return WeeklyPaceSchema.parse(camelizeKeys(createWeeklyPaceWire(overrides)));
}

describe("WeeklyCreditsPaceCard", () => {
  it("renders nothing without pace data", () => {
    const { container } = render(<WeeklyCreditsPaceCard pace={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains a projected shortfall and recommends pause, throttle and more Pro accounts", () => {
    render(<WeeklyCreditsPaceCard pace={pace()} />);
    expect(screen.getByTestId("weekly-pace-status")).toHaveAttribute("data-status", "danger");
    expect(screen.getByTestId("weekly-pace-label")).toHaveTextContent("13% over");
    expect(screen.getByText("68%")).toBeInTheDocument();
    expect(screen.getByText("55%")).toBeInTheDocument();
    expect(screen.getByTestId("weekly-pace-marker")).toHaveStyle({ left: "55%" });
    expect(
      screen.getByText("At the recent burn rate the pool runs dry in 1d, 140 credits short."),
    ).toBeInTheDocument();
    expect(screen.getByText("Burning at 2.2× the sustainable rate.")).toBeInTheDocument();
    const recommendations = screen.getByTestId("weekly-pace-recommendations");
    expect(recommendations).toHaveTextContent("for 21h 30m");
    expect(recommendations).toHaveTextContent("by ~54%");
    expect(recommendations).toHaveTextContent("2 Pro accounts (≈1.4)");
  });

  it("is calm when on pace with no shortfall", () => {
    render(
      <WeeklyCreditsPaceCard
        pace={pace({
          status: "on_track",
          delta_percent: 1,
          smoothed_delta_percent: 1,
          schedule_gap_credits: 0,
          smoothed_schedule_gap_credits: 0,
          projected_shortfall_credits: 0,
          projected_depletion_hours: null,
          projected_minimum_remaining_credits: 120,
          pause_for_break_even_hours: null,
          throttle_to_percent: null,
          reduce_by_percent: null,
          pro_account_equivalent: null,
          pro_accounts_to_cover: null,
          pace_multiplier: 0.9,
        })}
      />,
    );
    expect(screen.getByTestId("weekly-pace-label")).toHaveTextContent("On pace");
    expect(screen.getByText("Usage matches an even schedule.")).toBeInTheDocument();
    expect(
      screen.getByText("Forecast low point: 120 credits left before the resets refill it."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("weekly-pace-recommendations")).not.toBeInTheDocument();
  });

  it("says when there are too few readings to forecast", () => {
    render(
      <WeeklyCreditsPaceCard
        pace={pace({
          status: "behind",
          smoothed_delta_percent: -20,
          smoothed_schedule_gap_credits: 0,
          projected_shortfall_credits: 0,
          forecast_burn_rate_credits_per_hour: null,
          pace_multiplier: null,
          confidence: "low",
          stale_account_count: 1,
        })}
      />,
    );
    expect(screen.getByTestId("weekly-pace-label")).toHaveTextContent("20% under");
    expect(screen.getByText("Not enough recent readings to forecast yet.")).toBeInTheDocument();
    expect(screen.getByText(/1 subscription · low confidence/)).toBeInTheDocument();
  });
});
