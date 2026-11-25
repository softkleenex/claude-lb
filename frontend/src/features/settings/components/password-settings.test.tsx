import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { PasswordSettings } from "@/features/settings/components/password-settings";
import { MOCK_DASHBOARD_PASSWORD } from "@/test/mocks/factories";
import { setMockAuth } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

describe("PasswordSettings", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("sets the first password on loopback", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ configured: false, authenticated: true, password: null });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<PasswordSettings />);
    await user.click(screen.getByRole("button", { name: "Set password" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("New password"), "long-enough-pw");
    await user.type(within(dialog).getByLabelText("Confirm password"), "different-pw");
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));
    expect(await within(dialog).findByText("Passwords do not match.")).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText("Confirm password"));
    await user.type(within(dialog).getByLabelText("Confirm password"), "long-enough-pw");
    await user.click(within(dialog).getByRole("button", { name: "Set password" }));

    await waitFor(() => expect(useAuthStore.getState().passwordRequired).toBe(true));
    expect(useAuthStore.getState().insecure).toBe(false);
  });

  it("changes the password with the current one", async () => {
    const user = userEvent.setup({ delay: null });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<PasswordSettings />);
    await user.click(screen.getByRole("button", { name: "Change password" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Current password"), "not-the-password");
    await user.type(within(dialog).getByLabelText("New password"), "brand-new-password");
    await user.type(within(dialog).getByLabelText("Confirm password"), "brand-new-password");
    await user.click(within(dialog).getByRole("button", { name: "Change password" }));
    expect(await within(dialog).findByText("current password is incorrect")).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText("Current password"));
    await user.type(within(dialog).getByLabelText("Current password"), MOCK_DASHBOARD_PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("signs out everywhere after confirmation", async () => {
    const user = userEvent.setup({ delay: null });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<PasswordSettings />);
    await user.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Sign out everywhere" }));

    await waitFor(() => expect(useAuthStore.getState().authenticated).toBe(false));
  });

  it("offers no password actions when auth is disabled by config", async () => {
    setMockAuth({ configured: false, authenticated: true, auth_enabled: false });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<PasswordSettings />);

    expect(screen.getByText("Dashboard authentication is turned off by server configuration.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set password" })).not.toBeInTheDocument();
  });
});
