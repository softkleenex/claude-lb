import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { AutomationsPage } from "@/features/automations/components/automations-page";
import { getMockAutomations, setMockAutomations } from "@/test/mocks/handlers";
import { server } from "@/test/mocks/server";
import { renderWithProviders } from "@/test/utils";

async function renderPage() {
  await useAuthStore.getState().refreshSession();
  const user = userEvent.setup();
  renderWithProviders(<AutomationsPage />);
  await screen.findByTestId("automation-job_1");
  return { user };
}

function captureBodies(method: string, pathSuffix: string): unknown[] {
  const bodies: unknown[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === method && new URL(request.url).pathname.endsWith(pathSuffix)) {
      bodies.push(await request.clone().json());
    }
  });
  return bodies;
}

describe("AutomationsPage", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    server.events.removeAllListeners();
  });

  it("lists jobs with schedule, targets, estimate and the last cycle", async () => {
    await renderPage();
    const row = screen.getByTestId("automation-job_1");
    expect(within(row).getByText("Weekdays at 07:00 (Asia/Seoul)")).toBeInTheDocument();
    expect(within(row).getByText("alice-max, console")).toBeInTheDocument();
    expect(within(row).getByText("1 API key · 1 subscription (flat rate)")).toBeInTheDocument();
    expect(within(row).getByText("Partial")).toBeInTheDocument();
    expect(within(row).getByText("max 16 tokens")).toBeInTheDocument();
  });

  it("expands a cycle into per-account results", async () => {
    const { user } = await renderPage();
    const cycleRow = (await screen.findByText("1 of 2 succeeded")).closest("tr") as HTMLElement;
    expect(within(cycleRow).getByText("· 1 failed")).toBeInTheDocument();
    await user.click(cycleRow);
    expect(await screen.findByText("max_tokens: too small")).toBeInTheDocument();
    expect(screen.getByText("HTTP 400 · 820 ms")).toBeInTheDocument();
  });

  it("runs a job now after a confirmation that shows the API-key cost", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Run Morning window now" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/through each of 2 accounts/)).toBeInTheDocument();
    expect(within(dialog).getByText(/for 1 API-key account/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Run now" }));
    expect(await screen.findByText("2 of 2 succeeded")).toBeInTheDocument();
    expect(screen.getAllByText("Run now").length).toBeGreaterThan(0);
  });

  it("creates a job with snake_case body and capped validation", async () => {
    const bodies = captureBodies("POST", "/api/automations");
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "New automation" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Night owl");
    const maxTokens = within(dialog).getByLabelText("Max output tokens");
    await user.clear(maxTokens);
    await user.type(maxTokens, "5000");
    const tz = within(dialog).getByLabelText("Timezone");
    await user.clear(tz);
    await user.type(tz, "Asia/Seoul");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByText("A whole number between 1 and the maximum.")).toBeInTheDocument();
    await user.clear(maxTokens);
    await user.type(maxTokens, "8");
    await user.click(within(dialog).getByRole("button", { name: "Sat" }));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(bodies).toEqual([
      {
        name: "Night owl",
        enabled: true,
        schedule: { days: ["mon", "tue", "wed", "thu", "fri", "sat"], time: "07:00", timezone: "Asia/Seoul", spread_minutes: 0 },
        model: "claude-haiku-4-5",
        prompt: "Reply with OK.",
        max_tokens: 8,
        account_ids: [],
        include_paused_accounts: false,
      },
    ]);
    expect(await screen.findByText("Night owl")).toBeInTheDocument();
  });

  it("edits only the changed fields and toggles enabled", async () => {
    const bodies = captureBodies("PATCH", "/api/automations/job_1");
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Edit Morning window" }));
    const dialog = await screen.findByRole("dialog");
    const prompt = within(dialog).getByLabelText("Prompt");
    await user.clear(prompt);
    await user.type(prompt, "hi");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    await user.click(screen.getByRole("switch", { name: "Disable Morning window" }));
    await waitFor(() => expect(getMockAutomations()[0].enabled).toBe(false));
    expect(bodies).toEqual([{ prompt: "hi" }, { enabled: false }]);
    expect(await screen.findByText("Off")).toBeInTheDocument();
  });

  it("deletes a job after confirmation", async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole("button", { name: "Delete Morning window" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
    expect(getMockAutomations()).toEqual([]);
  });

  it("shows empty states", async () => {
    setMockAutomations([], []);
    await useAuthStore.getState().refreshSession();
    renderWithProviders(<AutomationsPage />);
    expect(await screen.findByText("No automations yet")).toBeInTheDocument();
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
  });
});
