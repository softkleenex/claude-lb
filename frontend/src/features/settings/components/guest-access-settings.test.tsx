import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { GuestAccessSettings } from "@/features/settings/components/guest-access-settings";
import { setMockAuth } from "@/test/mocks/handlers";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

async function renderCard() {
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  renderWithProviders(<GuestAccessSettings />);
  await screen.findByText(/No guest password/);
  return { user };
}

async function confirm(user: ReturnType<typeof userEvent.setup>, label: string) {
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: label }));
}

describe("GuestAccessSettings", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("turns guest access on after a confirmation that explains the exposure", async () => {
    const bodies: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "PATCH" && request.url.endsWith("/api/auth/guest")) bodies.push(await request.clone().json());
    });
    const { user } = await renderCard();
    await user.click(screen.getByRole("switch", { name: "Allow guest sign-in" }));
    expect(await screen.findByText(/without a password/)).toBeInTheDocument();
    await confirm(user, "Turn on");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Allow guest sign-in" })).toBeChecked());
    expect(bodies).toEqual([{ enabled: true }]);
    await waitFor(() => expect(useAuthStore.getState().guestAccessEnabled).toBe(true));
    server.events.removeAllListeners();
  });

  it("sets and removes a guest password", async () => {
    const { user } = await renderCard();
    const input = screen.getByLabelText("Guest password (optional)");
    await user.type(input, "short");
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set password" })).toBeDisabled();
    await user.type(input, "-but-longer");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    await confirm(user, "Set password");
    expect(await screen.findByText(/A guest password is set/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove password" }));
    await confirm(user, "Remove");
    expect(await screen.findByText(/No guest password/)).toBeInTheDocument();
  });

  it("explains that a dashboard password is needed first", async () => {
    setMockAuth({ configured: false, authenticated: true });
    server.use(http.get("/api/auth/guest", () => HttpResponse.json({ enabled: false, password_set: false })));
    await renderCard();
    expect(screen.getByText(/Set a dashboard password first/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Allow guest sign-in" })).toBeDisabled();
  });
});
