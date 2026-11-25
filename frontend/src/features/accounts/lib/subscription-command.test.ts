import { describe, expect, it } from "vitest";

import { buildAddSubscriptionCommand, shellQuote } from "@/features/accounts/lib/subscription-command";

describe("buildAddSubscriptionCommand", () => {
  it("builds the CLI command from the form fields", () => {
    expect(buildAddSubscriptionCommand("alice", "max_5x", "burn_first")).toBe(
      "uv run claude-lb account add-subscription alice --plan-type max_5x --routing-policy burn_first",
    );
  });

  it("uses a placeholder until a name is typed", () => {
    expect(buildAddSubscriptionCommand("  ", "pro", "normal")).toContain("add-subscription <name> --plan-type pro");
  });

  it("quotes names the shell would otherwise split or expand", () => {
    expect(shellQuote("bob's max")).toBe(`'bob'"'"'s max'`);
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shellQuote("team.alice-1")).toBe("team.alice-1");
  });
});
