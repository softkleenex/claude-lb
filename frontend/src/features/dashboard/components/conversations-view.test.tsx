import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { DashboardPage } from "@/features/dashboard/components/dashboard-page";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

const KEY_A = "a".repeat(64);

async function renderPage(path = "/dashboard") {
  window.history.pushState({}, "", path);
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  const result = renderWithProviders(<DashboardPage />);
  await screen.findByTestId("dashboard-meta");
  return { user, ...result };
}

describe("Dashboard conversations view", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    window.localStorage.clear();
  });

  it("switches the request log to conversations and keeps the choice in the URL", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole("tab", { name: "Conversations" }));

    expect(new URLSearchParams(window.location.search).get("view")).toBe("conversations");
    const row = await screen.findByTestId("conversation-row-aaaaaaaa…aaaa");
    expect(within(row).getByText("alice-max")).toBeInTheDocument();
    expect(within(row).getByText("claude-code-team")).toBeInTheDocument();
    expect(within(row).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("1 error")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-row-bbbbbbbb…bbbb")).toBeInTheDocument();
    // request-log-only controls are hidden in this view
    expect(screen.queryByRole("button", { name: /Columns/ })).not.toBeInTheDocument();
  });

  it("filters the request log by a conversation when its row is clicked", async () => {
    const { user } = await renderPage("/dashboard?view=conversations");

    await user.click(await screen.findByTestId("conversation-row-aaaaaaaa…aaaa"));

    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("view")).toBeNull();
      expect(params.get("session")).toBe(KEY_A);
    });
    expect(await screen.findByTestId("request-row-req_0001")).toBeInTheDocument();
    expect(screen.getByTestId("request-row-req_0003")).toBeInTheDocument();
    expect(screen.queryByTestId("request-row-req_0002")).not.toBeInTheDocument();
  });

  it("opens conversation details with the model breakdown and timeline", async () => {
    const { user } = await renderPage("/dashboard?view=conversations");

    await user.click(await screen.findByRole("button", { name: "Details of conversation aaaaaaaa…aaaa" }));

    const dialog = await screen.findByRole("dialog");
    const details = await within(dialog).findByTestId("conversation-details");
    expect(within(details).getByText(KEY_A)).toBeInTheDocument();
    expect(within(details).getByText("Account (1)")).toBeInTheDocument();
    expect(within(details).getByText("claude-cli")).toBeInTheDocument();
    const models = within(details).getByTestId("conversation-model-table");
    expect(within(models).getByText("claude-opus-5-5")).toBeInTheDocument();
    expect(within(within(details).getByTestId("conversation-timeline")).getAllByRole("row")).toHaveLength(3);

    await user.click(within(dialog).getByRole("button", { name: "Show these requests in the log" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("session")).toBe(KEY_A));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("sends the search to the conversations endpoint", async () => {
    const seen: URLSearchParams[] = [];
    server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/conversations") seen.push(url.searchParams);
    });
    const { user } = await renderPage("/dashboard?view=conversations");

    await screen.findByTestId("conversation-row-aaaaaaaa…aaaa");
    await user.type(screen.getByRole("textbox", { name: "Search conversations" }), "ci-review");

    await waitFor(() => expect(screen.queryByTestId("conversation-row-aaaaaaaa…aaaa")).not.toBeInTheDocument());
    expect(screen.getByTestId("conversation-row-bbbbbbbb…bbbb")).toBeInTheDocument();
    const last = seen[seen.length - 1];
    expect(last.get("search")).toBe("ci-review");
    expect(new URLSearchParams(window.location.search).get("convSearch")).toBe("ci-review");
    server.events.removeAllListeners();
  });

  it("applies the timeframe from the URL and explains an empty filtered result", async () => {
    // mock rows are dated 2026-01-01, so the last hour holds none of them
    await renderPage("/dashboard?view=conversations&convTimeframe=1h");
    expect(await screen.findByText("No conversations")).toBeInTheDocument();
    expect(screen.getByText("No conversation matches the search or time range.")).toBeInTheDocument();
  });

  it("shows a retryable error", async () => {
    server.use(http.get("/api/conversations", () => HttpResponse.json({ detail: "boom" }, { status: 500 })));
    const { user } = await renderPage("/dashboard?view=conversations");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    server.resetHandlers();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("conversation-row-aaaaaaaa…aaaa")).toBeInTheDocument();
  });
});
