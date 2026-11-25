import { isKnownRoutingStrategy, type KnownRoutingStrategy } from "@/features/settings/schemas";

const STRATEGY_KEY: Record<KnownRoutingStrategy, string> = {
  capacity_weighted: "capacityWeighted",
  relative_availability: "relativeAvailability",
  usage_weighted: "usageWeighted",
  reset_drain: "resetDrain",
  sequential_drain: "sequentialDrain",
  round_robin: "roundRobin",
  least_used: "leastUsed",
  fill_first: "fillFirst",
  single_account: "singleAccount",
};

/** i18n key for a strategy's display name, or null for one this build does not know. */
export function routingStrategyLabelKey(strategy: string): string | null {
  return isKnownRoutingStrategy(strategy) ? `settings.routing.strategy.${STRATEGY_KEY[strategy]}` : null;
}

/** i18n key for a strategy's one-line guide, or null for one this build does not know. */
export function routingStrategyGuideKey(strategy: string): string | null {
  return isKnownRoutingStrategy(strategy) ? `settings.routing.strategy.guide.${STRATEGY_KEY[strategy]}` : null;
}
