import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { camelizeKeys } from "@/lib/casing";
import { createReportWire } from "@/test/mocks/factories";
import { renderWithProviders } from "@/test/utils";

import { ReportSchema } from "../schemas";
import { BreakdownTable } from "./breakdown-table";

function report(groupBy: "api_key" | "day") {
  return ReportSchema.parse(camelizeKeys(createReportWire({ start: "2026-01-01", end: "2026-01-03", groupBy })));
}

describe("BreakdownTable", () => {
  it("shows rows, translated placeholder labels, a totals row and the CSV link", () => {
    const data = report("api_key");
    renderWithProviders(
      <BreakdownTable groupBy="api_key" rows={data.breakdown} total={data.breakdownTotal} csvUrl="/csv?x=1" />,
    );

    const rows = screen.getAllByTestId("report-breakdown-row");
    expect(rows.map((row) => within(row).getAllByRole("cell")[0].textContent)).toEqual([
      "claude-code-team",
      "(unattributed)",
    ]);
    const total = screen.getByTestId("report-breakdown-total");
    expect(total).toHaveTextContent("Total");
    expect(total).toHaveTextContent("$15.00");
    expect(total).toHaveTextContent("$7.29");
    expect(screen.getByTestId("report-csv-link")).toHaveAttribute("href", "/csv?x=1");
    expect(screen.getByRole("columnheader", { name: /API key/ })).toBeInTheDocument();
  });

  it("sorts by a column, descending first, then ascending", async () => {
    const user = userEvent.setup();
    const data = report("day");
    data.breakdown[1].costUsd = 99;
    renderWithProviders(
      <BreakdownTable groupBy="day" rows={data.breakdown} total={data.breakdownTotal} csvUrl="/csv" />,
    );
    const firstLabel = () => within(screen.getAllByTestId("report-breakdown-row")[0]).getAllByRole("cell")[0];

    expect(firstLabel()).toHaveTextContent("2026-01-01");
    await user.click(screen.getByRole("button", { name: /^Cost/ }));
    expect(firstLabel()).toHaveTextContent("2026-01-02");
    expect(screen.getByRole("columnheader", { name: /^Cost/ })).toHaveAttribute("aria-sort", "descending");
    await user.click(screen.getByRole("button", { name: /^Day/ }));
    await user.click(screen.getByRole("button", { name: /^Day/ }));
    expect(firstLabel()).toHaveTextContent("2026-01-03");
  });

  it("says so when the range has no usage", () => {
    const data = report("day");
    renderWithProviders(<BreakdownTable groupBy="day" rows={[]} total={data.breakdownTotal} csvUrl="/csv" />);
    expect(screen.getByText("No usage in this range.")).toBeInTheDocument();
  });
});
