import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { SettingsPage } from "@/features/settings/components/settings-page";
import { getMockSettings, setMockAuth } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

async function renderPage() {
  await useAuthStore.getState().refreshSession();
  return renderWithProviders(<SettingsPage />);
}

describe("SettingsPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("renders claude-lb's cards and none of codex-lb's", async () => {
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Routing" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Background jobs" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Data retention" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dashboard password" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Two-factor authentication (TOTP)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reset to defaults" })).toBeInTheDocument();
    for (const gone of [/warm-?up/i, /reset credit/i, /websocket/i, /quota planner/i, /upstream proxy/i, /firewall/i, /guest/i]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });

  it("lists every strategy with a guide and marks the current one", async () => {
    await renderPage();

    const guide = await screen.findByRole("list", { name: "Strategy guide" });
    const items = within(guide).getAllByRole("listitem");
    expect(items).toHaveLength(9);
    expect(items.find((item) => item.dataset.active === "true")).toHaveTextContent("Capacity weighted");
    expect(guide).toHaveTextContent("Least used");
  });

  it("changes the routing strategy", async () => {
    const user = userEvent.setup({ delay: null });
    await renderPage();

    await user.click(await screen.findByRole("combobox", { name: "Routing strategy" }));
    await user.click(await screen.findByRole("option", { name: "Round robin" }));

    await waitFor(() => expect(getMockSettings().routing_strategy).toBe("round_robin"));
    await waitFor(() => {
      const active = within(screen.getByRole("list", { name: "Strategy guide" }))
        .getAllByRole("listitem")
        .find((item) => item.dataset.active === "true");
      expect(active).toHaveTextContent("Round robin");
    });
  });

  it("toggles sticky sessions and saves numeric settings within bounds", async () => {
    const user = userEvent.setup({ delay: null });
    await renderPage();

    await user.click(await screen.findByRole("switch", { name: "Sticky sessions" }));
    await waitFor(() => expect(getMockSettings().sticky_sessions_enabled).toBe(false));

    const retention = screen.getByRole("spinbutton", { name: "Request log retention" });
    await user.clear(retention);
    await user.type(retention, "0");
    expect(await screen.findByText("Enter a whole number from 1 to 3650.")).toBeInTheDocument();

    await user.clear(retention);
    await user.type(retention, "90");
    const row = retention.closest("div.space-y-1\\.5") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(getMockSettings().request_log_retention_days).toBe(90));
  });

  it("shows the sticky TTL as a readable duration", async () => {
    await renderPage();

    expect(await screen.findByText("= 15 minutes")).toBeInTheDocument();
  });

  it("resets settings after confirmation", async () => {
    const user = userEvent.setup({ delay: null });
    await renderPage();
    await user.click(await screen.findByRole("switch", { name: "Model list sync" }));
    await waitFor(() => expect(getMockSettings().model_sync_enabled).toBe(false));

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await user.click(await screen.findByRole("button", { name: "Reset settings" }));

    await waitFor(() => expect(getMockSettings().model_sync_enabled).toBe(true));
  });

  it("hides TOTP until a password exists", async () => {
    setMockAuth({ configured: false, authenticated: true, password: null });
    await renderPage();

    expect(await screen.findByRole("heading", { name: "Dashboard password" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Two-factor authentication (TOTP)" })).not.toBeInTheDocument();
  });
});
