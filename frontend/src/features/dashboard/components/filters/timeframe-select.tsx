import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { REQUEST_LOG_TIMEFRAMES, type RequestLogTimeframe } from "@/features/dashboard/schemas";

const TIMEFRAME_VALUES = REQUEST_LOG_TIMEFRAMES;
export type TimeframeValue = RequestLogTimeframe;

function isTimeframeValue(value: string): value is TimeframeValue {
  return (TIMEFRAME_VALUES as readonly string[]).includes(value);
}

export type TimeframeSelectProps = {
  value: TimeframeValue;
  onChange: (value: TimeframeValue) => void;
};

export function TimeframeSelect({ value, onChange }: TimeframeSelectProps) {
  const { t } = useTranslation();

  return (
    <Select value={value} onValueChange={(next) => { if (isTimeframeValue(next)) onChange(next); }}>
      <SelectTrigger size="sm" className="w-28" aria-label={t("dashboard.filters.timeframe")}>
        <SelectValue placeholder={t("dashboard.filters.timeframe")} />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="all">{t("common.time.all")}</SelectItem>
        {TIMEFRAME_VALUES.filter((value) => value !== "all").map((value) => (
          <SelectItem key={value} value={value}>
            {t(`dashboard.timeframes.${value}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
