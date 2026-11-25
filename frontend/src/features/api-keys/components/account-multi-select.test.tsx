import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createAccountWire, createSubscriptionAccountWire } from "@/test/mocks/factories";
import { setMockAccounts } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

import { AccountMultiSelect } from "./account-multi-select";

describe("AccountMultiSelect", () => {
  it("shows 5h/7d headroom for subscription accounts inside the picker", async () => {
    setMockAccounts([
      createSubscriptionAccountWire({ id: "acc_quota", name: "quota-sub", primary_used_percent: 18, secondary_used_percent: 33 }),
    ]);
    const user = userEvent.setup();

    renderWithProviders(<AccountMultiSelect value={[]} onChange={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "All accounts" }));
    expect(await screen.findByText("5h 82% left")).toBeInTheDocument();
    expect(screen.getByText("7d 67% left")).toBeInTheDocument();
  });

  it("selects an account by id", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    renderWithProviders(<AccountMultiSelect value={[]} onChange={onChange} />);

    await user.click(await screen.findByRole("button", { name: "All accounts" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: /console/i }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(["acc_console"]);
    });
  });

  it("pluralizes the selected account count", async () => {
    renderWithProviders(<AccountMultiSelect value={["acc_console", "acc_max"]} onChange={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "2 accounts" })).toBeInTheDocument();
  });

  it("hides disabled accounts and shows paused ones only when allowed", async () => {
    setMockAccounts([
      createAccountWire({ id: "acc_ok", name: "ok-key" }),
      createAccountWire({ id: "acc_broken", name: "broken-key", enabled: false, disabled_reason: "upstream returned 401" }),
      createAccountWire({ id: "acc_paused", name: "paused-key", enabled: false, disabled_reason: "paused by operator" }),
    ]);
    const user = userEvent.setup();

    const { unmount } = renderWithProviders(<AccountMultiSelect value={[]} onChange={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "All accounts" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /ok-key/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /broken-key/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /paused-key/ })).not.toBeInTheDocument();
    unmount();

    renderWithProviders(<AccountMultiSelect value={[]} onChange={vi.fn()} allowPausedAccounts />);
    await user.click(await screen.findByRole("button", { name: "All accounts" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /paused-key/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox", { name: /broken-key/ })).not.toBeInTheDocument();
  });
});
