import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { setMockAuth, setMockGuest } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

describe("guest (read-only) flow", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("does not offer guest sign-in while guest access is off", async () => {
    setMockAuth({ authenticated: false });
    renderWithProviders(<App />);
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue as guest" })).not.toBeInTheDocument();
  });

  it("signs in as a guest and shows a read-only app", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ authenticated: false });
    setMockGuest({ enabled: true });

    window.history.pushState({}, "", "/automations");
    renderWithProviders(<App />);
    await user.click(await screen.findByRole("button", { name: "Continue as guest" }));

    expect(await screen.findByText(/Guest view — read-only/)).toBeInTheDocument();
    expect(useAuthStore.getState()).toMatchObject({ role: "guest", canWrite: false, permissions: ["read"] });
    // Automations: visible, but no create / run / edit / delete, and the switch is disabled.
    expect(await screen.findByTestId("automation-job_1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New automation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run Morning window now" })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Disable Morning window" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("asks for the guest password when one is set and rejects a wrong one", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ authenticated: false });
    setMockGuest({ enabled: true, password: "guest-pass-1" });

    window.history.pushState({}, "", "/settings");
    renderWithProviders(<App />);
    await user.click(await screen.findByRole("button", { name: "Continue as guest" }));
    const input = await screen.findByLabelText("Guest password");
    await user.type(input, "wrong-pass");
    await user.click(screen.getByRole("button", { name: "View as guest" }));
    expect(await screen.findByText("Wrong password or authentication code.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Guest password"), "guest-pass-1");
    await user.click(screen.getByRole("button", { name: "View as guest" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // Settings for a guest: no password/TOTP/guest/reset cards, firewall read-only.
    expect(screen.queryByRole("heading", { name: "Dashboard password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Guest access" })).not.toBeInTheDocument();
    const firewall = await screen.findByRole("heading", { name: "IP firewall" });
    const card = firewall.closest("section");
    expect(card).not.toBeNull();
    await waitFor(() => expect(within(card as HTMLElement).getByText("10.0.0.0/8")).toBeInTheDocument());
    expect(within(card as HTMLElement).queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });
});
