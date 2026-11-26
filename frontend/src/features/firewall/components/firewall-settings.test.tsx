import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { FirewallSettings } from "@/features/firewall/components/firewall-settings";
import { getMockFirewall, setMockFirewall } from "@/test/mocks/handlers";
import { renderWithProviders } from "@/test/utils";

async function renderCard(canWrite = true) {
  const user = userEvent.setup();
  renderWithProviders(<FirewallSettings canWrite={canWrite} />);
  await screen.findByText("10.0.0.0/8");
  return { user };
}

async function confirm(user: ReturnType<typeof userEvent.setup>, label: string) {
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: label }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
}

describe("FirewallSettings", () => {
  beforeEach(() => {
    setMockFirewall({ mode: "allow_all", clientIp: "127.0.0.1" });
  });

  it("shows mode, entries and whether this client may use the proxy", async () => {
    await renderCard();
    expect(screen.getByRole("radio", { name: "Allow all" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("office")).toBeInTheDocument();
    expect(screen.getByTestId("firewall-client")).toHaveTextContent("127.0.0.1");
    expect(screen.getByTestId("firewall-client")).toHaveTextContent("proxy allowed");
    expect(screen.getByText(/covers proxy requests only/)).toBeInTheDocument();
  });

  it("warns before switching to the allowlist when this machine is not covered", async () => {
    const { user } = await renderCard();
    await user.click(screen.getByRole("radio", { name: "Allowlist" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Your address \(127\.0\.0\.1\) is not covered/)).toBeInTheDocument();
    await confirm(user, "Confirm");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Allowlist" })).toHaveAttribute("aria-checked", "true"));
    expect(getMockFirewall().mode).toBe("allowlist");
    expect(screen.getByTestId("firewall-client")).toHaveTextContent("proxy blocked");
  });

  it("adds without a warning in allow-all mode and normalizes the entry", async () => {
    const { user } = await renderCard();
    await user.type(screen.getByRole("textbox", { name: "IP address or CIDR range" }), "192.168.1.7/32");
    await user.type(screen.getByRole("textbox", { name: "Note" }), "laptop");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("192.168.1.7")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(getMockFirewall().entries.map((entry) => entry.network)).toEqual(["10.0.0.0/8", "192.168.1.7"]);
  });

  it("warns when an allowlist entry would leave this machine out, and adds after confirming", async () => {
    setMockFirewall({ mode: "allowlist" });
    const { user } = await renderCard();
    await user.type(screen.getByRole("textbox", { name: "IP address or CIDR range" }), "172.16.0.0/12");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Add 172.16.0.0/12?")).toBeInTheDocument();
    await confirm(user, "Add anyway");
    expect(await screen.findByText("172.16.0.0/12")).toBeInTheDocument();
  });

  it("adds the client's own address in allowlist mode without asking", async () => {
    setMockFirewall({ mode: "allowlist" });
    const { user } = await renderCard();
    await user.type(screen.getByRole("textbox", { name: "IP address or CIDR range" }), "127.0.0.1");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("you")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("firewall-client")).toHaveTextContent("proxy allowed"));
  });

  it("shows the server's validation error inline", async () => {
    const { user } = await renderCard();
    await user.type(screen.getByRole("textbox", { name: "IP address or CIDR range" }), "not-an-ip");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/not a valid IPv4\/IPv6 address/)).toBeInTheDocument();
  });

  it("removes an entry after confirmation", async () => {
    const { user } = await renderCard();
    await user.click(screen.getByRole("button", { name: "Remove 10.0.0.0/8" }));
    await confirm(user, "Remove");
    expect(await screen.findByText("No entries yet.")).toBeInTheDocument();
  });

  it("is read-only without write access", async () => {
    await renderCard(false);
    expect(screen.queryByRole("textbox", { name: "IP address or CIDR range" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove 10.0.0.0/8" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Allowlist" })).toBeDisabled();
  });
});
