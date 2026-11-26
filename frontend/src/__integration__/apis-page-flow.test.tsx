import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import App from "@/App";
import { useAuthStore } from "@/features/auth/hooks/use-auth";
import { getMockApiKeys } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

describe("APIs page flow", () => {
  beforeEach(() => {
    useAuthStore.setState(useAuthStore.getInitialState());
    window.history.pushState({}, "", "/apis");
  });

  it("creates a key with a rule, shows it once with the Claude Code snippet, then edits it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(await screen.findByRole("button", { name: "Create API key" }));
    const form = await screen.findByRole("dialog", { name: "Create API key" });
    await user.type(within(form).getByLabelText("Name"), "laptop");
    await user.click(within(form).getByRole("button", { name: "Add rule" }));
    await user.type(within(form).getByLabelText("Limit (USD)"), "3");
    await user.click(within(form).getByRole("button", { name: "Create" }));

    const created = await screen.findByRole("dialog", { name: "API key created" });
    const secret = within(created).getByTestId("created-api-key").textContent ?? "";
    expect(secret).toMatch(/^clb_/);
    expect(within(created).getByTestId("claude-code-shell")).toHaveTextContent(`ANTHROPIC_API_KEY=${secret}`);
    await user.click(within(created).getByRole("button", { name: "Done" }));

    // The new key is selected and its rule is shown; the secret is gone for good.
    expect(await screen.findByRole("heading", { name: "laptop" })).toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(await within(screen.getByTestId("api-key-limits")).findByText("$0.00 / $3.00")).toBeInTheDocument();
    expect(getMockApiKeys().find((key) => key.name === "laptop")?.limits[0]).toMatchObject({
      metric: "cost_usd",
      window: "daily",
      max_value: 3,
    });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const edit = await screen.findByRole("dialog", { name: "Edit API key" });
    await user.type(within(edit).getByLabelText("Enforced model"), "claude-haiku-5");
    await user.click(within(edit).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(getMockApiKeys().find((key) => key.name === "laptop")?.enforced_model).toBe("claude-haiku-5"),
    );
    expect(await screen.findByText("claude-haiku-5", { selector: "span" })).toBeInTheDocument();
  });
});
