import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import { KNOWN_AUDIT_ACTIONS } from "@/features/audit/action-labels";
import { AuditPage } from "@/features/audit/components/audit-page";
import { parseAuditFilters, writeAuditFilters } from "@/features/audit/hooks/use-audit";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import en from "@/i18n/locales/en.json";
import ko from "@/i18n/locales/ko.json";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

async function renderPage(path = "/audit") {
  window.history.pushState({}, "", path);
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  renderWithProviders(<AuditPage />);
  await screen.findByText("Audit log");
  return { user };
}

function lastAuditQuery(seen: URLSearchParams[]): URLSearchParams {
  return seen[seen.length - 1];
}

describe("AuditPage", () => {
  const seen: URLSearchParams[] = [];

  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    seen.length = 0;
    server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/audit/events") seen.push(url.searchParams);
    });
  });

  afterEach(async () => {
    server.events.removeAllListeners();
    await i18n.changeLanguage("en");
  });

  it("lists events with translated action labels, target, detail, IP and result", async () => {
    await renderPage();

    const failed = await screen.findByTestId("audit-row-evt_0004");
    expect(within(failed).getByText("Sign-in")).toBeInTheDocument();
    expect(within(failed).getByText("auth.login")).toBeInTheDocument();
    expect(within(failed).getByText("invalid password")).toBeInTheDocument();
    expect(within(failed).getByText("203.0.113.9")).toBeInTheDocument();
    expect(within(failed).getByText("Failed")).toBeInTheDocument();

    const created = screen.getByTestId("audit-row-evt_0001");
    expect(within(created).getByText("Account added")).toBeInTheDocument();
    expect(within(created).getByText("alice-max")).toBeInTheDocument();
    expect(within(created).getByText("Succeeded")).toBeInTheDocument();
    // unknown actions fall back to their raw code
    expect(within(screen.getByTestId("audit-row-evt_0000")).getAllByText("custom.unknown_action")).toHaveLength(2);
    expect(screen.getByText("5 events")).toBeInTheDocument();
  });

  it("filters by action, target, result, timeframe and search through the URL", async () => {
    const { user } = await renderPage();
    await screen.findByTestId("audit-row-evt_0004");

    await user.click(screen.getByRole("button", { name: /Action/ }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /API key created/ }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(lastAuditQuery(seen).getAll("action")).toEqual(["api_key.created"]));
    expect(await screen.findByTestId("audit-row-evt_0002")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("audit-row-evt_0004")).not.toBeInTheDocument());
    expect(new URLSearchParams(window.location.search).getAll("action")).toEqual(["api_key.created"]);

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await screen.findByTestId("audit-row-evt_0004");

    await user.type(screen.getByRole("textbox", { name: "Filter by target" }), "alice");
    await waitFor(() => expect(lastAuditQuery(seen).get("target")).toBe("alice"));
    await waitFor(() => expect(screen.queryByTestId("audit-row-evt_0004")).not.toBeInTheDocument());
    expect(screen.getByTestId("audit-row-evt_0001")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset" }));

    await user.type(screen.getByRole("textbox", { name: "Search the audit log" }), "203.0");
    await waitFor(() => expect(lastAuditQuery(seen).get("search")).toBe("203.0"));
    await waitFor(() => expect(screen.queryByTestId("audit-row-evt_0001")).not.toBeInTheDocument());
  });

  it("reads result and timeframe filters from the URL", async () => {
    await renderPage("/audit?result=failed&timeframe=24h");
    await screen.findByTestId("audit-row-evt_0004");
    const query = lastAuditQuery(seen);
    expect(query.get("ok")).toBe("false");
    expect(query.get("timeframe")).toBe("24h");
    expect(screen.queryByTestId("audit-row-evt_0001")).not.toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    server.use(
      http.get("/api/audit/events", () =>
        HttpResponse.json({ events: [], total: 0, limit: 50, offset: 0, has_more: false }),
      ),
    );
    await renderPage();
    expect(await screen.findByText("No audit events yet")).toBeInTheDocument();
  });

  it("round-trips filters through URL params", () => {
    const filters = parseAuditFilters(
      new URLSearchParams("search=x&action=a.b&action=c.d&target=t&timeframe=7d&result=ok&limit=25&offset=50"),
    );
    expect(filters).toEqual({
      search: "x",
      actions: ["a.b", "c.d"],
      target: "t",
      timeframe: "7d",
      result: "ok",
      limit: 25,
      offset: 50,
    });
    expect(writeAuditFilters(filters).toString()).toBe(
      "search=x&action=a.b&action=c.d&target=t&timeframe=7d&result=ok&limit=25&offset=50",
    );
    expect(parseAuditFilters(new URLSearchParams("timeframe=2y&result=maybe&offset=-1")).timeframe).toBe("all");
  });

  it("has an English and a Korean label for every known action", () => {
    const enKeys = en as Record<string, string>;
    const koKeys = ko as Record<string, string>;
    for (const action of KNOWN_AUDIT_ACTIONS) {
      expect(enKeys[`audit.action.${action}`], action).toBeTruthy();
      expect(koKeys[`audit.action.${action}`], action).toBeTruthy();
    }
  });

  it("renders in Korean", async () => {
    await i18n.changeLanguage("ko");
    window.history.pushState({}, "", "/audit");
    await useAuthStore.getState().refreshSession();
    renderWithProviders(<AuditPage />);
    const row = await screen.findByTestId("audit-row-evt_0004");
    expect(within(row).getByText("로그인")).toBeInTheDocument();
    expect(within(row).getByText("실패")).toBeInTheDocument();
  });
});
