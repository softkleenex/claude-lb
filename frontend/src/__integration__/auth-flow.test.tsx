import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { MOCK_BOOTSTRAP_TOKEN, MOCK_DASHBOARD_PASSWORD, MOCK_TOTP_CODE } from "@/test/mocks/factories";
import { setMockAuth } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

describe("auth flow integration", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("signs in with password and TOTP, then reaches the app", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ authenticated: false, totpEnabled: true });

    window.history.pushState({}, "", "/settings");
    renderWithProviders(<App />);

    await user.type(await screen.findByLabelText("Password"), MOCK_DASHBOARD_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(await screen.findByLabelText("Authentication code"), MOCK_TOTP_CODE);

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("sets the first password remotely with the bootstrap token", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ configured: false, authenticated: false, password: null });

    window.history.pushState({}, "", "/settings");
    renderWithProviders(<App />);

    await user.type(await screen.findByLabelText("New password"), "long-enough-pw");
    await user.type(screen.getByLabelText("Confirm password"), "long-enough-pw");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("Enter the bootstrap token from the server log.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Bootstrap token"), MOCK_BOOTSTRAP_TOKEN);
    await user.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
  });

  it("warns on loopback without a password and sets one from the banner", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ configured: false, authenticated: true, password: null });

    window.history.pushState({}, "", "/settings");
    renderWithProviders(<App />);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("No dashboard password is set.");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Set password" })[0]!);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("New password"), "long-enough-pw");
    await user.type(within(dialog).getByLabelText("Confirm password"), "long-enough-pw");
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("signs out back to the sign-in screen", async () => {
    const user = userEvent.setup({ delay: null });

    window.history.pushState({}, "", "/settings");
    renderWithProviders(<App />);

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});
