import { createFileRoute } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CATEGORY_LABELS, SITE_CATALOG, type CatalogSite } from "@/lib/sites-catalog";

export const Route = createFileRoute("/supported-sites")({
  component: SupportedSitesPage,
});

function SupportedSitesPage() {
  const categories = (Object.keys(CATEGORY_LABELS) as CatalogSite["category"][]).map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    sites: SITE_CATALOG.filter((s) => s.category === key),
  }));

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
      <div className="max-w-2xl space-y-3">
        <h1 className="font-display text-4xl tracking-tight">Supported sites</h1>
        <p className="text-muted-foreground">
          VideoFetch uses a modular extractor. Direct media files are the most reliable. Many
          other websites work when they expose public streams, but support can change as those
          sites update their delivery methods.
        </p>
      </div>
      <div className="mt-10 space-y-10">
        {categories.map((group) => (
          <section key={group.key} className="space-y-4">
            <h2 className="text-sm font-medium tracking-wide text-muted-foreground uppercase">
              {group.label}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.sites.map((site) => (
                <Card key={site.id}>
                  <CardContent className="flex h-full flex-col gap-2 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{site.name}</p>
                      <Badge variant={site.status === "supported" ? "success" : "muted"}>
                        {site.status === "supported" ? "Supported" : "Limited"}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{site.domain}</p>
                    {site.notes ? <p className="text-sm text-muted-foreground">{site.notes}</p> : null}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
