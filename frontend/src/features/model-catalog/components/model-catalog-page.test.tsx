import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { ModelCatalogPage } from "@/features/model-catalog/components/model-catalog-page";
import { formatRate } from "@/features/model-catalog/format";
import { setMockCatalog } from "@/test/mocks/handlers";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

async function renderPage() {
  window.history.pushState({}, "", "/models");
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  renderWithProviders(<ModelCatalogPage />);
  await screen.findByTestId("models-table");
  return { user };
}

describe("ModelCatalogPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
  });

  it("shows models with serving accounts, limits and prices", async () => {
    await renderPage();

    const table = screen.getByTestId("models-table");
    const haiku = within(table).getByText("Claude Haiku 5.5").closest("tr") as HTMLElement;
    expect(within(haiku).getByText("claude-haiku-5-5-20260101")).toBeInTheDocument();
    expect(within(haiku).getByText("alice-max")).toBeInTheDocument();
    expect(within(haiku).getByText("console")).toBeInTheDocument();
    expect(within(haiku).getByText("200K")).toBeInTheDocument();
    expect(within(haiku).getByText("64K")).toBeInTheDocument();
    expect(within(haiku).getByText("$0.10 / $0.50")).toBeInTheDocument();
    expect(within(haiku).getByText("Prompts over 100K tokens: $0.50 / $2.50")).toBeInTheDocument();
    const unpriced = within(table)
      .getByText("claude-experimental-1", { selector: "div.text-sm" })
      .closest("tr") as HTMLElement;
    expect(within(unpriced).getByText("Not in the price table (counted as $0)")).toBeInTheDocument();

    expect(screen.getByText("3 models in the catalog.")).toBeInTheDocument();
    expect(screen.getByText("console · 3 models")).toBeInTheDocument();
    expect(screen.getByText("backup-key · not synced")).toBeInTheDocument();
  });

  it("lists learned reroutes and lets an operator try a model again", async () => {
    const { user } = await renderPage();

    const reroutes = screen.getByTestId("model-reroutes");
    expect(within(reroutes).getByText("Temporarily unavailable on alice-max:")).toBeInTheDocument();
    expect(within(reroutes).getByText("claude-sonnet-5-5")).toBeInTheDocument();

    const deletes: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.method === "DELETE") deletes.push(new URL(request.url).pathname + new URL(request.url).search);
    });
    setMockCatalog({ blocks: [] });
    await user.click(within(reroutes).getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(deletes).toEqual(["/api/accounts/acc_max/model-blocks?model=claude-sonnet-5-5"]));
    expect(await screen.findByText("Every learned account-model route is currently available.")).toBeInTheDocument();
    server.events.removeAllListeners();
  });

  it("syncs from upstream and probes unhealthy accounts, showing each result", async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole("button", { name: "Sync from upstream" }));
    const sync = await screen.findByTestId("sync-result");
    expect(within(sync).getByText("Synced 2 accounts.")).toBeInTheDocument();
    expect(within(sync).getByText("alice-max: 1 model")).toBeInTheDocument();
    expect(within(sync).getByText("console: 3 models")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Probe unhealthy accounts" }));
    const probe = await screen.findByTestId("probe-result");
    expect(within(probe).getByText("Probed 2 accounts.")).toBeInTheDocument();
    expect(within(probe).getByText("passed (3 models)")).toBeInTheDocument();
    expect(within(probe).getByText("failed: HTTP 401 invalid x-api-key")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-result")).not.toBeInTheDocument();
  });

  it("filters models and reveals the price table", async () => {
    const { user } = await renderPage();

    await user.type(screen.getByRole("textbox", { name: "Search models" }), "opus");
    await waitFor(() => expect(screen.queryByText("Claude Haiku 5.5")).not.toBeInTheDocument());
    expect(screen.getByText("Claude Opus 5.5")).toBeInTheDocument();

    expect(screen.queryByTestId("price-table")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show 3 prices" }));
    const prices = await screen.findByTestId("price-table");
    const opus = within(prices).getByText("claude-opus-5-5").closest("tr") as HTMLElement;
    expect(within(opus).getByText("$4.00")).toBeInTheDocument();
    expect(within(opus).getByText("$20.00")).toBeInTheDocument();
    expect(within(opus).getByText("$5.00")).toBeInTheDocument();
  });

  it("disables the actions for read-only sessions", async () => {
    await renderPage();
    useAuthStore.setState({ canWrite: false });
    await waitFor(() => expect(screen.getByRole("button", { name: "Sync from upstream" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Probe unhealthy accounts" })).toBeDisabled();
  });

  it("formats per-MTok rates", () => {
    expect(formatRate(4)).toBe("$4.00");
    expect(formatRate(0.1)).toBe("$0.10");
    expect(formatRate(0.025)).toBe("$0.025");
    expect(formatRate(0.125)).toBe("$0.125");
    expect(formatRate(0.01)).toBe("$0.01");
  });
});
