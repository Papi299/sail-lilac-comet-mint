import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAccessSession,
  loginWithAccessSecret,
  logoutAccess,
  type AccessSession,
} from "@/lib/client-api";

export function PrivateAccessGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AccessSession | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAccessSession()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUnlock(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const submitted = secret;
    setSecret("");
    try {
      const next = await loginWithAccessSecret(submitted);
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Private access is required.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLock() {
    setBusy(true);
    setError(null);
    try {
      const next = await logoutAccess();
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not lock VideoFetch.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <GateShell>
        <Card>
          <CardContent className="space-y-3 p-6 sm:p-8">
            <h1 className="font-display text-3xl tracking-tight">VideoFetch</h1>
            <p className="text-sm text-muted-foreground">{loadError}</p>
          </CardContent>
        </Card>
      </GateShell>
    );
  }

  if (!session) {
    return (
      <GateShell>
        <Card>
          <CardContent className="space-y-4 p-6 sm:p-8">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      </GateShell>
    );
  }

  if (session.developmentBypass || session.authenticated) {
    return (
      <div>
        {session.authenticated ? (
          <div className="mx-auto flex w-full max-w-3xl justify-end px-4 pt-6 sm:px-6">
            <Button type="button" variant="ghost" size="sm" onClick={() => void handleLock()} disabled={busy}>
              <Lock className="size-4" />
              Lock
            </Button>
          </div>
        ) : null}
        {children}
      </div>
    );
  }

  if (!session.configured) {
    return (
      <GateShell>
        <Card>
          <CardContent className="space-y-4 p-6 sm:p-8">
            <p className="text-sm font-medium tracking-wide text-muted-foreground">VideoFetch</p>
            <h1 className="font-display text-3xl tracking-tight sm:text-4xl">This server is not ready</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Private access is not configured on this server. The downloader is unavailable.
            </p>
          </CardContent>
        </Card>
      </GateShell>
    );
  }

  return (
    <GateShell>
      <Card>
        <CardContent className="space-y-6 p-6 sm:p-8">
          <div className="space-y-2">
            <p className="text-sm font-medium tracking-wide text-muted-foreground">VideoFetch</p>
            <h1 className="font-display text-3xl tracking-tight sm:text-4xl">Private access</h1>
            <p className="text-sm text-muted-foreground">Enter the access secret to continue.</p>
          </div>
          <form className="space-y-4" onSubmit={(event) => void handleUnlock(event)}>
            <div className="space-y-2">
              <Label htmlFor="access-secret">Access secret</Label>
              <Input
                id="access-secret"
                name="access-secret"
                type="password"
                autoComplete="current-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                disabled={busy}
                required
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full sm:w-auto" disabled={busy || secret.length === 0}>
              <Unlock className="size-4" />
              Unlock
            </Button>
          </form>
        </CardContent>
      </Card>
    </GateShell>
  );
}

function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col justify-center px-4 py-16 sm:px-6 sm:py-24">
      {children}
    </div>
  );
}
