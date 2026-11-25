import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { AccountsPage } from "@/features/accounts/components/accounts-page";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { createAccountWire } from "@/test/mocks/factories";
import { getMockAccounts, setMockAccounts } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

async function renderPage(path = "/accounts") {
  window.history.pushState({}, "", path);
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  const result = renderWithProviders(<AccountsPage />);
  await screen.findByTestId("accounts-layout");
  return { user, ...result };
}

function mockAccount(id: string) {
  const account = getMockAccounts().find((item) => item.id === id);
  if (!account) throw new Error(`no mock account ${id}`);
  return account;
}

describe("AccountsPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("lists claude-lb accounts with plan, policy and status", async () => {
    await renderPage();

    const list = screen.getByTestId("account-list-scroll-region");
    expect(within(list).getByText("alice-max")).toBeInTheDocument();
    expect(within(list).getByText("console")).toBeInTheDocument();
    expect(within(list).getByText("backup-key")).toBeInTheDocument();
    expect(within(list).getByText("Max 5x")).toBeInTheDocument();
    expect(within(list).getAllByText("Burn first").length).toBeGreaterThan(0);
    expect(within(list).getByText("Paused")).toBeInTheDocument();
    expect(within(list).getByText("1 model refused")).toBeInTheDocument();
    // The subscription shows its 5h/7d bars; the API key shows rate-limit headroom.
    expect(within(screen.getByTestId("account-item-acc_max")).getByText("42%")).toBeInTheDocument();
    expect(within(screen.getByTestId("account-item-acc_console")).getByText("92% left")).toBeInTheDocument();
  });

  it("shows the selected subscription's usage, risk and refused models", async () => {
    await renderPage();

    expect(screen.getByRole("heading", { name: "alice-max" })).toBeInTheDocument();
    expect(screen.getByText("42% used")).toBeInTheDocument();
    expect(screen.getByText("18% used")).toBeInTheDocument();
    expect(screen.getByText("Allowed")).toBeInTheDocument();
    expect((await screen.findAllByText("Warning")).length).toBe(2);
    expect(
      screen.getByText(/alice-max refuses claude-sonnet-5 via claude-lb — routed to other accounts until/),
    ).toBeInTheDocument();
    expect(await screen.findByText("Last 7 days", { selector: "h3" })).toBeInTheDocument();
  });

  it("clears a refused model", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole("button", { name: "Try claude-sonnet-5 on this account again" }));

    await waitFor(() => expect(mockAccount("acc_max").model_blocks).toEqual([]));
    await waitFor(() => expect(screen.queryByText("Models this subscription refuses")).not.toBeInTheDocument());
  });

  it("selects another account and pauses and resumes it", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByTestId("account-item-acc_console"));
    expect(await screen.findByRole("heading", { name: "console" })).toBeInTheDocument();
    expect(window.location.search).toContain("selected=acc_console");

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(mockAccount("acc_console").paused).toBe(true));
    await user.click(await screen.findByRole("button", { name: "Resume" }));
    await waitFor(() => expect(mockAccount("acc_console").enabled).toBe(true));
    expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("probes an account and shows the result", async () => {
    const { user } = await renderPage("/accounts?selected=acc_console");

    await user.click(screen.getByRole("button", { name: "Probe now" }));

    expect(await screen.findByTestId("probe-result")).toHaveTextContent("Probe passed — 3 models available.");
    expect(mockAccount("acc_console").last_probe_ok).toBe(true);
  });

  it("shows a failed probe and the disabled reason", async () => {
    setMockAccounts([createAccountWire({ id: "acc_bad", name: "broken-key" })]);
    const { user } = await renderPage();

    await user.click(screen.getByRole("button", { name: "Probe now" }));

    expect(await screen.findByTestId("probe-result")).toHaveTextContent("Probe failed: upstream returned 401");
    expect(await screen.findByText("Reason: upstream returned 401")).toBeInTheDocument();
  });

  it("renames an account", async () => {
    const { user } = await renderPage("/accounts?selected=acc_console");

    await user.click(screen.getByRole("button", { name: "Rename account" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    await user.clear(input);
    await user.type(input, "console-main{Enter}");

    expect(await screen.findByRole("heading", { name: "console-main" })).toBeInTheDocument();
    expect(mockAccount("acc_console").name).toBe("console-main");
  });

  it("shows a duplicate-name error inline", async () => {
    const { user } = await renderPage("/accounts?selected=acc_console");

    await user.click(screen.getByRole("button", { name: "Rename account" }));
    const input = screen.getByRole("textbox", { name: "Account name" });
    await user.clear(input);
    await user.type(input, "alice-max{Enter}");

    expect(await screen.findByText("an account named 'alice-max' already exists")).toBeInTheDocument();
  });

  it("changes the routing policy", async () => {
    const { user } = await renderPage("/accounts?selected=acc_console");

    await user.click(screen.getByRole("combobox", { name: "Routing policy" }));
    await user.click(await screen.findByRole("option", { name: "Preserve" }));

    await waitFor(() => expect(mockAccount("acc_console").routing_policy).toBe("preserve"));
  });

  it("sets, shows and removes a spend cap", async () => {
    const { user } = await renderPage("/accounts?selected=acc_console");

    expect(screen.getByTestId("spend-summary")).toHaveTextContent("$3.21 / $10.00");

    const cap = screen.getByLabelText("Spend cap (USD)");
    await user.clear(cap);
    await user.type(cap, "2.5");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockAccount("acc_console").spend_cap_usd).toBe(2.5));
    expect((await screen.findAllByText("Spend cap reached")).length).toBe(2);
    expect(screen.getByText(/Cap reached — no traffic goes here/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove cap" }));
    await waitFor(() => expect(mockAccount("acc_console").spend_cap_usd).toBeNull());
    expect(await screen.findByTestId("spend-summary")).toHaveTextContent("$3.21 spent · no cap");
  });

  it("resets quota state after confirming", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole("button", { name: "Reset quota state" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Reset quota state" }));

    await waitFor(() => expect(mockAccount("acc_max").primary_used_percent).toBeNull());
    expect(mockAccount("acc_max").model_blocks).toEqual([]);
  });

  it("deletes an account with its history after confirming", async () => {
    const { user } = await renderPage("/accounts?selected=acc_paused");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete backup-key?")).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText("Also delete its request logs and usage history"));
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(getMockAccounts().some((account) => account.id === "acc_paused")).toBe(false));
  });

  it("filters the list by status and search", async () => {
    const { user } = await renderPage();
    const list = screen.getByTestId("account-list-scroll-region");

    await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
    await user.click(await screen.findByRole("option", { name: "Paused" }));
    await waitFor(() => expect(within(list).queryByText("console")).not.toBeInTheDocument());
    expect(within(list).getByText("backup-key")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
    await user.click(await screen.findByRole("option", { name: "All statuses" }));
    await user.type(screen.getByRole("textbox", { name: "Search accounts…" }), "zzz");
    expect(await within(list).findByText("No matching accounts")).toBeInTheDocument();
  });

  it("shows an empty state with no accounts", async () => {
    setMockAccounts([]);
    await renderPage();

    expect(screen.getByText("No accounts yet")).toBeInTheDocument();
    expect(screen.getByText("No account selected")).toBeInTheDocument();
  });
});
