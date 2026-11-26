import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { StickySessionsPage } from "@/features/sticky-sessions/components/sticky-sessions-page";
import { parseStickyFilters, writeStickyFilters } from "@/features/sticky-sessions/hooks/use-sticky-sessions";
import { getMockStickyEntries, setMockStickyEntries } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

async function renderPage(path = "/sticky-sessions") {
  window.history.pushState({}, "", path);
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  renderWithProviders(<StickySessionsPage />);
  await screen.findByTestId("sticky-table");
  return { user };
}

async function confirmDelete(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
}

describe("StickySessionsPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("lists entries with account, remaining time and the in-memory note", async () => {
    await renderPage();

    expect(screen.getByTestId("sticky-size")).toHaveTextContent("4 of 10,000 entries");
    expect(screen.getByText(/lives in the server process's memory/)).toBeInTheDocument();
    expect(screen.getByText("1 expired")).toBeInTheDocument();
    const first = screen.getByTestId("sticky-row-aaaaaaaa…aaaa");
    expect(within(first).getByText("alice-max")).toBeInTheDocument();
    expect(within(first).getByText(/^in \d+m$/)).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: "Requests" })).toHaveAttribute(
      "href",
      `/dashboard?session=${"a".repeat(64)}`,
    );
    expect(within(screen.getByTestId("sticky-row-dddddddd…dddd")).getByText("Expired")).toBeInTheDocument();
  });

  it("deletes one entry after confirmation", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole("button", { name: "Delete bbbbbbbb…bbbb" }));
    await confirmDelete(user);

    await waitFor(() => expect(screen.queryByTestId("sticky-row-bbbbbbbb…bbbb")).not.toBeInTheDocument());
    expect(getMockStickyEntries().map((entry) => entry.key[0])).toEqual(["a", "c", "d"]);
  });

  it("selects all on the page and deletes the selection", async () => {
    const { user } = await renderPage();

    const deleteSelected = screen.getByRole("button", { name: "Delete selected (0)" });
    expect(deleteSelected).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("checkbox", { name: "Select cccccccc…cccc" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (3)" }));
    expect(await screen.findByText("Delete 3 sticky sessions?")).toBeInTheDocument();
    await confirmDelete(user);

    await waitFor(() => expect(getMockStickyEntries().map((entry) => entry.key[0])).toEqual(["c"]));
  });

  it("filters by account and deletes all of that account's entries", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole("combobox", { name: "Filter by account" }));
    await user.click(await screen.findByRole("option", { name: "console (2)" }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("account")).toBe("acc_console"));
    await waitFor(() => expect(screen.queryByTestId("sticky-row-aaaaaaaa…aaaa")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Delete all for console" }));
    expect(
      await screen.findByText("2 conversations pinned to console will pick an account afresh."),
    ).toBeInTheDocument();
    await confirmDelete(user);

    await waitFor(() => expect(getMockStickyEntries().every((entry) => entry.account_id !== "acc_console")).toBe(true));
  });

  it("purges expired entries and hides them on request", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole("switch", { name: "Show expired" }));
    await waitFor(() => expect(screen.queryByTestId("sticky-row-dddddddd…dddd")).not.toBeInTheDocument());
    expect(new URLSearchParams(window.location.search).get("expired")).toBe("hide");

    await user.click(screen.getByRole("button", { name: "Purge expired (1)" }));
    await confirmDelete(user);
    await waitFor(() => expect(getMockStickyEntries()).toHaveLength(3));
    expect(await screen.findByRole("button", { name: "Purge expired (0)" })).toBeDisabled();
  });

  it("shows the empty state when the map is empty", async () => {
    setMockStickyEntries([]);
    window.history.pushState({}, "", "/sticky-sessions");
    await useAuthStore.getState().refreshSession();
    renderWithProviders(<StickySessionsPage />);
    expect(await screen.findByText("No sticky sessions")).toBeInTheDocument();
  });

  it("round-trips filters through URL params", () => {
    const filters = parseStickyFilters(new URLSearchParams("account=acc_1&search=ab&expired=hide&limit=50&offset=50"));
    expect(filters).toEqual({ accountId: "acc_1", search: "ab", includeExpired: false, limit: 50, offset: 50 });
    expect(writeStickyFilters(filters).toString()).toBe("account=acc_1&search=ab&expired=hide&limit=50&offset=50");
  });
});
