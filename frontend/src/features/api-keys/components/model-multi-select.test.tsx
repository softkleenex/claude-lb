import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { ModelMultiSelect } from "@/features/api-keys/components/model-multi-select";
import { renderWithProviders } from "@/test/utils";

function Harness({ initial = [] as string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ModelMultiSelect value={value} onChange={setValue} />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </>
  );
}

describe("ModelMultiSelect", () => {
  it("picks catalog models and adds a typed family id", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    await user.click(await screen.findByRole("button", { name: "All models" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "claude-opus-5" }));
    await user.type(screen.getByRole("textbox", { name: "Search or type a model id" }), "claude-sonnet-4-5");
    await user.click(screen.getByRole("menuitem", { name: "Add “claude-sonnet-4-5”" }));

    expect(screen.getByTestId("value")).toHaveTextContent('["claude-opus-5","claude-sonnet-4-5"]');
  });

  it("clears the restriction with All models and removes a chip", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial={["claude-opus-5", "claude-haiku-5"]} />);

    await user.click(screen.getByRole("button", { name: "Remove claude-haiku-5" }));
    expect(screen.getByTestId("value")).toHaveTextContent('["claude-opus-5"]');

    await user.click(screen.getByRole("button", { name: "1 model" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "All models" }));
    expect(screen.getByTestId("value")).toHaveTextContent("[]");
  });
});
