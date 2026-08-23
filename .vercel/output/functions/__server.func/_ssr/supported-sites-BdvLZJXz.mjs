import { y as require_jsx_runtime } from "../_libs/@radix-ui/react-accordion+[...].mjs";
import { n as Card, r as CardContent, t as Badge } from "./badge-ChXm3OgM.mjs";
import { n as CATEGORY_LABELS, r as SITE_CATALOG } from "./router-KTtJilPJ.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/supported-sites-BdvLZJXz.js
var import_jsx_runtime = require_jsx_runtime();
function SupportedSitesPage() {
	const categories = Object.keys(CATEGORY_LABELS).map((key) => ({
		key,
		label: CATEGORY_LABELS[key],
		sites: SITE_CATALOG.filter((s) => s.category === key)
	}));
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-16",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "max-w-2xl space-y-3",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "font-display text-4xl tracking-tight",
				children: "Supported sites"
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "text-muted-foreground",
				children: "VideoFetch uses a modular extractor. Direct media files are the most reliable. Many other websites work when they expose public streams, but support can change as those sites update their delivery methods."
			})]
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "mt-10 space-y-10",
			children: categories.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "space-y-4",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-sm font-medium tracking-wide text-muted-foreground uppercase",
					children: group.label
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "grid gap-3 sm:grid-cols-2 lg:grid-cols-3",
					children: group.sites.map((site) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Card, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(CardContent, {
						className: "flex h-full flex-col gap-2 p-5",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex items-start justify-between gap-3",
								children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
									className: "font-medium",
									children: site.name
								}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
									variant: site.status === "supported" ? "success" : "muted",
									children: site.status === "supported" ? "Supported" : "Limited"
								})]
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-muted-foreground",
								children: site.domain
							}),
							site.notes ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-muted-foreground",
								children: site.notes
							}) : null
						]
					}) }, site.id))
				})]
			}, group.key))
		})]
	});
}
//#endregion
export { SupportedSitesPage as component };
