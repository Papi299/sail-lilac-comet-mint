import { useEffect, useMemo, useState } from "react";
import { ClipboardPaste, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { extractDomain, validatePublicHttpUrl } from "@/lib/validation/url";
import { SAMPLE_VIDEO_URL } from "@/lib/sample-url";
import { loadRecentUrls } from "@/lib/client-api";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (url: string) => void;
  loading?: boolean;
  disabled?: boolean;
};

export function UrlInput({ value, onChange, onSubmit, loading, disabled }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setRecent(loadRecentUrls());
  }, []);

  const detected = useMemo(() => {
    const check = validatePublicHttpUrl(value);
    if (!check.ok) return null;
    const domain = extractDomain(check.url);
    return domain || null;
  }, [value]);

  function submit() {
    const check = validatePublicHttpUrl(value);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setError(null);
    onSubmit(check.url);
  }

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onChange(text.trim());
        setError(null);
      }
    } catch {
      setError("Clipboard access is not available here. Paste with your keyboard instead.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-card p-2 shadow-[var(--shadow-border)] sm:p-2.5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Input
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                if (error) setError(null);
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Paste a video link here..."
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-label="Video URL"
              disabled={loading || disabled}
              className="h-12 border-0 bg-transparent pr-20 shadow-none focus-visible:ring-0"
            />
            <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
              {value ? (
                <button
                  type="button"
                  className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  aria-label="Clear URL"
                  onClick={() => onChange("")}
                >
                  <X className="size-4" />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
                  aria-label="Paste from clipboard"
                  onClick={() => void paste()}
                >
                  <ClipboardPaste className="size-4" />
                </button>
              )}
            </div>
          </div>
          <Button
            size="lg"
            className="h-12 w-full shrink-0 sm:w-auto"
            onClick={submit}
            disabled={loading || disabled}
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              "Analyze Video"
            )}
          </Button>
        </div>
      </div>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-sm text-muted-foreground">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : detected ? (
            <>Detected: {detected}</>
          ) : (
            <span className="hidden sm:inline">Works with direct media files and many public video pages.</span>
          )}
        </p>
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            onChange(SAMPLE_VIDEO_URL);
            setError(null);
            onSubmit(SAMPLE_VIDEO_URL);
          }}
        >
          Try a sample clip
        </button>
      </div>
      {focused && recent.length > 0 ? (
        <div className="rounded-xl bg-card px-3 py-2 shadow-[var(--shadow-border)]">
          <p className="px-1 pb-1 text-xs text-muted-foreground">Recent</p>
          <ul>
            {recent.map((url) => (
              <li key={url}>
                <button
                  type="button"
                  className="w-full truncate rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onChange(url)}
                >
                  {url}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
