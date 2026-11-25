import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { renderWithProviders } from "@/test/utils";

describe("Advanced pages", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it.each([
    ["/audit", "Audit log", "audit-row-evt_0004"],
    ["/models", "Model catalog", "models-table"],
    ["/sticky-sessions", "Sticky sessions", "sticky-table"],
    ["/automations", "Automations", "automation-job_1"],
  ])("lazy-loads %s", async (path, title, testId) => {
    window.history.pushState({}, "", path);
    renderWithProviders(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(await screen.findByTestId(testId)).toBeInTheDocument();
  });

  it("navigates from the Advanced menu and from a sticky entry to its requests", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/dashboard");
    renderWithProviders(<App />);

    await user.click(await screen.findByRole("button", { name: "Advanced" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sticky sessions" }));
    const row = await screen.findByTestId("sticky-row-aaaaaaaa…aaaa");
    await user.click(within(row).getByRole("link", { name: "Requests" }));

    expect(window.location.pathname).toBe("/dashboard");
    expect(new URLSearchParams(window.location.search).get("session")).toBe("a".repeat(64));
    expect(await screen.findByTestId("request-row-req_0001")).toBeInTheDocument();
    expect(screen.queryByTestId("request-row-req_0002")).not.toBeInTheDocument();
  });
});
