import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApiKeyCreatedDialog } from "@/features/api-keys/components/api-key-created-dialog";
import { renderWithProviders } from "@/test/utils";

describe("ApiKeyCreatedDialog", () => {
  it("shows the new key once with the Claude Code settings for this origin", () => {
    renderWithProviders(
      <ApiKeyCreatedDialog
        open
        origin="https://lb.example.com"
        created={{ name: "ci", secret: "clb_new_secret", regenerated: false }}
        onOpenChange={() => {}}
      />,
    );

    expect(screen.getByRole("heading", { name: "API key created" })).toBeInTheDocument();
    expect(screen.getByTestId("created-api-key")).toHaveTextContent("clb_new_secret");
    expect(screen.getByTestId("claude-code-shell")).toHaveTextContent(
      "export ANTHROPIC_BASE_URL=https://lb.example.com export ANTHROPIC_API_KEY=clb_new_secret",
    );
    expect(JSON.parse(screen.getByTestId("claude-code-settings").textContent ?? "")).toEqual({
      env: { ANTHROPIC_BASE_URL: "https://lb.example.com", ANTHROPIC_API_KEY: "clb_new_secret" },
    });
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(3);
  });

  it("words a regenerated secret differently", () => {
    renderWithProviders(
      <ApiKeyCreatedDialog
        open
        created={{ name: "ci", secret: "clb_x", regenerated: true }}
        onOpenChange={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "New secret issued" })).toBeInTheDocument();
    expect(screen.getByText(/ci now has a new secret/)).toBeInTheDocument();
    expect(screen.getByTestId("claude-code-shell")).toHaveTextContent(`ANTHROPIC_BASE_URL=${window.location.origin}`);
  });
});
