import { Link } from "@tanstack/react-router";

export function Footer() {
  return (
    <footer className="mt-auto border-t border-border/70">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between">
        <div className="max-w-md space-y-2">
          <p className="font-display text-base">VideoFetch</p>
          <p className="text-sm text-muted-foreground">
            Only download videos you have the right to save. Respect copyright and
            the terms of each website.
          </p>
        </div>
        <div className="flex gap-6 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            Home
          </Link>
          <Link to="/supported-sites" className="hover:text-foreground">
            Supported Sites
          </Link>
          <Link to="/faq" className="hover:text-foreground">
            FAQ
          </Link>
        </div>
      </div>
    </footer>
  );
}
