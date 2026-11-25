import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const SEARCH_INPUT_DEBOUNCE_MS = 300;

export type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  name: string;
  placeholder?: string;
  ariaLabel: string;
  className?: string;
  /** Show the magnifier icon (default true). */
  icon?: boolean;
};

/**
 * Text filter that reports changes after a short pause, and follows outside changes
 * (reset, back/forward) without clobbering what is being typed.
 */
export function SearchInput({
  value,
  onChange,
  name,
  placeholder,
  ariaLabel,
  className,
  icon = true,
}: SearchInputProps) {
  const [draft, setDraft] = useState(value);
  const lastSent = useRef(value);

  useEffect(() => {
    if (value !== lastSent.current) {
      lastSent.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    if (draft === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = draft;
      onChange(draft);
    }, SEARCH_INPUT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, onChange]);

  return (
    <div className={cn("relative min-w-0", className)}>
      {icon ? (
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground/60"
          aria-hidden="true"
        />
      ) : null}
      <Input
        name={name}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className={cn("h-8", icon && "pl-9")}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
    </div>
  );
}
