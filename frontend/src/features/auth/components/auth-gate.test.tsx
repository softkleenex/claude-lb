import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { AuthGate } from "@/features/auth/components/auth-gate";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { setMockAuth } from "@/test/mocks/handlers";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

function renderGate() {
  return renderWithProviders(
    <AuthGate>
      <div>app content</div>
    </AuthGate>,
  );
}

describe("AuthGate", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("renders the app when signed in", async () => {
    renderGate();

    expect(await screen.findByText("app content")).toBeInTheDocument();
  });

  it("renders the app on loopback before a password exists", async () => {
    setMockAuth({ configured: false, authenticated: true });

    renderGate();

    expect(await screen.findByText("app content")).toBeInTheDocument();
  });

  it("shows sign-in when a password is set and there is no session", async () => {
    setMockAuth({ authenticated: false });

    renderGate();

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });

  it("shows remote first-time setup with a bootstrap token field", async () => {
    setMockAuth({ configured: false, authenticated: false, password: null });

    renderGate();

    expect(await screen.findByRole("heading", { name: "Set up dashboard access" })).toBeInTheDocument();
    expect(screen.getByLabelText("Bootstrap token")).toBeInTheDocument();
  });

  it("offers a retry when the status request fails", async () => {
    server.use(http.get("/api/auth/status", () => HttpResponse.error()));

    renderGate();

    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
