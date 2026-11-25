import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OVERVIEW_TIMEFRAMES, type OverviewTimeframe } from "@/features/dashboard/schemas";

function isOverviewTimeframe(value: string): value is OverviewTimeframe {
  return (OVERVIEW_TIMEFRAMES as readonly string[]).includes(value);
}

export type OverviewTimeframeSelectProps = {
  value: OverviewTimeframe;
  onChange: (value: OverviewTimeframe) => void;
};

export function OverviewTimeframeSelect({ value, onChange }: OverviewTimeframeSelectProps) {
  const { t } = useTranslation();
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (isOverviewTimeframe(next)) onChange(next);
      }}
    >
      <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={t("dashboard.filters.overviewTimeframe")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {OVERVIEW_TIMEFRAMES.map((frame) => (
          <SelectItem key={frame} value={frame}>
            {t(`dashboard.timeframes.last.${frame}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
