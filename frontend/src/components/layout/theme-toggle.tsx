import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useThemeStore, type ThemePreference } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: ThemePreference; labelKey: string; icon: typeof Sun }[] = [
  { value: "light", labelKey: "settings.appearance.theme.light", icon: Sun },
  { value: "dark", labelKey: "settings.appearance.theme.dark", icon: Moon },
  { value: "auto", labelKey: "settings.appearance.theme.auto", icon: Monitor },
];

export function ThemeToggle() {
  const { t } = useTranslation();
  const preference = useThemeStore((s) => s.preference);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const TriggerIcon = preference === "auto" ? Monitor : theme === "dark" ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={t("settings.appearance.theme.label")}
          className="press-scale hidden h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground sm:inline-flex"
        >
          <TriggerIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[140px]">
        {THEME_OPTIONS.map(({ value, labelKey, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onSelect={() => setTheme(value)}
            className={cn("gap-2", value === preference && "font-semibold")}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="flex-1">{t(labelKey)}</span>
            {value === preference ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ThemeToggleMobile() {
  const { t } = useTranslation();
  const preference = useThemeStore((s) => s.preference);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="flex gap-1 px-3 py-1" role="group" aria-label={t("settings.appearance.theme.label")}>
      {THEME_OPTIONS.map(({ value, labelKey, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={preference === value}
          onClick={() => setTheme(value)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            preference === value ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {t(labelKey)}
        </button>
      ))}
    </div>
  );
}
