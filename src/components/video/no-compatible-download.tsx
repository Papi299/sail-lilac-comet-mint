import { Button } from "@/components/ui/button";

export function NoCompatibleDownload({ onTryAnother }: { onTryAnother: () => void }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-medium">No compatible download available</h2>
        <p className="text-sm text-muted-foreground">
          VideoFetch recognized this source, but none of its available streams match the download
          formats currently supported.
        </p>
      </div>
      <Button variant="outline" className="w-full sm:w-auto" onClick={onTryAnother}>
        Try another URL
      </Button>
    </div>
  );
}
