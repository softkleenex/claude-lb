import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { ApisPage } from "@/features/apis/components/apis-page";
import { createApiKeyWire, createDefaultApiKeyWires } from "@/test/mocks/factories";
import { getMockApiKeys, setMockApiKeys } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

async function renderPage(path = "/apis") {
  window.history.pushState({}, "", path);
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  renderWithProviders(<ApisPage />);
  await screen.findByRole("heading", { name: "API keys", level: 1 });
  return { user };
}

describe("ApisPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("shows overview stats and rankings", async () => {
    await renderPage();
    const total = await screen.findByTestId("api-keys-stat-total");
    expect(within(total).getByText("2")).toBeInTheDocument();
    expect(within(total).getByText("1 disabled · 0 expired")).toBeInTheDocument();
    expect(within(screen.getByTestId("api-keys-stat-cost")).getByText("$1.65")).toBeInTheDocument();
    const ranking = screen.getByTestId("api-keys-ranking-cost");
    expect(within(ranking).getAllByRole("listitem")[0]).toHaveTextContent("claude-code-team");
  });

  it("lists keys with status and the tightest limit, and filters them", async () => {
    const { user } = await renderPage();
    const first = await screen.findByRole("button", { name: /claude-code-team/ });
    expect(within(first).getByText("Active")).toBeInTheDocument();
    expect(within(first).getByText("92%")).toBeInTheDocument();
    expect(within(first).getByText("Requests · tightest of 2 rules")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /ci-review-bot/ })).getByText("Disabled")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Search by name, hint or model" }), "d4e5");
    expect(screen.queryByRole("button", { name: /claude-code-team/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ci-review-bot/ })).toBeInTheDocument();
  });

  it("shows the selected key's policy, limit usage and 7-day usage", async () => {
    await renderPage("/apis?selected=key_1");
    expect(await screen.findByRole("heading", { name: "claude-code-team" })).toBeInTheDocument();
    expect(screen.getByTestId("key-info-models")).toHaveTextContent("claude-sonnet-5");
    expect(await screen.findByText("alice-max", { selector: "dd" })).toBeInTheDocument();

    const limits = screen.getByTestId("api-key-limits");
    const rows = within(limits).getAllByTestId("limit-usage-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Cost· Daily (UTC)$2.50 / $10.00");
    expect(rows[0]).toHaveTextContent(/Resets in/);
    expect(rows[1]).toHaveTextContent("92 / 100");
    expect(rows[1]).toHaveTextContent(/Frees up in/);
    expect(within(rows[1]).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "92");

    const totals = await screen.findByTestId("api-7d-totals");
    await waitFor(() => expect(totals).toHaveTextContent("Requests (7d)133"));
    expect(await screen.findByTestId("account-cost-panel")).toHaveTextContent("Deleted account");
  });

  it("labels a legacy budget", async () => {
    await renderPage("/apis?selected=key_2");
    expect(await screen.findByRole("heading", { name: "ci-review-bot" })).toBeInTheDocument();
    expect(within(screen.getByTestId("api-key-limits")).getByText("Original budget")).toBeInTheDocument();
    expect(screen.getByTestId("key-info-accounts")).toHaveTextContent("All accounts");
  });

  it("enables and disables a key", async () => {
    const { user } = await renderPage("/apis?selected=key_2");
    await user.click(await screen.findByRole("button", { name: "Enable" }));
    await waitFor(() => expect(getMockApiKeys().find((key) => key.id === "key_2")?.enabled).toBe(true));
    expect(await screen.findByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("regenerates after confirmation and shows the new secret once", async () => {
    const { user } = await renderPage("/apis?selected=key_1");
    await user.click(await screen.findByRole("button", { name: "Regenerate" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Regenerate the secret for claude-code-team?");
    await user.click(within(confirm).getByRole("button", { name: "Regenerate" }));

    const dialog = await screen.findByRole("dialog", { name: "New secret issued" });
    const secret = within(dialog).getByTestId("created-api-key").textContent ?? "";
    expect(secret).toMatch(/^clb_/);
    expect(getMockApiKeys().find((key) => key.id === "key_1")?.key_hint).toBe(secret.slice(-6));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(secret)).not.toBeInTheDocument());
  });

  it("deletes after confirmation", async () => {
    const { user } = await renderPage("/apis?selected=key_2");
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Delete ci-review-bot?");
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(getMockApiKeys().map((key) => key.id)).toEqual(["key_1"]));
    await waitFor(() => expect(screen.queryByRole("button", { name: /ci-review-bot/ })).not.toBeInTheDocument());
  });

  it("shows an empty state without keys", async () => {
    setMockApiKeys([]);
    await renderPage();
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument();
    expect(screen.getByText("No API key selected")).toBeInTheDocument();
  });

  it("marks an expired key", async () => {
    setMockApiKeys([
      ...createDefaultApiKeyWires(),
      createApiKeyWire({ id: "key_old", name: "old", status: "expired", expires_at: "2020-01-01T00:00:00Z" }),
    ]);
    await renderPage("/apis?selected=key_old");
    expect(await screen.findByRole("heading", { name: "old" })).toBeInTheDocument();
    expect(screen.getByTestId("key-info-expires")).toHaveTextContent("Expired");
  });
});
