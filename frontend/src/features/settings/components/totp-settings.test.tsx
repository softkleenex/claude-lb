import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { TotpSettings } from "@/features/settings/components/totp-settings";
import { MOCK_TOTP_CODE } from "@/test/mocks/factories";
import { setMockAuth } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

describe("TotpSettings", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("enrolls with a client-rendered QR code and confirms with a code", async () => {
    const user = userEvent.setup({ delay: null });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<TotpSettings />);
    expect(screen.getByText("Off — sign-in needs only the password.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Enable" }));
    const dialog = await screen.findByRole("dialog");
    const qr = await within(dialog).findByRole("img", { name: "QR code for your authenticator app" });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+,\d+h1v1h-1z/);
    expect(within(dialog).getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Code from the app"), "000000");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(await within(dialog).findByText("that code did not match")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Code from the app"), MOCK_TOTP_CODE);
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));

    await waitFor(() => expect(useAuthStore.getState().totpEnabled).toBe(true));
    expect(await screen.findByText("Sign-in asks for a code from your authenticator app.")).toBeInTheDocument();
  });

  it("disables TOTP after confirmation", async () => {
    const user = userEvent.setup({ delay: null });
    setMockAuth({ totpEnabled: true });
    await useAuthStore.getState().refreshSession();

    renderWithProviders(<TotpSettings />);
    await user.click(screen.getByRole("button", { name: "Disable" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Turn off" }));

    await waitFor(() => expect(useAuthStore.getState().totpEnabled).toBe(false));
  });
});
