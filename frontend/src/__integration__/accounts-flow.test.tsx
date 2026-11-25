import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import i18n from "@/i18n";
import { getMockAccounts } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

describe("accounts flow integration", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("opens the Accounts page from the shell and pauses the selected account", async () => {
    const user = userEvent.setup({ delay: null });
    window.history.pushState({}, "", "/accounts");
    renderWithProviders(<App />);

    expect(await screen.findByRole("heading", { name: "Accounts", level: 1 })).toBeInTheDocument();
    const layout = await screen.findByTestId("accounts-layout");
    expect(within(layout).getByRole("heading", { name: "alice-max" })).toBeInTheDocument();

    await user.click(within(layout).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(getMockAccounts().find((a) => a.id === "acc_max")?.paused).toBe(true));
    expect(await within(layout).findByRole("button", { name: "Resume" })).toBeInTheDocument();
  });

  it("renders in Korean", async () => {
    await i18n.changeLanguage("ko");
    window.history.pushState({}, "", "/accounts");
    renderWithProviders(<App />);

    const layout = await screen.findByTestId("accounts-layout");
    expect(within(layout).getByText("5시간 한도")).toBeInTheDocument();
    expect(within(layout).getByText("이 구독이 거부하는 모델")).toBeInTheDocument();
    expect(within(layout).getByRole("button", { name: "지금 점검" })).toBeInTheDocument();
    expect(within(layout).getAllByText("우선 소진").length).toBeGreaterThan(0);
  });
});
