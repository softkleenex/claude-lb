import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { AccountsPage } from "@/features/accounts/components/accounts-page";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { getMockAccounts } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

async function openDialog() {
  window.history.pushState({}, "", "/accounts");
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  renderWithProviders(<AccountsPage />);
  await user.click(await screen.findByRole("button", { name: "Add account" }));
  const dialog = await screen.findByRole("dialog", { name: "Add account" });
  return { user, dialog };
}

function added(name: string) {
  return getMockAccounts().find((account) => account.name === name);
}

describe("AddAccountDialog", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("adds a Console API key with policy, weight, priority and spend cap", async () => {
    const { user, dialog } = await openDialog();

    await user.type(within(dialog).getByLabelText("Name"), "console-2");
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant-api03-abcdefghijkl");
    await user.click(within(dialog).getByRole("combobox", { name: "Routing policy" }));
    await user.click(await screen.findByRole("option", { name: "Burn first" }));
    const weight = within(dialog).getByLabelText("Weight");
    await user.clear(weight);
    await user.type(weight, "2");
    await user.type(within(dialog).getByLabelText("Spend cap (USD)"), "1");
    await user.click(within(dialog).getByRole("button", { name: "Add API key" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add account" })).not.toBeInTheDocument());
    const account = added("console-2");
    expect(account).toMatchObject({
      plan_type: "api",
      provider: "anthropic_api_key",
      auth_scheme: "x-api-key",
      routing_policy: "burn_first",
      weight: 2,
      priority: 0,
      spend_cap_usd: 1,
    });
    expect(await screen.findByText("console-2")).toBeInTheDocument();
  });

  it("keeps the dialog open and shows the server error on a duplicate name", async () => {
    const { user, dialog } = await openDialog();

    await user.type(within(dialog).getByLabelText("Name"), "console");
    await user.type(within(dialog).getByLabelText("API key"), "sk-ant-api03-abcdefghijkl");
    await user.click(within(dialog).getByRole("button", { name: "Add API key" }));

    expect(await within(dialog).findByText("an account named 'console' already exists")).toBeInTheDocument();
  });

  it("builds the add-subscription CLI command from the form", async () => {
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByRole("tab", { name: "Subscription" }));
    const command = within(dialog).getByTestId("add-subscription-command");
    expect(command).toHaveTextContent(
      "uv run claude-lb account add-subscription <name> --plan-type pro --routing-policy normal --transport claude_code",
    );

    await user.type(within(dialog).getByLabelText("Name"), "alice");
    await user.click(within(dialog).getByRole("combobox", { name: "Plan" }));
    await user.click(await screen.findByRole("option", { name: "Max 20x" }));
    await user.click(within(dialog).getByRole("combobox", { name: "Routing policy" }));
    await user.click(await screen.findByRole("option", { name: "Preserve" }));

    expect(command).toHaveTextContent(
      "uv run claude-lb account add-subscription alice --plan-type max_20x --routing-policy preserve --transport claude_code",
    );
    expect(within(dialog).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
  });

  it("adds a pasted subscription token as a bearer account", async () => {
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByRole("tab", { name: "Subscription" }));
    await user.type(within(dialog).getByLabelText("Name"), "bob");
    const token = within(dialog).getByLabelText("Subscription token");
    await user.type(token, "sk-ant-api03-wrong-kind-of-key");
    expect(within(dialog).getByText("Subscription tokens start with sk-ant-oat.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add subscription" })).toBeDisabled();

    await user.clear(token);
    await user.type(token, "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
    await user.click(within(dialog).getByRole("button", { name: "Add subscription" }));

    await waitFor(() => expect(added("bob")).toBeDefined());
    expect(added("bob")).toMatchObject({
      provider: "oauth",
      auth_scheme: "bearer",
      transport: "claude_code",
      plan_type: "pro",
    });
  });

  it("imports a credentials JSON file without renaming its keys", async () => {
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByRole("tab", { name: "Import file" }));
    const file = new File(
      [JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-imported-token", refreshToken: "r" } })],
      "credentials.json",
      { type: "application/json" },
    );
    await user.upload(within(dialog).getByLabelText("Credentials file"), file);
    expect(await within(dialog).findByText("Loaded credentials.json.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "imported");
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    await waitFor(() => expect(added("imported")).toBeDefined());
    expect(added("imported")).toMatchObject({
      provider: "oauth",
      auth_scheme: "bearer",
      transport: "claude_code",
    });
  });

  it("rejects a file that is not a JSON object", async () => {
    const { user, dialog } = await openDialog();

    await user.click(within(dialog).getByRole("tab", { name: "Import file" }));
    await user.upload(
      within(dialog).getByLabelText("Credentials file"),
      new File(["not json"], "bad.json", { type: "application/json" }),
    );

    expect(await within(dialog).findByText("That file is not a JSON object.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import" })).toBeDisabled();
  });
});
