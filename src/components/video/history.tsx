import { Badge } from "@/components/ui/badge";
import type { HistoryItem } from "@/lib/client-api";

export function DownloadHistory({ items }: { items: HistoryItem[] }) {
  if (!items.length) return null;
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-muted-foreground">Recent in this browser</h2>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.jobId}
            className="flex items-center gap-3 rounded-xl bg-card p-3 shadow-[var(--shadow-border)]"
          >
            <div className="size-12 overflow-hidden rounded-md bg-muted">
              {item.thumbnail ? (
                <img
                  src={item.thumbnail}
                  alt=""
                  className="size-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.title}</p>
              <p className="text-xs text-muted-foreground">
                {[item.quality, item.format].filter(Boolean).join(" · ") || "Processed"}
              </p>
            </div>
            <Badge variant={item.status === "ready" ? "success" : item.status === "failed" ? "outline" : "muted"}>
              {item.status}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
