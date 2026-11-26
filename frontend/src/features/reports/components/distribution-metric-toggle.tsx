import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DISTRIBUTION_METRICS = ["cost", "tokens", "requests"] as const;
export type DistributionMetric = (typeof DISTRIBUTION_METRICS)[number];

type DistributionMetricToggleProps = {
  metric: DistributionMetric;
  onChange: (metric: DistributionMetric) => void;
  label: string;
};

export function DistributionMetricToggle({ metric, onChange, label }: DistributionMetricToggleProps) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={label} className="inline-flex shrink-0 rounded-md border bg-muted/30 p-0.5">
      {DISTRIBUTION_METRICS.map((option) => {
        const isActive = option === metric;
        return (
          <Button
            key={option}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={isActive}
            className={cn(
              "h-6 rounded-[5px] px-2 text-[11px] font-semibold",
              isActive
                ? "bg-background text-foreground shadow-sm hover:bg-background"
                : "text-muted-foreground hover:bg-transparent hover:text-foreground",
            )}
            onClick={() => onChange(option)}
          >
            {t(`reports.distribution.metric.${option}`)}
          </Button>
        );
      })}
    </div>
  );
}
