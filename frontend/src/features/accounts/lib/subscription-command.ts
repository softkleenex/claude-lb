export const ADD_ACCOUNT_TABS = ["apiKey", "subscription", "import"] as const;
export type AddAccountTab = (typeof ADD_ACCOUNT_TABS)[number];

/** Claude subscription tokens from `claude setup-token` start with this. */
export const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat";

/** Quote a value for a POSIX shell only when it needs it. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._@:+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** The CLI command that logs in to a subscription in the browser and adds it to the pool. */
export function buildAddSubscriptionCommand(name: string, planType: string, routingPolicy: string): string {
  const label = name.trim();
  const quoted = label ? shellQuote(label) : "<name>";
  return `uv run claude-lb account add-subscription ${quoted} --plan-type ${planType} --routing-policy ${routingPolicy} --transport claude_code`;
}
