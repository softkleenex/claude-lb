import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { useSettings } from "@/features/settings/hooks/use-settings";
import { getMockSettings } from "@/test/mocks/handlers";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useSettings", () => {
  it("loads the envelope with camelCase keys", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.settingsQuery.isSuccess).toBe(true));
    expect(result.current.settingsQuery.data?.settings).toMatchObject({
      routingStrategy: "capacity_weighted",
      stickySessionsEnabled: true,
      stickyTtlSeconds: 900,
      requestLogRetentionDays: 30,
    });
    expect(result.current.settingsQuery.data?.availableStrategies).toContain("least_used");
  });

  it("patches only the changed key in snake_case and stores the response", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.settingsQuery.isSuccess).toBe(true));

    await act(async () => {
      await result.current.updateSettingsMutation.mutateAsync({ routingStrategy: "round_robin", maxAttempts: 5 });
    });

    expect(getMockSettings()).toMatchObject({ routing_strategy: "round_robin", max_attempts: 5 });
    await waitFor(() =>
      expect(result.current.settingsQuery.data?.settings).toMatchObject({ routingStrategy: "round_robin", maxAttempts: 5 }),
    );
  });

  it("surfaces the server's validation error", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.settingsQuery.isSuccess).toBe(true));

    await act(async () => {
      await expect(result.current.updateSettingsMutation.mutateAsync({ maxAttempts: 99 })).rejects.toThrow(
        "max_attempts must be between 1 and 10",
      );
    });
  });

  it("resets to defaults", async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.settingsQuery.isSuccess).toBe(true));
    await act(async () => {
      await result.current.updateSettingsMutation.mutateAsync({ stickySessionsEnabled: false });
    });

    await act(async () => {
      await result.current.resetSettingsMutation.mutateAsync();
    });

    expect(getMockSettings().sticky_sessions_enabled).toBe(true);
    expect(result.current.settingsQuery.data?.settings.stickySessionsEnabled).toBe(true);
  });
});
