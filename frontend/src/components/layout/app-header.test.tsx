import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AppHeader } from "@/components/layout/app-header";
import { useThemeStore } from "@/hooks/use-theme";
import { server } from "@/test/mocks/server";

/** `GET /api/accounts` in claude-lb returns a bare array of `AccountOut` (snake_case). */
function account(id: string, available: boolean) {
  return { id, name: id, enabled: true, available, quota_observed_at: null };
}

function renderHeader(props: Partial<Parameters<typeof AppHeader>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppHeader onLogout={vi.fn()} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppHeader", () => {
  it("renders the five core destinations and the Advanced menu", async () => {
    renderHeader();

    expect(await screen.findByRole("link", { name: /Dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reports/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Accounts/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /APIs/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Advanced" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Automations" })).not.toBeInTheDocument();
  });

  it("lists the audit log, model catalog and sticky sessions under Advanced", async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(await screen.findByRole("menuitem", { name: "Audit log" })).toHaveAttribute("href", "/audit");
    expect(screen.getByRole("menuitem", { name: "Model catalog" })).toHaveAttribute("href", "/models");
    expect(screen.getByRole("menuitem", { name: "Sticky sessions" })).toHaveAttribute("href", "/sticky-sessions");
  });

  it("shows the Advanced pages in the mobile menu", async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/audit");
    expect(within(dialog).getByRole("link", { name: "Model catalog" })).toHaveAttribute("href", "/models");
    expect(within(dialog).getByRole("link", { name: "Sticky sessions" })).toHaveAttribute("href", "/sticky-sessions");
  });

  it("badges Accounts with the number of available accounts", async () => {
    server.use(
      http.get("/api/accounts", () => HttpResponse.json([account("a", true), account("b", true), account("c", false)])),
    );

    renderHeader();

    expect(await screen.findAllByLabelText("2 of 3 accounts available")).not.toHaveLength(0);
  });

  it("hides the Accounts badge when there are no accounts", async () => {
    server.use(http.get("/api/accounts", () => HttpResponse.json([])));

    renderHeader();

    await screen.findByRole("link", { name: /Accounts/i });
    await waitFor(() => {
      expect(screen.queryByLabelText(/accounts available/)).not.toBeInTheDocument();
    });
  });

  it("switches the theme from the header menu", async () => {
    const user = userEvent.setup();
    useThemeStore.getState().setTheme("light");
    renderHeader();

    await user.click(screen.getByRole("button", { name: "Theme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Dark" }));

    expect(useThemeStore.getState().preference).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    useThemeStore.getState().setTheme("light");
  });

  it("only shows Sign out when asked to", () => {
    const onLogout = vi.fn();
    const { unmount } = renderHeader({ showLogout: false, onLogout });
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    unmount();

    renderHeader({ showLogout: true, onLogout });
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
