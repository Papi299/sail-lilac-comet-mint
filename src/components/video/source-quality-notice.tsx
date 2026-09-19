import { Info } from "lucide-react";
import type { SourceQualityNoticeModel } from "@/lib/source-quality-ui";

/** Informational only: explains quality, never offers anything to select. */
export function SourceQualityNotice({ notice }: { notice: SourceQualityNoticeModel }) {
  return (
    <div
      role="note"
      className="flex gap-2.5 rounded-lg border border-border bg-muted/50 p-3 text-sm"
    >
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 space-y-1">
        {notice.title ? <p className="font-medium">{notice.title}</p> : null}
        {notice.facts.length > 0 ? (
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5">
            {notice.facts.map((fact) => (
              <div key={fact.label} className="flex gap-1">
                <dt className="text-muted-foreground">{fact.label}:</dt>
                <dd className="font-medium">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {notice.messages.map((message) => (
          <p key={message} className="text-muted-foreground">
            {message}
          </p>
        ))}
      </div>
    </div>
  );
}
