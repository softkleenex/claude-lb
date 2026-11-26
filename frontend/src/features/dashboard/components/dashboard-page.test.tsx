import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { DashboardPage } from "@/features/dashboard/components/dashboard-page";
import { createDashboardOverviewWire, createRequestLogWire } from "@/test/mocks/factories";
import { getMockAccounts, setMockProjections, setMockRequestLogs } from "@/test/mocks/handlers";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

async function renderPage(path = "/dashboard") {
  window.history.pushState({}, "", path);
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  const result = renderWithProviders(<DashboardPage />);
  await screen.findByTestId("dashboard-meta");
  return { user, ...result };
}

describe("DashboardPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    window.localStorage.clear();
  });

  it("shows the meta line and stat cards with period-over-period deltas", async () => {
    await renderPage();

    expect(screen.getByTestId("dashboard-meta")).toHaveTextContent(
      "v0.6.1 · 2/3 accounts available · pool 71% remaining · Capacity weighted + sticky sessions",
    );
    const requests = screen.getByTestId("stat-requests");
    expect(within(requests).getByText("1.2K")).toBeInTheDocument();
    expect(within(requests).getByText("+20%")).toBeInTheDocument();
    expect(within(requests).getByText("Avg 2.40 s · TTFT 610 ms")).toBeInTheDocument();

    const savings = screen.getByTestId("stat-savings");
    expect(within(savings).getByText("$51.30")).toBeInTheDocument();
    expect(within(savings).getByText("Cache hit rate 84.0%")).toBeInTheDocument();
    expect(within(savings).getByText("+4.0pp")).toBeInTheDocument();

    const errors = screen.getByTestId("stat-errors");
    expect(within(errors).getByText("1.5%")).toBeInTheDocument();
    expect(within(errors).getByText("Top: Overloaded (12)")).toBeInTheDocument();
    expect(within(errors).getByText("−1.5pp")).toBeInTheDocument();

    const cost = screen.getByTestId("stat-cost");
    expect(within(cost).getByText("$84.21")).toBeInTheDocument();
    expect(within(cost).getByText("−6%")).toBeInTheDocument();
    expect(within(screen.getByTestId("stat-conversations")).getByText("140")).toBeInTheDocument();
  });

  it("renders capacity donuts, weekly pace and API-key spend", async () => {
    await renderPage();

    expect(await screen.findByText("5-hour capacity")).toBeInTheDocument();
    expect(screen.getByText("7-day capacity")).toBeInTheDocument();
    expect(screen.getAllByText("At risk").length).toBeGreaterThan(0);

    const pace = screen.getByRole("region", { name: "Weekly pace" });
    expect(within(pace).getByTestId("weekly-pace-label")).toHaveTextContent("13% over");
    expect(within(pace).getByTestId("weekly-pace-recommendations")).toHaveTextContent("for 21h 30m");
    expect(within(pace).getByTestId("weekly-pace-recommendations")).toHaveTextContent("2 Pro accounts (≈1.4)");

    const spend = screen.getByRole("region", { name: "API key spend" });
    expect(within(spend).getByText("$4.20 of $10.00")).toBeInTheDocument();
  });

  it("hides the capacity donuts and pace when there are no subscription accounts", async () => {
    setMockProjections({ subscription_accounts: 0, primary: null, secondary: null, weekly_pace: null });
    await renderPage();

    expect(await screen.findByRole("region", { name: "API key spend" })).toBeInTheDocument();
    expect(screen.queryByText("5-hour capacity")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Weekly pace" })).not.toBeInTheDocument();
  });

  it("syncs the overview window with the URL and refetches", async () => {
    const seen: string[] = [];
    server.use(
      http.get("/api/dashboard/overview", ({ request }) => {
        const timeframe = new URL(request.url).searchParams.get("timeframe") ?? "";
        seen.push(timeframe);
        return HttpResponse.json(createDashboardOverviewWire(timeframe as "7d"));
      }),
    );
    const { user } = await renderPage("/dashboard?window=7d");
    expect(seen).toContain("7d");

    await user.click(screen.getByRole("combobox", { name: "Overview window" }));
    await user.click(await screen.findByRole("option", { name: "Last hour" }));

    await waitFor(() => expect(seen).toContain("1h"));
    expect(window.location.search).toContain("window=1h");
  });

  it("lists accounts as cards or a table and pauses from a quick action", async () => {
    const { user } = await renderPage();

    expect(await screen.findByTestId("dashboard-account-summary-line")).toHaveTextContent("2available·3registered·1unavailable");
    const card = await screen.findByTestId("dashboard-account-acc_max");
    expect(within(card).getByText("alice-max")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Pause alice-max" }));
    await waitFor(() => expect(getMockAccounts().find((a) => a.id === "acc_max")?.enabled).toBe(false));

    await user.click(screen.getByRole("radio", { name: "View accounts as list" }));
    expect(await screen.findByTestId("dashboard-account-row-acc_max")).toBeInTheDocument();
    expect(window.localStorage.getItem("claude-lb-dashboard-account-view-mode")).toBe("list");
    expect(
      within(screen.getByTestId("dashboard-account-row-acc_max")).getByRole("link", {
        name: "Open alice-max on the Accounts page",
      }),
    ).toHaveAttribute("href", "/accounts?selected=acc_max");
  });

  it("shows usage by model with cache hit and saved columns", async () => {
    await renderPage();
    const table = screen.getByRole("region", { name: "Usage by model" });
    const row = within(table).getByText("claude-opus-5-5").closest("tr") as HTMLElement;
    expect(within(row).getByText("86.0%")).toBeInTheDocument();
    expect(within(row).getByText("$34.20")).toBeInTheDocument();
    expect(within(row).getByText("$60.50")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Daily cost" })).toBeInTheDocument();
  });

  it("lists request logs and filters them by status from the URL", async () => {
    await renderPage("/dashboard?status=overloaded");

    expect(await screen.findByTestId("request-row-req_0002")).toBeInTheDocument();
    expect(screen.queryByTestId("request-row-req_0001")).not.toBeInTheDocument();
    expect(screen.getByText("1 request")).toBeInTheDocument();
  });

  it("searches request logs after a debounce", async () => {
    const { user } = await renderPage();
    await screen.findByTestId("request-row-req_0001");

    await user.type(screen.getByRole("textbox", { name: "Search request logs" }), "ci-review");

    await waitFor(() => expect(screen.queryByTestId("request-row-req_0001")).not.toBeInTheDocument());
    expect(screen.getByTestId("request-row-req_0002")).toBeInTheDocument();
    expect(window.location.search).toContain("search=ci-review");
  });

  it("pages through request logs", async () => {
    setMockRequestLogs(
      Array.from({ length: 30 }, (_, i) => createRequestLogWire({ id: `req_${String(i).padStart(3, "0")}` })),
    );
    const { user } = await renderPage();
    expect(await screen.findByTestId("request-row-req_000")).toBeInTheDocument();
    expect(screen.getByText("1–25 of 30")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByTestId("request-row-req_025")).toBeInTheDocument();
    expect(screen.getByText("26–30 of 30")).toBeInTheDocument();
  });

  it("opens request details with the token breakdown and can filter to the conversation", async () => {
    const { user } = await renderPage();
    const row = await screen.findByTestId("request-row-req_0001");
    await user.click(within(row).getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog", { name: "Request details" });
    expect(await within(dialog).findByTestId("request-token-breakdown")).toHaveTextContent("Cache read");
    expect(within(dialog).getByText("claude-cli/2.1.3 (external, cli)")).toBeInTheDocument();
    expect(within(dialog).getByText("10.0.0.7")).toBeInTheDocument();
    expect(within(dialog).getByText("2 requests in this conversation · $0.022")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Copy Request ID" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Show this conversation's requests" }));
    await waitFor(() => expect(window.location.search).toContain(`session=${"a".repeat(64)}`));
    await waitFor(() => expect(screen.queryByTestId("request-row-req_0002")).not.toBeInTheDocument());
    expect(screen.getByTestId("request-row-req_0003")).toBeInTheDocument();
  });

  it("shows an empty state when there are no request logs", async () => {
    setMockRequestLogs([]);
    await renderPage();
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
  });

  it("renders in Korean", async () => {
    await i18n.changeLanguage("ko");
    try {
      await renderPage();
      expect(screen.getByTestId("dashboard-meta")).toHaveTextContent(
        "v0.6.1 · 계정 3개 중 2개 사용 가능 · 풀 잔여 71%",
      );
      expect(screen.getByText("프롬프트 캐시 절감액")).toBeInTheDocument();
      expect(await screen.findByText("5시간 용량")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "주간 사용 속도" })).toHaveTextContent("13% 초과");
      expect(await screen.findByText("과부하")).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
