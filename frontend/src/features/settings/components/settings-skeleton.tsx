import { Skeleton } from "@/components/ui/skeleton";

// Placeholder for the server-backed cards (routing, background jobs, data retention)
// while `GET /api/settings` loads. Appearance and the auth cards render on their own.
const CARD_ROWS = [4, 2, 1];

export function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      {CARD_ROWS.map((rows, card) => (
        <div key={card} className="rounded-xl border bg-card p-5">
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-64" />
              </div>
            </div>
            <div className="divide-y rounded-lg border">
              {Array.from({ length: rows }).map((_, row) => (
                <div key={row} className="flex items-center justify-between p-3">
                  <div className="space-y-1">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-8 w-32 rounded-lg" />
                </div>
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
