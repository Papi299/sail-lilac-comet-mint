import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The card for anything that ended without a file. `retry`, when given, is the
 * way back to the quality choice for the same video (see `jobOutcomeRetry`): it
 * sends nothing itself, and its hint says that a new download starts from the
 * beginning. "Start over" always returns to an empty page.
 */
export function ErrorCard({
  heading,
  message,
  onReset,
  retry,
}: {
  heading: string;
  message: string;
  onReset: () => void;
  retry?: { label: string; hint: string; onRetry: () => void } | null;
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-5 sm:p-6">
        <h2 className="font-medium">{heading}</h2>
        <p className="text-sm text-muted-foreground">{message}</p>
        {retry ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Button size="sm" className="w-full sm:w-auto" onClick={retry.onRetry}>
              {retry.label}
            </Button>
            <p className="text-xs text-muted-foreground">{retry.hint}</p>
          </div>
        ) : null}
        <button
          type="button"
          className="text-sm underline-offset-4 hover:underline"
          onClick={onReset}
        >
          Start over
        </button>
      </CardContent>
    </Card>
  );
}
