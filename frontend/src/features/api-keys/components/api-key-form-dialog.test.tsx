import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiKeyFormDialog } from "@/features/api-keys/components/api-key-form-dialog";
import { ApiKeySchema, type ApiKey } from "@/features/api-keys/schemas";
import { camelizeKeys } from "@/lib/casing";
import { createApiKeyWire, createLimitUsageWire } from "@/test/mocks/factories";
import { renderWithProviders } from "@/test/utils";

function apiKey(overrides: Parameters<typeof createApiKeyWire>[0] = {}): ApiKey {
  return ApiKeySchema.parse(camelizeKeys(createApiKeyWire(overrides)));
}

function renderForm(key: ApiKey | null = null) {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onUpdate = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const user = userEvent.setup();
  renderWithProviders(
    <ApiKeyFormDialog
      open
      busy={false}
      apiKey={key}
      onOpenChange={onOpenChange}
      onCreate={onCreate}
      onUpdate={onUpdate}
    />,
  );
  return { user, onCreate, onUpdate, onOpenChange, dialog: screen.getByRole("dialog") };
}

describe("ApiKeyFormDialog", () => {
  it("creates a key with models, accounts, expiry and several limit rules", async () => {
    const { user, onCreate, onOpenChange, dialog } = renderForm();

    await user.type(within(dialog).getByLabelText("Name"), "  ci-bot ");

    await user.click(within(dialog).getByRole("button", { name: /No expiration/ }));
    await user.click(await screen.findByRole("button", { name: /^30 days/ }));

    await user.click(within(dialog).getByLabelText("Allowed models"));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "claude-sonnet-5" }));
    await user.type(screen.getByRole("textbox", { name: "Search or type a model id" }), "claude-opus-4{Enter}");
    await user.keyboard("{Escape}");

    await user.click(within(dialog).getByLabelText("Assigned accounts"));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: /alice-max/ }));
    await user.keyboard("{Escape}");

    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
    const [first, second] = within(dialog).getAllByTestId("limit-rule-card");
    await user.type(within(first).getByLabelText("Limit (USD)"), "12.5");
    await user.click(within(second).getByRole("combobox", { name: "Measure" }));
    await user.click(await screen.findByRole("option", { name: "Requests" }));
    await user.click(within(second).getByRole("combobox", { name: "Window" }));
    await user.click(await screen.findByRole("option", { name: "Custom (rolling)" }));
    await user.clear(within(second).getByLabelText("Window length (hours)"));
    await user.type(within(second).getByLabelText("Window length (hours)"), "2");
    await user.type(within(second).getByLabelText("Limit"), "50");
    await user.type(within(second).getByLabelText("Only for model"), "claude-haiku-5");

    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    const payload = onCreate.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: "ci-bot",
      allowedModels: ["claude-sonnet-5", "claude-opus-4"],
      enforcedModel: null,
      assignedAccountIds: ["acc_max"],
      limits: [
        { metric: "cost_usd", window: "daily", maxValue: 12.5, windowSeconds: null, modelFilter: null },
        { metric: "requests", window: "custom", maxValue: 50, windowSeconds: 7200, modelFilter: "claude-haiku-5" },
      ],
    });
    const days = (new Date(payload.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(32);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("requires a name and keeps the dialog open", async () => {
    const { user, onCreate, dialog } = renderForm();
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("Enter a name")).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("warns when the enforced model is outside the allowlist", async () => {
    const { user, dialog } = renderForm(apiKey());
    await user.type(within(dialog).getByLabelText("Enforced model"), "claude-haiku-5");
    expect(within(dialog).getByText(/not in the allowed models/)).toBeInTheDocument();
  });

  it("edits only what changed", async () => {
    const key = apiKey();
    const { user, onUpdate, dialog } = renderForm(key);

    expect(within(dialog).getByLabelText("Name")).toHaveValue("claude-code-team");
    expect(within(dialog).getAllByTestId("limit-rule-card")).toHaveLength(2);
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "renamed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toEqual({ name: "renamed" });
  });

  it("replaces every rule when one is removed, and clears the allowlist", async () => {
    const { user, onUpdate, dialog } = renderForm(apiKey());
    await user.click(within(dialog).getByRole("button", { name: "Remove rule 1" }));
    await user.click(within(dialog).getByRole("button", { name: "Remove claude-sonnet-5" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toEqual({
      allowedModels: null,
      limits: [{ metric: "requests", window: "5h", maxValue: 100, windowSeconds: null, modelFilter: null }],
    });
  });

  it("explains a legacy budget and moves a pinned account into the assignment", async () => {
    const key = apiKey({
      assigned_account_ids: null,
      pinned_account_id: "acc_console",
      max_cost_usd_per_window: 25,
      limits: [
        createLimitUsageWire({ id: "legacy-cost_usd", source: "legacy", window: "custom", window_seconds: 3600, max_value: 25 }),
      ],
    });
    const { user, onUpdate, dialog } = renderForm(key);
    expect(within(dialog).getByText(/original budget is listed as rules/)).toBeInTheDocument();
    expect(await within(dialog).findByText("console")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Remove console" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0][1]).toEqual({ assignedAccountIds: null, pinnedAccountId: null });
  });

  it("disables a key from the edit form", async () => {
    const { user, onUpdate, dialog } = renderForm(apiKey());
    await user.click(within(dialog).getByRole("switch", { name: "Enabled" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdate.mock.calls[0][1]).toEqual({ enabled: false }));
  });
});
