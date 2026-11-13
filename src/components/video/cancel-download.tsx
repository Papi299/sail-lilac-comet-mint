import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cancelConfirmDescription } from "@/lib/download-cancel";
import type { CancelRequestState } from "@/lib/downloader-state";

/**
 * VIDEOFETCH-LD4A-CANCELLATION-UX-AND-OUTCOME-CONTRACT-001: the Cancel control
 * for the job being processed.
 *
 * Nothing is sent until the person confirms in the dialog; closing it in any
 * way — "Keep downloading", Escape, the overlay — sends nothing. Once sent,
 * the control says the request is under way and cannot send another. What
 * happened to the job is never shown here: the reducer shows the job's own
 * committed status. This only reports on the REQUEST when it did not settle
 * the job.
 */

export const CANCEL_BUTTON_LABEL = "Cancel download";
export const CANCELLING_LABEL = "Cancelling…";
export const CANCEL_CONFIRM_TITLE = "Cancel this download?";
export const KEEP_DOWNLOADING_LABEL = "Keep downloading";
export const CONFIRM_CANCEL_LABEL = "Cancel download";
export const CANCELLING_STATUS = "Cancelling the download…";
export const CANCEL_UNCONFIRMED_TITLE = "We couldn't confirm the cancellation.";
export const CANCEL_UNCONFIRMED_MESSAGE =
  "The download may still be running. Its status will update here when VideoFetch can be reached.";
export const CANCEL_REFUSED_TITLE = "The download wasn't cancelled.";

export function CancelDownload({
  downloadedBytes,
  cancel,
  onConfirm,
}: {
  downloadedBytes: number | null;
  cancel: CancelRequestState;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const requesting = cancel.kind === "requesting";
  return (
    <div className="space-y-3">
      <AlertDialog open={open} onOpenChange={(next) => setOpen(next && !requesting)}>
        <AlertDialogTrigger asChild>
          {/* aria-disabled rather than disabled while a request is out: the
              button keeps focus when the dialog closes, and a click does nothing. */}
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            aria-disabled={requesting || undefined}
            onClick={(event) => {
              if (requesting) event.preventDefault();
            }}
          >
            {requesting ? (
              <>
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                {CANCELLING_LABEL}
              </>
            ) : (
              CANCEL_BUTTON_LABEL
            )}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{CANCEL_CONFIRM_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>{cancelConfirmDescription(downloadedBytes)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{KEEP_DOWNLOADING_LABEL}</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>{CONFIRM_CANCEL_LABEL}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <CancelRequestNotice cancel={cancel} />
    </div>
  );
}

/** The request, not the job: shown only while it is out, or when it did not settle the job. */
export function CancelRequestNotice({ cancel }: { cancel: CancelRequestState }) {
  if (cancel.kind === "requesting") {
    return (
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {CANCELLING_STATUS}
      </p>
    );
  }
  if (cancel.kind === "unconfirmed") {
    return (
      <div role="alert" className="space-y-1 rounded-lg border border-border bg-muted/50 p-3 text-sm">
        <p className="font-medium">{CANCEL_UNCONFIRMED_TITLE}</p>
        <p className="text-muted-foreground">{CANCEL_UNCONFIRMED_MESSAGE}</p>
      </div>
    );
  }
  if (cancel.kind === "refused") {
    return (
      <div role="alert" className="space-y-1 rounded-lg border border-border bg-muted/50 p-3 text-sm">
        <p className="font-medium">{CANCEL_REFUSED_TITLE}</p>
        <p className="text-muted-foreground">{cancel.message}</p>
      </div>
    );
  }
  return null;
}
