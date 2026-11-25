import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { setMockReport } from "@/test/mocks/handlers";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

import { daysAgoUtcISO, utcDateISO } from "../date";
import { REPORT_CHART_VISIBILITY_STORAGE_KEY } from "../hooks/use-report-chart-visibility";
import { ReportsPage } from "./reports-page";

function captureReportRequests(): URL[] {
  const seen: URL[] = [];
  server.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/reports") seen.push(url);
  });
  return seen;
}

async function renderPage(path = "/reports") {
  window.history.pushState({}, "", path);
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  const result = renderWithProviders(<ReportsPage />);
  return { user, ...result };
}

describe("ReportsPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    window.localStorage.clear();
    server.events.removeAllListeners();
  });

  it("loads the default 30-day report with summary cards, charts and the breakdown", async () => {
    const requests = captureReportRequests();
    await renderPage();

    const cost = await screen.findByTestId("report-summary-cost");
    expect(within(cost).getByText("$150.00")).toBeInTheDocument();
    expect(within(cost).getByText("avg $5.00/day")).toBeInTheDocument();
    expect(within(cost).getByText("▲ 100%")).toBeInTheDocument();
    expect(within(screen.getByTestId("report-summary-requests")).getByText("2 accounts used")).toBeInTheDocument();
    expect(within(screen.getByTestId("report-summary-savings")).getByText("$72.90")).toBeInTheDocument();
    expect(within(screen.getByTestId("report-summary-errors")).getByText("30 aborted streams")).toBeInTheDocument();

    for (const id of [
      "costByDay",
      "tokensByDay",
      "requestsByDay",
      "timeToFirstToken",
      "tokensPerSecond",
      "modelDistribution",
      "userAgentDistribution",
    ]) {
      expect(screen.getByTestId(`report-chart-${id}`)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId("report-breakdown-row")).toHaveLength(30);
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "true");

    expect(requests[0].searchParams.get("start")).toBe(daysAgoUtcISO(29));
    expect(requests[0].searchParams.get("end")).toBe(utcDateISO());
    expect(requests[0].searchParams.get("group_by")).toBe("day");
    expect(screen.getByTestId("report-csv-link").getAttribute("href")).toBe(
      `/api/usage/report.csv?start=${daysAgoUtcISO(29)}&end=${utcDateISO()}&group_by=day`,
    );
  });

  it("switches presets and grouping, keeping them in the URL and the CSV link", async () => {
    const requests = captureReportRequests();
    const { user } = await renderPage();
    await screen.findByTestId("report-summary-cost");

    await user.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => expect(screen.getAllByTestId("report-breakdown-row")).toHaveLength(7));
    expect(window.location.search).toBe("?preset=7");

    await user.click(screen.getByRole("combobox", { name: "Group by" }));
    await user.click(await screen.findByRole("option", { name: "Account" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("report-breakdown-row").map((row) => row.textContent)).toEqual([
        expect.stringContaining("alice-max"),
        expect.stringContaining("console-key"),
      ]),
    );
    expect(window.location.search).toBe("?preset=7&groupBy=account");
    expect(requests.at(-1)?.searchParams.get("group_by")).toBe("account");
    expect(screen.getByTestId("report-csv-link").getAttribute("href")).toContain("group_by=account");
  });

  it("applies multi-select filters and warns that a user-agent filter reads request logs", async () => {
    const requests = captureReportRequests();
    const { user } = await renderPage();
    await screen.findByTestId("report-summary-cost");

    await user.click(screen.getByRole("button", { name: /Accounts/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "alice-max" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "console-key" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(requests.at(-1)?.searchParams.getAll("account_id")).toEqual(["acc_alice", "acc_console"]));

    await user.click(screen.getByRole("button", { name: /User agents/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "(no user agent)" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(requests.at(-1)?.searchParams.getAll("user_agent")).toEqual(["(unknown)"]));
    expect(await screen.findByTestId("report-source-notice")).toHaveTextContent("kept for 30 days");
    expect(screen.getByTestId("report-csv-link").getAttribute("href")).toContain("user_agent=%28unknown%29");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("shows an error for an invalid range and does not request it", async () => {
    const requests = captureReportRequests();
    await renderPage("/reports?start=2026-01-10&end=2026-01-05");

    expect(await screen.findByRole("alert")).toHaveTextContent("Start date must be on or before end date.");
    expect(screen.getByLabelText("Start date")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "30d" })).toHaveAttribute("aria-pressed", "false");
    expect(requests).toHaveLength(0);
  });

  it("editing a date leaves the preset for a fixed range", async () => {
    const { user } = await renderPage("/reports?start=2026-01-01&end=2026-01-07");
    await screen.findByTestId("report-summary-cost");
    const start = screen.getByLabelText("Start date");
    await user.clear(start);
    await user.type(start, "2026-01-03");
    await waitFor(() => expect(window.location.search).toBe("?start=2026-01-03&end=2026-01-07"));
    await waitFor(() => expect(screen.getAllByTestId("report-breakdown-row")).toHaveLength(5));
  });

  it("explains request-log retention when the range is older than it", async () => {
    setMockReport({ coverage: { retention_days: 7, logs_from: "2026-01-20", logs_truncated: true } });
    await renderPage();
    expect(await screen.findByTestId("report-coverage-notice")).toHaveTextContent(
      "Request logs are kept for 7 days, so TTFT, tokens per second, aborted requests, conversations and user agents only cover 2026-01-20 onward.",
    );
    expect(screen.getByTestId("report-chart-timeToFirstToken")).toHaveTextContent(
      "From 2026-01-20 (request-log retention)",
    );
  });

  it("remembers which charts are shown", async () => {
    const { user } = await renderPage();
    await screen.findByTestId("report-summary-cost");

    await user.click(screen.getByRole("button", { name: /^Charts/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Tokens per second" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByTestId("report-chart-tokensPerSecond")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(REPORT_CHART_VISIBILITY_STORAGE_KEY) ?? "[]")).not.toContain(
      "tokensPerSecond",
    );
  });

  it("toggles the distribution metric between cost, tokens and requests", async () => {
    const { user } = await renderPage();
    const card = await screen.findByTestId("report-chart-modelDistribution");
    expect(within(card).getByTestId("modelDistribution-total")).toHaveTextContent("$150.00");
    await user.click(within(card).getByRole("button", { name: "Tokens" }));
    expect(within(card).getByTestId("modelDistribution-total")).toHaveTextContent("1.5M");
    await user.click(within(card).getByRole("button", { name: "Requests" }));
    expect(within(card).getByTestId("modelDistribution-total")).toHaveTextContent("200");
    const legend = within(card).getByTestId("modelDistribution-legend");
    expect(within(legend).getAllByRole("listitem")[0]).toHaveTextContent("claude-sonnet-4-5");
  });

  it("shows the server error and retries", async () => {
    server.use(http.get("/api/reports", () => HttpResponse.json({ detail: "boom" }, { status: 500 })));
    await renderPage();
    expect(await screen.findByText(/Failed to load the report: boom/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
