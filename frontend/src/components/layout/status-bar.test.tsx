import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusBar, type StatusBarProps } from "@/components/layout/status-bar";
import i18n from "@/i18n";
import { useDateDisplayFormatStore } from "@/hooks/use-date-format";
import { createSettingsEnvelope, type RuntimeSettingsWire } from "@/test/mocks/factories";
import { server } from "@/test/mocks/server";
import { formatTimeLong } from "@/utils/formatters";

function renderStatusBar(props: StatusBarProps = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <StatusBar {...props} />
    </QueryClientProvider>,
  );
}

function mockSettings(overrides: Partial<RuntimeSettingsWire> = {}) {
  server.use(http.get("/api/settings", () => HttpResponse.json(createSettingsEnvelope(overrides))));
}

/** claude-lb `AccountOut` rows; SQLite timestamps come back without an offset. */
function mockAccounts(observedAt: Array<string | null>) {
  server.use(
    http.get("/api/accounts", () =>
      HttpResponse.json(
        observedAt.map((quota_observed_at, index) => ({
          id: `acc-${index}`,
          name: `acc-${index}`,
          enabled: true,
          available: true,
          quota_observed_at,
        })),
      ),
    ),
  );
}

function naiveUtc(date: Date): string {
  return date.toISOString().replace("Z", "");
}

describe("StatusBar", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows ready service and fresh usage from the newest quota observation", async () => {
    mockAccounts([naiveUtc(new Date(Date.now() - 60 * 60_000)), naiveUtc(new Date(Date.now() - 30_000)), null]);

    renderStatusBar();

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
  });

  it("marks usage stale when nothing was observed within two probe intervals", async () => {
    mockSettings({ health_probe_interval_seconds: 120 });
    mockAccounts([naiveUtc(new Date(Date.now() - 30 * 60_000))]);

    renderStatusBar();

    expect(await screen.findByText("Stale")).toBeInTheDocument();
  });

  it("says usage was never observed for accounts without quota data", async () => {
    mockAccounts([null]);

    renderStatusBar();

    expect(await screen.findByText("Not yet observed")).toBeInTheDocument();
  });

  it("hides usage sync when there are no accounts", async () => {
    mockAccounts([]);

    renderStatusBar();

    await screen.findByText("Ready");
    expect(screen.queryByText("Usage sync:")).not.toBeInTheDocument();
  });

  it("shows not ready when the readiness probe fails", async () => {
    server.use(http.get("/health/ready", () => HttpResponse.json({ status: "unavailable" }, { status: 503 })));

    renderStatusBar();

    expect(await screen.findByText("Not ready")).toBeInTheDocument();
  });

  it("shows checking while readiness is pending", async () => {
    let resolveReadiness!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveReadiness = resolve;
    });
    server.use(
      http.get("/health/ready", async () => {
        await pending;
        return HttpResponse.json({ status: "ok", version: "0.6.1" });
      }),
    );

    renderStatusBar();

    expect(screen.getByText("Checking")).toBeInTheDocument();
    await act(async () => {
      resolveReadiness();
    });
    expect(await screen.findByText("Ready")).toBeInTheDocument();
  });

  it("updates the last sync clock when the date format changes", async () => {
    const observed = new Date(Date.now() - 10_000);
    mockAccounts([naiveUtc(observed)]);
    useDateDisplayFormatStore.setState({ dateDisplayFormat: "default" });

    renderStatusBar();

    const footer = screen.getByRole("contentinfo");
    await screen.findByText("Up to date");
    expect(footer).toHaveTextContent(formatTimeLong(observed.toISOString(), "default").time);

    act(() => {
      useDateDisplayFormatStore.setState({ dateDisplayFormat: "iso8601" });
    });
    expect(footer).toHaveTextContent(formatTimeLong(observed.toISOString(), "iso8601").time);
  });

  it("shows the server version from /health", async () => {
    server.use(http.get("/health", () => HttpResponse.json({ status: "ok", version: "9.9.9" })));

    renderStatusBar();

    expect(await screen.findByText("9.9.9")).toBeInTheDocument();
  });

  it("labels the routing strategy with sticky sessions", async () => {
    mockSettings({ routing_strategy: "reset_drain", sticky_sessions_enabled: true });

    renderStatusBar();

    expect(await screen.findByText("Reset drain + Sticky sessions")).toBeInTheDocument();
  });

  it("drops the sticky suffix when sticky sessions are off or ignored", async () => {
    mockSettings({ routing_strategy: "single_account", sticky_sessions_enabled: true });

    renderStatusBar();

    expect(await screen.findByText("Single account")).toBeInTheDocument();
  });

  it("localizes the routing label in Korean", async () => {
    await i18n.changeLanguage("ko");
    mockSettings({ routing_strategy: "round_robin", sticky_sessions_enabled: false });

    renderStatusBar();

    expect(await screen.findByText("라운드 로빈")).toBeInTheDocument();
  });

  it("reports its resized height so wrapped rows remain clear of page content", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(40);
    const resizeObserver = vi
      .spyOn(globalThis, "ResizeObserver")
      .mockImplementation(
        class {
          constructor(callback: ResizeObserverCallback) {
            resizeCallback = callback;
          }

          observe = observe;
          unobserve = vi.fn();
          disconnect = disconnect;
        },
      );
    const onHeightChange = vi.fn();

    try {
      const { unmount } = renderStatusBar({ onHeightChange });

      expect(onHeightChange).toHaveBeenLastCalledWith(40);
      expect(observe).toHaveBeenCalledWith(screen.getByRole("contentinfo"));

      offsetHeight.mockReturnValue(72);
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });

      expect(onHeightChange).toHaveBeenLastCalledWith(72);

      unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      resizeObserver.mockRestore();
      offsetHeight.mockRestore();
    }
  });

  it("collapses into one tappable line on small screens and reveals details on tap", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
        ({
          matches: query === "(max-width: 639px)",
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
    mockAccounts([naiveUtc(new Date(Date.now() - 30_000))]);
    mockSettings({ routing_strategy: "reset_drain", sticky_sessions_enabled: true });
    server.use(http.get("/health", () => HttpResponse.json({ status: "ok", version: "9.9.9" })));

    try {
      renderStatusBar();

      const trigger = screen.getByRole("button", { name: "Show service status details" });
      expect(await screen.findByText("Ready")).toBeInTheDocument();
      expect(await screen.findByText(/Up to date/)).toBeInTheDocument();
      expect(await screen.findByText("v9.9.9")).toBeInTheDocument();
      // Labels and the long routing text stay out of the compact line.
      expect(screen.queryByText("Service:")).not.toBeInTheDocument();
      expect(screen.queryByText(/Reset drain/)).not.toBeInTheDocument();

      await userEvent.click(trigger);

      expect(await screen.findByText("Reset drain + Sticky sessions")).toBeInTheDocument();
      expect(screen.getByText("Routing:")).toBeInTheDocument();
      expect(screen.getByText("Version:")).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("links to the GitHub repository", () => {
    renderStatusBar();

    const link = screen.getByRole("link", { name: "Open the GitHub repository" });
    expect(link).toHaveAttribute("href", "https://github.com/softkleenex/claude-lb");
  });
});
