import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { LoginForm } from "@/features/auth/components/login-form";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { MOCK_DASHBOARD_PASSWORD, MOCK_TOTP_CODE } from "@/test/mocks/factories";
import { setMockAuth } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

describe("LoginForm", () => {
  beforeEach(async () => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("signs in with the password alone when TOTP is off", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ authenticated: false });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<LoginForm />);
    await user.type(screen.getByLabelText("Password"), MOCK_DASHBOARD_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(useAuthStore.getState().authenticated).toBe(true));
  });

  it("shows the server's error for a wrong password", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ authenticated: false });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<LoginForm />);
    await user.type(screen.getByLabelText("Password"), "wrong-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Wrong password or authentication code.")).toBeInTheDocument();
    expect(useAuthStore.getState().authenticated).toBe(false);
  });

  it("asks for the TOTP code in a second step and sends both together", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ authenticated: false, totpEnabled: true });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<LoginForm />);
    await user.type(screen.getByLabelText("Password"), MOCK_DASHBOARD_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("heading", { name: "Two-factor verification" })).toBeInTheDocument();
    expect(useAuthStore.getState().authenticated).toBe(false);

    await user.type(screen.getByLabelText("Authentication code"), MOCK_TOTP_CODE);

    await waitFor(() => expect(useAuthStore.getState().authenticated).toBe(true));
  });

  it("lets the user go back from the TOTP step after a wrong code", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ authenticated: false, totpEnabled: true });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<LoginForm />);
    await user.type(screen.getByLabelText("Password"), MOCK_DASHBOARD_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(await screen.findByLabelText("Authentication code"), "000000");

    expect(await screen.findByText("Wrong password or authentication code.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});
