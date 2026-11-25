import { beforeEach, describe, expect, it, vi } from "vitest";

function installLocalStorageMock() {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
    },
  });
}

describe("useDashboardPreferencesStore", () => {
  beforeEach(() => {
    installLocalStorageMock();
    vi.resetModules();
  });

  it("defaults account view mode to cards", async () => {
    const { useDashboardPreferencesStore } = await import("@/hooks/use-dashboard-preferences");

    useDashboardPreferencesStore.getState().initializePreferences();

    expect(useDashboardPreferencesStore.getState().accountViewMode).toBe("cards");
    expect(useDashboardPreferencesStore.getState().accountListSort).toBeNull();
    expect(window.localStorage.getItem("claude-lb-dashboard-account-view-mode")).toBe("cards");
    expect(window.localStorage.getItem("claude-lb-dashboard-account-list-sort:v2")).toBeNull();
  });

  it("persists account view mode updates", async () => {
    const { useDashboardPreferencesStore } = await import("@/hooks/use-dashboard-preferences");

    useDashboardPreferencesStore.getState().setAccountViewMode("list");

    expect(useDashboardPreferencesStore.getState().accountViewMode).toBe("list");
    expect(window.localStorage.getItem("claude-lb-dashboard-account-view-mode")).toBe("list");
  });

  it("persists account list sort updates", async () => {
    const { useDashboardPreferencesStore } = await import("@/hooks/use-dashboard-preferences");

    useDashboardPreferencesStore.getState().setAccountListSort({ key: "sevenDay", direction: "asc" });

    expect(useDashboardPreferencesStore.getState().accountListSort).toEqual({ key: "sevenDay", direction: "asc" });
    expect(window.localStorage.getItem("claude-lb-dashboard-account-list-sort:v2")).toBe(
      JSON.stringify({ key: "sevenDay", direction: "asc" }),
    );
  });

  it("restores a stored account list sort", async () => {
    window.localStorage.setItem(
      "claude-lb-dashboard-account-list-sort:v2",
      JSON.stringify({ key: "cost", direction: "desc" }),
    );
    const { useDashboardPreferencesStore } = await import("@/hooks/use-dashboard-preferences");

    useDashboardPreferencesStore.getState().initializePreferences();

    expect(useDashboardPreferencesStore.getState().accountListSort).toEqual({ key: "cost", direction: "desc" });
  });

  it("ignores invalid stored account list sort", async () => {
    window.localStorage.setItem(
      "claude-lb-dashboard-account-list-sort:v2",
      JSON.stringify({ key: "invalid", direction: "desc" }),
    );
    const { useDashboardPreferencesStore } = await import("@/hooks/use-dashboard-preferences");

    useDashboardPreferencesStore.getState().initializePreferences();

    expect(useDashboardPreferencesStore.getState().accountListSort).toBeNull();
    expect(window.localStorage.getItem("claude-lb-dashboard-account-list-sort:v2")).toBeNull();
  });
});
