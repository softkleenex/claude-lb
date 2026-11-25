import { ChevronDown, Eye, EyeOff, LogIn, LogOut, Menu } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useLocation } from "react-router-dom";

import { AppLogo } from "@/components/brand/app-logo";
import { LanguageToggle, LanguageToggleMobile } from "@/components/layout/language-toggle";
import { ThemeToggle, ThemeToggleMobile } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { usePoolStatus } from "@/features/accounts/pool-status";
import { usePrivacyStore } from "@/hooks/use-privacy";
import { cn } from "@/lib/utils";

const CORE_NAV_ITEMS = [
  { to: "/dashboard", labelKey: "nav.dashboard" },
  { to: "/reports", labelKey: "nav.reports" },
  { to: "/accounts", labelKey: "nav.accounts" },
  { to: "/apis", labelKey: "nav.apis" },
  { to: "/settings", labelKey: "nav.settings" },
] as const;

// Power-user pages, behind the "Advanced" dropdown (and a section of the mobile sheet).
// Conversations live on the Dashboard (Requests / Conversations switch). The dropdown
// renders only when this list is non-empty.
const ADVANCED_NAV_ITEMS: ReadonlyArray<{ to: string; labelKey: string }> = [
  { to: "/audit", labelKey: "nav.audit" },
  { to: "/models", labelKey: "nav.models" },
  { to: "/sticky-sessions", labelKey: "nav.stickySessions" },
];

export type AppHeaderProps = {
  onLogout: () => void;
  onAdminLogin?: () => void;
  showAdminLogin?: boolean;
  showLogout?: boolean;
  className?: string;
};

export function AppHeader({
  onLogout,
  onAdminLogin,
  showAdminLogin = false,
  showLogout = true,
  className,
}: AppHeaderProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const advancedActive = ADVANCED_NAV_ITEMS.some(
    (item) => pathname === item.to || pathname.startsWith(`${item.to}/`),
  );
  const blurred = usePrivacyStore((s) => s.blurred);
  const togglePrivacy = usePrivacyStore((s) => s.toggle);
  const PrivacyIcon = blurred ? EyeOff : Eye;
  const { data: pool } = usePoolStatus();
  // How many accounts can take traffic right now; hidden until the pool has an account.
  const accountsBadge =
    pool && pool.total > 0 ? (pool.available > 99 ? "99+" : String(pool.available)) : null;
  const accountsBadgeLabel = pool ? t("nav.accountsAvailable", { available: pool.available, total: pool.total }) : undefined;
  const accountsBadgeTone = pool && pool.available === 0 ? "bg-destructive text-white" : "bg-primary text-primary-foreground";
  const privacyLabel = blurred ? t("nav.showEmails") : t("nav.hideEmails");

  return (
    <header
      className={cn(
        "sticky top-0 z-20 border-b border-white/[0.08] bg-background/50 px-4 py-2.5 shadow-[0_1px_12px_rgba(0,0,0,0.06)] backdrop-blur-xl backdrop-saturate-[1.8] supports-[backdrop-filter]:bg-background/40 dark:shadow-[0_1px_12px_rgba(0,0,0,0.25)]",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-[1500px] items-center justify-between gap-4">
        {/* Brand */}
        <Link
          to="/dashboard"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg no-underline transition-colors hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-primary/15 to-primary/5">
            <AppLogo size={20} className="text-primary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">Claude LB</p>
          </div>
        </Link>

        {/* Desktop nav pills */}
        <nav className="hidden items-center rounded-lg border border-border/50 bg-muted/40 p-0.5 sm:flex">
          {CORE_NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "relative inline-flex h-7 items-center rounded-md px-3.5 text-xs leading-none font-medium transition-colors duration-200",
                  isActive
                    ? "bg-background text-foreground shadow-[var(--shadow-xs)]"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              <span className="relative inline-flex items-center">
                {t(item.labelKey)}
                {item.to === "/accounts" && accountsBadge ? (
                  <span
                    title={accountsBadgeLabel}
                    aria-label={accountsBadgeLabel}
                    className={cn(
                      "absolute -top-2 -right-4 z-10 grid h-4 min-w-[1rem] place-items-center rounded-full px-1 text-[10px] font-medium",
                      accountsBadgeTone,
                    )}
                  >
                    {accountsBadge}
                  </span>
                ) : null}
              </span>
            </NavLink>
          ))}
          {ADVANCED_NAV_ITEMS.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-active={advancedActive}
              className={cn(
                "relative inline-flex h-7 items-center gap-1 rounded-md px-3.5 text-xs leading-none font-medium transition-colors duration-200",
                advancedActive
                  ? "bg-background text-foreground shadow-[var(--shadow-xs)]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("nav.advanced")}
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ADVANCED_NAV_ITEMS.map((item) => (
                <DropdownMenuItem key={item.to} asChild>
                  <NavLink to={item.to} className="cursor-pointer">
                    {t(item.labelKey)}
                  </NavLink>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          ) : null}
        </nav>

        {/* Actions */}
        <div className="flex flex-1 items-center justify-end gap-1.5">
          <LanguageToggle />
          <ThemeToggle />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={togglePrivacy}
            aria-label={privacyLabel}
            className="press-scale hidden h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground sm:inline-flex"
          >
            <PrivacyIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
          {showLogout && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onLogout}
              className="press-scale hidden h-8 gap-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground sm:inline-flex"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              {t("common.logout")}
            </Button>
          )}
          {showAdminLogin && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onAdminLogin}
              className="press-scale hidden h-8 gap-1.5 rounded-lg text-xs sm:inline-flex"
            >
              <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
              {t("nav.adminSignIn")}
            </Button>
          )}

          {/* Mobile menu */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button type="button" size="icon" variant="ghost" aria-label={t("nav.openMenu")} className="h-8 w-8 rounded-lg sm:hidden">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
                    <AppLogo size={16} className="text-primary" />
                  </div>
                  <span className="text-sm font-semibold">Claude LB</span>
                </SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-0.5 px-4 pt-2">
                {CORE_NAV_ITEMS.map((item) => (
                  <NavLink key={item.to} to={item.to} onClick={() => setMobileOpen(false)}>
                    {({ isActive }) => (
                      <span
                        className={cn(
                          "relative block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        {t(item.labelKey)}
                        {item.to === "/accounts" && accountsBadge ? (
                          <span
                            aria-label={accountsBadgeLabel}
                            className={cn(
                              "absolute right-2 top-1 z-10 grid h-5 min-w-[1.25rem] place-items-center rounded-full px-1 text-[10px] font-medium",
                              accountsBadgeTone,
                            )}
                          >
                            {accountsBadge}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </NavLink>
                ))}
                {ADVANCED_NAV_ITEMS.length > 0 ? (
                  <>
                <div className="my-2 h-px bg-border" />
                <p className="px-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  {t("nav.advanced")}
                </p>
                {ADVANCED_NAV_ITEMS.map((item) => (
                  <NavLink key={item.to} to={item.to} onClick={() => setMobileOpen(false)}>
                    {({ isActive }) => (
                      <span
                        className={cn(
                          "relative block w-full rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        {t(item.labelKey)}
                      </span>
                    )}
                  </NavLink>
                ))}
                  </>
                ) : null}
                <div className="my-2 h-px bg-border" />
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  onClick={togglePrivacy}
                >
                  <PrivacyIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {privacyLabel}
                </button>
                <div className="my-2 h-px bg-border" />
                <ThemeToggleMobile />
                <div className="my-2 h-px bg-border" />
                <LanguageToggleMobile />
                {showLogout && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      setMobileOpen(false);
                      onLogout();
                    }}
                  >
                    <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("common.logout")}
                  </button>
                )}
                {showAdminLogin && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    onClick={() => {
                      setMobileOpen(false);
                      onAdminLogin?.();
                    }}
                  >
                    <LogIn className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("nav.adminSignIn")}
                  </button>
                )}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
