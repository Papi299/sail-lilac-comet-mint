import { i as __toESM } from "../_runtime.mjs";
import { n as clsx, t as cva } from "../_libs/class-variance-authority+clsx.mjs";
import { t as twMerge } from "../_libs/tailwind-merge.mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
import { m as Slot, y as require_jsx_runtime } from "../_libs/@radix-ui/react-accordion+[...].mjs";
import { i as Moon, n as TriangleAlert, r as Sun } from "../_libs/lucide-react.mjs";
import { _ as createRootRoute, d as useRouterState, g as createFileRoute, h as lazyRouteComponent, l as Scripts, m as Outlet, p as createRouter, u as HeadContent, v as Link, y as useRouter } from "../_libs/@tanstack/react-router+[...].mjs";
import { t as getRequestIP$1 } from "./ssr.mjs";
import { a as union, i as string, n as number, r as object, t as literal } from "../_libs/zod.mjs";
import { t as Provider } from "../_libs/radix-ui__react-tooltip.mjs";
import { t as Toaster } from "../_libs/sonner.mjs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { lookup } from "node:dns/promises";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
//#region node_modules/.nitro/vite/services/ssr/assets/utils-BeesZK7R.js
function cn(...inputs) {
	return twMerge(clsx(inputs));
}
function formatBytes(n) {
	if (n == null || !Number.isFinite(n) || n < 0) return "—";
	const units = [
		"B",
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	const digits = i === 0 || v >= 10 ? 0 : 1;
	return `${v.toFixed(digits)} ${units[i]}`;
}
function formatDuration(seconds) {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
	const s = Math.round(seconds);
	const h = Math.floor(s / 3600);
	const m = Math.floor(s % 3600 / 60);
	const sec = s % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}
function formatSpeed(bytesPerSec) {
	if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
	return `${formatBytes(bytesPerSec)}/s`;
}
function formatEta(seconds) {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
	const s = Math.round(seconds);
	if (s < 2) return "a moment";
	if (s < 60) return `${s} seconds`;
	const m = Math.round(s / 60);
	if (m < 60) return `about ${m} min`;
	const h = Math.floor(s / 3600);
	const rem = Math.round(s % 3600 / 60);
	return rem ? `about ${h}h ${rem}m` : `about ${h}h`;
}
//#endregion
//#region node_modules/.nitro/vite/services/ssr/assets/router-KTtJilPJ.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
function AppErrorComponent({ error }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "flex min-h-screen flex-col items-center justify-center gap-3 px-6 text-center bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
				className: "text-red-500",
				"aria-hidden": "true",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TriangleAlert, {
					className: "size-10",
					strokeWidth: 2
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "text-lg font-semibold",
				children: "Something went wrong"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "max-w-md text-sm break-words text-zinc-500 dark:text-zinc-400",
				children: error.message || "An unexpected error occurred. Try reloading the page."
			})
		]
	});
}
/**
* App-wide client provider mounted once near the root (in `src/routes/__root.tsx`):
*
*   <AuthProvider><Outlet /></AuthProvider>
*
* Better Auth's React client (`@/lib/auth/client`) needs NO context provider —
* its `useSession()` works standalone — so this is a passthrough today. It's
* kept as the single, stable mount point for any future client-side providers
* (e.g. a toast or theme provider) without churning the root shell.
*/
function AuthProvider({ children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_jsx_runtime.Fragment, { children });
}
function isGrokEmbedderOrigin(origin) {
	try {
		const url = new URL(origin);
		if (url.protocol !== "https:" && url.protocol !== "http:") return false;
		const host = url.hostname.toLowerCase();
		if (host === "grok.com" || host.endsWith(".grok.com")) return true;
		if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
		return false;
	} catch {
		return false;
	}
}
function isSandboxPreviewGuestHost(hostname) {
	const host = hostname.toLowerCase();
	return host === "grok-sandbox.com" || host.endsWith(".grok-sandbox.com");
}
function isRemintPreviewPair(guestHost, parentHost) {
	const guest = guestHost.toLowerCase();
	const parent = parentHost.toLowerCase();
	const i = guest.indexOf(".preview.");
	if (i <= 0) return false;
	const label = guest.slice(0, i);
	const rest = guest.slice(i + 9);
	if (label.includes(".") || !rest.includes(".")) return false;
	return parent === rest || parent === `grok.${rest}`;
}
function resolveParentEmbedderOrigin(parentIsSelf, referrer, ancestorOrigin, guestHostname = "") {
	if (parentIsSelf) return null;
	for (const candidate of [referrer, ancestorOrigin ?? ""].filter(Boolean)) try {
		const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") continue;
		if (isGrokEmbedderOrigin(url.origin)) return url.origin;
		if (isSandboxPreviewGuestHost(guestHostname) || isRemintPreviewPair(guestHostname, url.hostname)) return url.origin;
	} catch {}
	return null;
}
/**
* Guest side of the grok-web ↔ sandbox preview postMessage bridge.
*
* Activates only when this page is framed by an allowlisted Grok embedder.
* Top-level runs (download/export, local `npm run dev`, deployed sites) noop.
*/
var PREVIEW_BRIDGE_CHANNEL = "grok-preview-bridge";
var EnvelopeSchema = object({
	channel: literal(PREVIEW_BRIDGE_CHANNEL),
	version: number().int().positive(),
	type: string().min(1)
});
var HelloSchema = EnvelopeSchema.extend({ type: literal("hello") });
var NavigateSchema = EnvelopeSchema.extend({
	type: literal("navigate"),
	path: string().min(1)
});
var HistorySchema = EnvelopeSchema.extend({
	type: literal("history"),
	delta: union([literal(-1), literal(1)])
});
function isSafeBridgePath(path) {
	if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
	try {
		return new URL(path, "https://preview.invalid").origin === "https://preview.invalid";
	} catch {
		return false;
	}
}
/**
* Install host↔guest messaging. Returns a dispose function.
* Noops (returns a no-op dispose) when not embedded under a Grok parent.
*/
function installPreviewHostBridge(options = {}) {
	if (typeof window === "undefined") return () => {};
	const ancestorOrigin = typeof location.ancestorOrigins !== "undefined" && location.ancestorOrigins.length > 0 ? location.ancestorOrigins[0] : null;
	const parentOrigin = resolveParentEmbedderOrigin(window.parent === window, document.referrer, ancestorOrigin, window.location.hostname);
	if (parentOrigin === null) return () => {};
	const ROOT_STATE_KEY = "__grokPreviewBridgeRoot";
	const originalPushState = window.history.pushState.bind(window.history);
	const originalReplaceState = window.history.replaceState.bind(window.history);
	const isAtHistoryRoot = () => {
		const state = window.history.state;
		return Boolean(state && typeof state === "object" && state[ROOT_STATE_KEY] === true);
	};
	try {
		const current = window.history.state;
		if (!(current !== null && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, ROOT_STATE_KEY))) {
			const isRoot = window.history.length <= 1;
			originalReplaceState(current && typeof current === "object" ? {
				...current,
				[ROOT_STATE_KEY]: isRoot
			} : { [ROOT_STATE_KEY]: isRoot }, "", window.location.href);
		}
	} catch {}
	const post = (message) => {
		window.parent.postMessage(message, parentOrigin);
	};
	const reportLocation = () => {
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "location",
			path: window.location.pathname || "/",
			search: window.location.search,
			hash: window.location.hash
		});
	};
	const reportRoutes = () => {
		const paths = options.getRoutePaths?.() ?? [];
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "routes",
			paths
		});
	};
	const defaultNavigate = (path) => {
		if (!isSafeBridgePath(path)) return;
		try {
			const url = new URL(path, window.location.origin);
			if (url.origin !== window.location.origin) return;
			const next = `${url.pathname}${url.search}${url.hash}`;
			window.history.pushState(window.history.state, "", next);
			window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
		} catch {}
	};
	const navigate = (path) => {
		if (!isSafeBridgePath(path)) return;
		if (options.navigate) {
			options.navigate(path);
			return;
		}
		defaultNavigate(path);
	};
	const announce = () => {
		reportLocation();
		reportRoutes();
		post({
			channel: PREVIEW_BRIDGE_CHANNEL,
			version: 1,
			type: "ready"
		});
	};
	const onMessage = (event) => {
		if (event.source !== window.parent) return;
		if (event.origin !== parentOrigin) return;
		const envelope = EnvelopeSchema.safeParse(event.data);
		if (!envelope.success || envelope.data.version !== 1) return;
		if (envelope.data.type === "hello") {
			if (!HelloSchema.safeParse(event.data).success) return;
			announce();
			return;
		}
		if (envelope.data.type === "navigate") {
			const parsed = NavigateSchema.safeParse(event.data);
			if (!parsed.success) return;
			navigate(parsed.data.path);
			queueMicrotask(reportLocation);
			return;
		}
		if (envelope.data.type === "history") {
			const parsed = HistorySchema.safeParse(event.data);
			if (!parsed.success) return;
			if (parsed.data.delta === -1 && isAtHistoryRoot()) return;
			window.history.go(parsed.data.delta);
		}
	};
	const onPopState = () => {
		reportLocation();
	};
	const onHashChange = () => {
		reportLocation();
	};
	window.history.pushState = (data, unused, url) => {
		const next = data && typeof data === "object" ? {
			...data,
			[ROOT_STATE_KEY]: false
		} : data;
		originalPushState(next, unused, url);
		reportLocation();
	};
	window.history.replaceState = (data, unused, url) => {
		const next = isAtHistoryRoot() ? {
			...data && typeof data === "object" ? data : {},
			[ROOT_STATE_KEY]: true
		} : data;
		originalReplaceState(next, unused, url);
		reportLocation();
	};
	window.addEventListener("message", onMessage);
	window.addEventListener("popstate", onPopState);
	window.addEventListener("hashchange", onHashChange);
	announce();
	return () => {
		window.removeEventListener("message", onMessage);
		window.removeEventListener("popstate", onPopState);
		window.removeEventListener("hashchange", onHashChange);
		window.history.pushState = originalPushState;
		window.history.replaceState = originalReplaceState;
	};
}
/** Collect static path patterns from a TanStack route tree (best-effort). */
function collectRoutePathsFromTree(routeTree) {
	const paths = /* @__PURE__ */ new Set();
	const walk = (node) => {
		if (!node || typeof node !== "object") return;
		const record = node;
		const full = typeof record.fullPath === "string" ? record.fullPath : typeof record.path === "string" ? record.path : null;
		if (full !== null && full !== "") paths.add(full.startsWith("/") ? full : `/${full}`);
		else if (full === "") paths.add("/");
		const children = record.children;
		if (Array.isArray(children)) for (const child of children) walk(child);
		else if (children && typeof children === "object") for (const child of Object.values(children)) walk(child);
	};
	walk(routeTree);
	return [...paths];
}
/**
* Mount once in `__root.tsx` so the Grok preview chrome can drive navigation
* (and later receive registered routes). Noops when the app is not embedded.
*/
function PreviewHostBridge() {
	const router = useRouter();
	(0, import_react.useEffect)(() => {
		return installPreviewHostBridge({
			navigate: (path) => {
				router.history.push(path);
			},
			getRoutePaths: () => collectRoutePathsFromTree(router.routeTree)
		});
	}, [router]);
	return null;
}
function TooltipProvider({ children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Provider, {
		delayDuration: 200,
		children
	});
}
function Footer() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("footer", {
		className: "mt-auto border-t border-border/70",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto flex max-w-5xl flex-col gap-4 px-4 py-10 sm:px-6 md:flex-row md:items-start md:justify-between",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "max-w-md space-y-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "font-display text-base",
					children: "VideoFetch"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: "Only download videos you have the right to save. Respect copyright and the terms of each website."
				})]
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex gap-6 text-sm text-muted-foreground",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
						to: "/",
						className: "hover:text-foreground",
						children: "Home"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
						to: "/supported-sites",
						className: "hover:text-foreground",
						children: "Supported Sites"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
						to: "/faq",
						className: "hover:text-foreground",
						children: "FAQ"
					})
				]
			})]
		})
	});
}
function LogoMark({ className }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", {
		viewBox: "0 0 32 32",
		className: cn("size-8", className),
		"aria-hidden": "true",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", {
			width: "32",
			height: "32",
			rx: "8",
			className: "fill-foreground"
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", {
			className: "fill-background",
			d: "M14 6h4v8h6l-8 8-8-8h6zM8 24h3v3h10v-3h3v5H8z"
		})]
	});
}
function LogoWordmark({ className }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
		className: cn("flex items-center gap-2.5", className),
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogoMark, {}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
			className: "font-display text-lg font-medium tracking-tight",
			children: "VideoFetch"
		})]
	});
}
var buttonVariants = cva("inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,opacity,transform,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]", {
	variants: {
		variant: {
			default: "bg-primary text-primary-foreground hover:opacity-90",
			secondary: "bg-secondary text-secondary-foreground hover:opacity-90",
			outline: "border border-border bg-transparent hover:bg-muted",
			ghost: "hover:bg-muted",
			destructive: "bg-destructive text-white hover:opacity-90"
		},
		size: {
			default: "h-11 px-5",
			sm: "h-9 px-3 text-sm",
			lg: "h-12 px-6",
			icon: "size-11"
		}
	},
	defaultVariants: {
		variant: "default",
		size: "default"
	}
});
function Button({ className, variant, size, asChild = false, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(asChild ? Slot : "button", {
		className: cn(buttonVariants({
			variant,
			size,
			className
		})),
		...props
	});
}
var KEY = "vf-theme";
function getPreferredTheme() {
	try {
		const stored = localStorage.getItem(KEY);
		if (stored === "light" || stored === "dark") return stored;
	} catch {}
	return "dark";
}
function applyTheme(theme) {
	const root = document.documentElement;
	if (theme === "dark") root.classList.add("dark");
	else root.classList.remove("dark");
	try {
		localStorage.setItem(KEY, theme);
	} catch {}
}
function ThemeToggle() {
	const [theme, setTheme] = (0, import_react.useState)("dark");
	(0, import_react.useEffect)(() => {
		const current = getPreferredTheme();
		setTheme(current);
		applyTheme(current);
	}, []);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
		variant: "ghost",
		size: "icon",
		"aria-label": theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
		onClick: () => {
			const next = theme === "dark" ? "light" : "dark";
			setTheme(next);
			applyTheme(next);
		},
		children: theme === "dark" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Sun, { className: "size-4" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Moon, { className: "size-4" })
	});
}
var NAV = [
	{
		to: "/",
		label: "Home",
		short: "Home"
	},
	{
		to: "/supported-sites",
		label: "Supported Sites",
		short: "Sites"
	},
	{
		to: "/faq",
		label: "FAQ",
		short: "FAQ"
	}
];
function Header() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", {
		className: "sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "mx-auto flex h-16 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6",
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
					to: "/",
					className: "shrink-0",
					"aria-label": "VideoFetch home",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LogoWordmark, {})
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
					className: "hidden items-center gap-1 md:flex",
					children: NAV.map((item) => {
						const active = pathname === item.to;
						return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
							to: item.to,
							className: cn("rounded-md px-3 py-2 text-sm transition-colors duration-150", active ? "text-foreground" : "text-muted-foreground hover:text-foreground"),
							children: item.label
						}, item.to);
					})
				}),
				/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center gap-1",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", {
						className: "flex items-center md:hidden",
						children: NAV.slice(1).map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Link, {
							to: item.to,
							className: "rounded-md px-2 py-2 text-sm text-muted-foreground",
							children: item.short
						}, item.to))
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ThemeToggle, {})]
				})
			]
		})
	});
}
function AppShell({ children }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex min-h-dvh flex-col bg-background text-foreground",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("main", {
				className: "flex-1",
				children
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Footer, {})
		]
	});
}
var styles_default = "/assets/styles-BA9snyJb.css";
var APP_NAME = "VideoFetch";
var Route$11 = createRootRoute({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1"
			},
			{ title: APP_NAME },
			{
				name: "description",
				content: "Paste a video link, choose your quality, and download."
			},
			{
				name: "theme-color",
				content: "#0b0c0e"
			}
		],
		links: [
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/favicon.svg"
			},
			{
				rel: "stylesheet",
				href: styles_default
			},
			{
				rel: "manifest",
				href: "/__grok/manifest.webmanifest"
			},
			{
				rel: "apple-touch-icon",
				href: "/__grok/icon-180.png"
			},
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com"
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous"
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Outfit:wght@400;500;600&display=swap"
			}
		]
	}),
	component: RootComponent
});
function RootComponent() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("html", {
		lang: "en",
		className: "dark antialiased",
		suppressHydrationWarning: true,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("head", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HeadContent, {}) }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("body", { children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(PreviewHostBridge, {}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("script", { dangerouslySetInnerHTML: { __html: `try{var t=localStorage.getItem('vf-theme');if(t==='light')document.documentElement.classList.remove('dark');else document.documentElement.classList.add('dark')}catch(e){}` } }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AuthProvider, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(TooltipProvider, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AppShell, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Outlet, {}) }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toaster, {
				richColors: true,
				position: "bottom-center"
			})] }) }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Scripts, {})
		] })]
	});
}
var $$splitComponentImporter$3 = () => import("./routes-DMR2VEhr.mjs");
var Route$10 = createFileRoute("/")({ component: lazyRouteComponent($$splitComponentImporter$3, "component") });
var $$splitComponentImporter$2 = () => import("./diagnostics-DkmiNElo.mjs");
var Route$9 = createFileRoute("/diagnostics")({ component: lazyRouteComponent($$splitComponentImporter$2, "component") });
var $$splitComponentImporter$1 = () => import("./faq-BGoPxyVi.mjs");
var Route$8 = createFileRoute("/faq")({ component: lazyRouteComponent($$splitComponentImporter$1, "component") });
var $$splitComponentImporter = () => import("./supported-sites-BdvLZJXz.mjs");
var Route$7 = createFileRoute("/supported-sites")({ component: lazyRouteComponent($$splitComponentImporter, "component") });
function num(name, fallback) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function str(name, fallback) {
	const raw = process.env[name];
	return raw && raw.length > 0 ? raw : fallback;
}
var config = {
	maxFileSize: num("MAX_FILE_SIZE", 524288e3),
	maxVideoDuration: num("MAX_VIDEO_DURATION", 7200),
	fileExpirationMinutes: num("FILE_EXPIRATION_MINUTES", 45),
	maxConcurrentDownloads: num("MAX_CONCURRENT_DOWNLOADS", 3),
	maxConcurrentPerIp: num("MAX_CONCURRENT_PER_IP", 2),
	rateLimitPerMinute: num("RATE_LIMIT", 20),
	tempDirectory: str("TEMP_DIRECTORY", join(tmpdir(), "videofetch")),
	ffmpegPath: str("FFMPEG_PATH", "/usr/local/bin/ffmpeg"),
	downloadTimeoutMs: num("DOWNLOAD_TIMEOUT", 600) * 1e3,
	analysisTimeoutMs: num("ANALYSIS_TIMEOUT", 45) * 1e3,
	maxRedirects: num("MAX_REDIRECTS", 5),
	diagnosticsToken: str("DIAGNOSTICS_TOKEN", ""),
	nodeEnv: str("NODE_ENV", "development")
};
function resolveYtdlp() {
	const explicit = process.env.YTDLP_PATH;
	if (explicit && explicit.length > 0) {
		const parts = explicit.split(" ").filter(Boolean);
		return {
			command: parts[0] ?? "python3",
			argsPrefix: parts.slice(1)
		};
	}
	return {
		command: "python3",
		argsPrefix: ["-m", "yt_dlp"]
	};
}
function isProd() {
	return config.nodeEnv === "production";
}
var ERROR_MESSAGES = {
	INVALID_URL: "Please enter a valid video URL.",
	UNSUPPORTED_SITE: "This website is not currently supported.",
	VIDEO_UNAVAILABLE: "The video could not be accessed or is no longer available.",
	ANALYSIS_FAILED: "We couldn't analyze this video.",
	FORMAT_UNAVAILABLE: "The selected quality is no longer available.",
	SERVER_OVERLOAD: "The server is currently processing too many downloads. Please try again shortly.",
	PROCESSING_FAILED: "We couldn't process this video. Try another format or source.",
	TIMEOUT: "The video took too long to process.",
	NETWORK_ERROR: "We couldn't connect to the source website.",
	EXTRACTION_FAILED: "We couldn't extract the video streams from this page.",
	TOO_LARGE: "This video exceeds the maximum supported download size.",
	TOO_LONG: "This video exceeds the maximum supported duration.",
	RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
	NOT_FOUND: "We couldn't find that download.",
	EXPIRED: "This download link has expired. Please analyze the video again.",
	FORBIDDEN: "Diagnostics are not available in this environment."
};
var STATUS_BY_CODE = {
	INVALID_URL: 400,
	UNSUPPORTED_SITE: 422,
	VIDEO_UNAVAILABLE: 404,
	ANALYSIS_FAILED: 502,
	FORMAT_UNAVAILABLE: 409,
	SERVER_OVERLOAD: 429,
	PROCESSING_FAILED: 500,
	TIMEOUT: 504,
	NETWORK_ERROR: 502,
	EXTRACTION_FAILED: 502,
	TOO_LARGE: 413,
	TOO_LONG: 413,
	RATE_LIMITED: 429,
	NOT_FOUND: 404,
	EXPIRED: 410,
	FORBIDDEN: 403
};
var AppError = class extends Error {
	code;
	status;
	constructor(code, message, status) {
		super(message ?? ERROR_MESSAGES[code]);
		this.name = "AppError";
		this.code = code;
		this.status = status ?? STATUS_BY_CODE[code];
	}
};
function jsonError(error, fallback = "ANALYSIS_FAILED") {
	if (error instanceof AppError) return Response.json({
		success: false,
		error: {
			code: error.code,
			message: error.message
		}
	}, { status: error.status });
	return Response.json({
		success: false,
		error: {
			code: fallback,
			message: ERROR_MESSAGES[fallback]
		}
	}, { status: STATUS_BY_CODE[fallback] });
}
function mapExtractorMessage(raw) {
	const text = raw.toLowerCase();
	if (text.includes("unsupported url") || text.includes("no video formats")) return new AppError("UNSUPPORTED_SITE");
	if (text.includes("sign in") || text.includes("not a bot") || text.includes("login required") || text.includes("only works when logged-in") || text.includes("private video") || text.includes("unavailable") || text.includes("removed") || text.includes("copyright") || text.includes("cookies")) return new AppError("VIDEO_UNAVAILABLE", "The video could not be accessed or is no longer available.");
	if (text.includes("timed out") || text.includes("timeout")) return new AppError("TIMEOUT");
	if (text.includes("connection") || text.includes("network") || text.includes("name or service not known") || text.includes("temporary failure in name resolution")) return new AppError("NETWORK_ERROR");
	if (text.includes("max filesize") || text.includes("file is larger")) return new AppError("TOO_LARGE");
	return new AppError("EXTRACTION_FAILED");
}
function clientIp() {
	try {
		return getRequestIP$1({ xForwardedFor: true }) || "unknown";
	} catch {
		return "unknown";
	}
}
var windows = /* @__PURE__ */ new Map();
function prune(bucket, now, windowMs) {
	bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
}
function consumeRateLimit(key, limit, windowMs = 6e4) {
	const now = Date.now();
	const bucket = windows.get(key) ?? { timestamps: [] };
	prune(bucket, now, windowMs);
	if (bucket.timestamps.length >= limit) {
		windows.set(key, bucket);
		return false;
	}
	bucket.timestamps.push(now);
	windows.set(key, bucket);
	return true;
}
var BLOCKED_HOSTS = /* @__PURE__ */ new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
	"metadata.google.internal",
	"metadata.goog",
	"kubernetes.default",
	"kubernetes.default.svc"
]);
function normalizeInputUrl(raw) {
	return raw.trim();
}
function coerceHttpUrl(raw) {
	const trimmed = normalizeInputUrl(raw);
	if (!trimmed) return trimmed;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
	if (trimmed.startsWith("//")) return `https:${trimmed}`;
	return `https://${trimmed}`;
}
function isIpv4(host) {
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	return parts.every((p) => {
		if (!/^\d{1,3}$/.test(p)) return false;
		const n = Number(p);
		return n >= 0 && n <= 255;
	});
}
function ipv4ToInt(ip) {
	const [a, b, c, d] = ip.split(".").map((x) => Number(x));
	return (a << 24 >>> 0) + (b << 16) + (c << 8) + d >>> 0;
}
function inCidr(ip, cidr) {
	const [base, bitsRaw] = cidr.split("/");
	if (!base || !isIpv4(ip) || !isIpv4(base)) return false;
	const bits = Number(bitsRaw);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	const mask = bits === 0 ? 0 : -1 << 32 - bits >>> 0;
	return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
var PRIVATE_V4_CIDRS = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
	"255.255.255.255/32"
];
function isPrivateIpv4(ip) {
	if (!isIpv4(ip)) return false;
	return PRIVATE_V4_CIDRS.some((cidr) => inCidr(ip, cidr));
}
function isPrivateIpv6(ip) {
	const normalized = ip.toLowerCase().trim();
	if (normalized === "::" || normalized === "::1") return true;
	if (normalized.startsWith("fe80:") || normalized.startsWith("fe80::")) return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (normalized.startsWith("ff")) return true;
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
	if (normalized.match(/^::ffff:([0-9a-f:]+)$/i)) return true;
	return false;
}
function isPrivateIp(ip) {
	const value = ip.replace(/^\[|\]$/g, "");
	if (isIpv4(value)) return isPrivateIpv4(value);
	return isPrivateIpv6(value);
}
function hostnameLooksBlocked(hostname) {
	const host = hostname.replace(/\.$/, "").toLowerCase();
	if (!host) return true;
	if (BLOCKED_HOSTS.has(host)) return true;
	if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
	if (host.endsWith(".arpa")) return true;
	if (isPrivateIp(host)) return true;
	return false;
}
var MEDIA_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
var SAMPLE_PROTOCOLS = /* @__PURE__ */ new Set(["sample:"]);
function validatePublicHttpUrl(raw) {
	const trimmed = normalizeInputUrl(raw);
	if (!trimmed) return {
		ok: false,
		message: "Please enter a valid video URL.",
		code: "INVALID_URL"
	};
	if (/^sample:\/\//i.test(trimmed) || /^sample:/i.test(trimmed)) return {
		ok: true,
		url: trimmed,
		hostname: "sample"
	};
	let href = coerceHttpUrl(trimmed);
	let parsed;
	try {
		parsed = new URL(href);
	} catch {
		return {
			ok: false,
			message: "Please enter a valid video URL.",
			code: "INVALID_URL"
		};
	}
	if (SAMPLE_PROTOCOLS.has(parsed.protocol)) return {
		ok: true,
		url: parsed.toString(),
		hostname: "sample"
	};
	if (!MEDIA_PROTOCOLS.has(parsed.protocol)) return {
		ok: false,
		message: "Please enter a valid video URL.",
		code: "INVALID_URL"
	};
	if (parsed.username || parsed.password) return {
		ok: false,
		message: "Please enter a valid video URL.",
		code: "INVALID_URL"
	};
	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	if (!hostname) return {
		ok: false,
		message: "Please enter a valid video URL.",
		code: "INVALID_URL"
	};
	if (hostnameLooksBlocked(hostname)) return {
		ok: false,
		message: "Please enter a valid video URL.",
		code: "INVALID_URL"
	};
	if (!hostname.includes(".") && !isIpv4(hostname) && !hostname.includes(":")) return {
		ok: false,
		message: "Please enter a valid video URL.",
		code: "INVALID_URL"
	};
	if (isIpv4(hostname) && isPrivateIpv4(hostname)) return {
		ok: false,
		message: "Please enter a valid video URL.",
		code: "INVALID_URL"
	};
	return {
		ok: true,
		url: parsed.toString(),
		hostname
	};
}
function extractDomain(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}
async function assertSafeUrl(raw) {
	const checked = validatePublicHttpUrl(raw);
	if (!checked.ok) throw new AppError("INVALID_URL", checked.message);
	if (checked.hostname === "sample") return {
		url: checked.url,
		hostname: "sample"
	};
	const hostname = checked.hostname;
	if (hostnameLooksBlocked(hostname)) throw new AppError("INVALID_URL");
	let addresses;
	try {
		addresses = await lookup(hostname, {
			all: true,
			verbatim: true
		});
	} catch {
		throw new AppError("NETWORK_ERROR");
	}
	if (!addresses.length) throw new AppError("NETWORK_ERROR");
	for (const addr of addresses) if (isPrivateIp(addr.address)) throw new AppError("INVALID_URL");
	return {
		url: checked.url,
		hostname
	};
}
function emit(level, msg, fields) {
	const payload = {
		ts: (/* @__PURE__ */ new Date()).toISOString(),
		level,
		msg,
		...fields
	};
	const line = JSON.stringify(payload);
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
}
function redactUrl(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return "[invalid-url]";
	}
}
var log = {
	info: (msg, fields) => emit("info", msg, fields),
	warn: (msg, fields) => emit("warn", msg, fields),
	error: (msg, fields) => emit("error", msg, fields)
};
var HEIGHT_STEPS = [
	{
		min: 2160,
		label: "2160p"
	},
	{
		min: 1440,
		label: "1440p"
	},
	{
		min: 1080,
		label: "1080p"
	},
	{
		min: 720,
		label: "720p"
	},
	{
		min: 480,
		label: "480p"
	},
	{
		min: 360,
		label: "360p"
	},
	{
		min: 240,
		label: "240p"
	},
	{
		min: 144,
		label: "144p"
	}
];
function resolutionFromHeight(height) {
	if (!height || height <= 0) return "unknown";
	for (const step of HEIGHT_STEPS) if (height >= step.min) return step.label;
	return "144p";
}
function isNone(codec) {
	return !codec || codec === "none" || codec === "null";
}
var SKIP_EXTS = /* @__PURE__ */ new Set([
	"mhtml",
	"storyboard",
	"jpg",
	"png",
	"webp",
	"mhtml_storyboard"
]);
function normalizeYtdlpFormat(raw) {
	const id = String(raw.format_id ?? "").trim();
	if (!id) return null;
	const ext = (raw.ext || "mp4").toLowerCase();
	if (SKIP_EXTS.has(ext)) return null;
	const note = (raw.format_note || "").toLowerCase();
	if (note.includes("storyboard") || note.includes("preview image")) return null;
	if ((raw.protocol || "").toLowerCase().includes("mhtml")) return null;
	const hasVideo = !isNone(raw.vcodec) && raw.video_ext !== "none";
	const hasAudio = !isNone(raw.acodec) && raw.audio_ext !== "none";
	if (!hasVideo && !hasAudio) return null;
	const height = raw.height && raw.height > 0 ? raw.height : null;
	const width = raw.width && raw.width > 0 ? raw.width : null;
	const resolution = hasVideo ? resolutionFromHeight(height) : "audio";
	const bitrate = (raw.tbr ? raw.tbr * 1e3 : null) ?? (raw.vbr ? raw.vbr * 1e3 : null) ?? (raw.abr ? raw.abr * 1e3 : null);
	return {
		id,
		resolution,
		width,
		height,
		fps: raw.fps && raw.fps > 0 ? Math.round(raw.fps * 100) / 100 : null,
		container: ext,
		videoCodec: hasVideo ? normalizeCodec(raw.vcodec) : null,
		audioCodec: hasAudio ? normalizeCodec(raw.acodec) : null,
		bitrate,
		fileSize: raw.filesize || raw.filesize_approx || null,
		hasVideo,
		hasAudio,
		formatNote: raw.format_note ?? null
	};
}
function normalizeCodec(codec) {
	if (!codec || isNone(codec)) return null;
	const c = codec.toLowerCase();
	if (c.startsWith("avc") || c.includes("h264")) return "h264";
	if (c.includes("av01") || c.includes("av1")) return "av1";
	if (c.includes("vp09") || c.includes("vp9")) return "vp9";
	if (c.includes("vp8")) return "vp8";
	if (c.includes("hev") || c.includes("h265") || c.includes("hevc")) return "h265";
	if (c.includes("mp4a") || c.includes("aac")) return "aac";
	if (c.includes("opus")) return "opus";
	if (c.includes("mp3") || c.includes("mp3")) return "mp3";
	if (c.includes("vorbis")) return "vorbis";
	if (c.includes("flac")) return "flac";
	return codec.split(".")[0] ?? codec;
}
function containerScore(container, videoCodec) {
	const c = container.toLowerCase();
	if (c === "mp4" && (videoCodec === "h264" || videoCodec === null)) return 100;
	if (c === "mp4") return 80;
	if (c === "m4a") return 70;
	if (c === "webm") return 50;
	if (c === "mkv") return 40;
	return 10;
}
function codecScore(videoCodec, audioCodec) {
	let score = 0;
	if (videoCodec === "h264") score += 40;
	else if (videoCodec === "vp9") score += 25;
	else if (videoCodec === "av1") score += 15;
	else if (videoCodec === "h265") score += 20;
	if (audioCodec === "aac") score += 20;
	else if (audioCodec === "mp3") score += 15;
	else if (audioCodec === "opus") score += 10;
	return score;
}
function scoreFormat(format) {
	let score = 0;
	if (format.hasVideo && format.hasAudio) score += 200;
	else if (format.hasVideo) score += 80;
	else if (format.hasAudio) score += 60;
	score += containerScore(format.container, format.videoCodec);
	score += codecScore(format.videoCodec, format.audioCodec);
	if (format.fileSize) score += Math.min(20, format.fileSize / 52428800);
	if (format.bitrate) score += Math.min(15, format.bitrate / 1e6);
	return score;
}
function pickBest(formats) {
	if (!formats.length) return null;
	return [...formats].sort((a, b) => scoreFormat(b) - scoreFormat(a))[0] ?? null;
}
var PRESET_LABELS = {
	"2160p": "2160p / 4K",
	"1440p": "1440p",
	"1080p": "1080p",
	"720p": "720p",
	"480p": "480p",
	"360p": "360p",
	"240p": "240p",
	"144p": "144p"
};
function buildPresets(formats, options) {
	const videoFormats = formats.filter((f) => f.hasVideo);
	const audioFormats = formats.filter((f) => f.hasAudio && !f.hasVideo);
	const combinedOrVideo = formats.filter((f) => f.hasVideo);
	const presets = [];
	const bestVideo = pickBest(combinedOrVideo);
	if (bestVideo) presets.push({
		id: "preset:best",
		label: "Best available",
		resolution: bestVideo.resolution,
		container: preferContainer(bestVideo),
		fileSize: bestVideo.fileSize,
		hasVideo: true,
		hasAudio: true,
		formatId: "preset:best",
		videoCodec: bestVideo.videoCodec,
		audioCodec: bestVideo.audioCodec,
		fps: bestVideo.fps
	});
	const byRes = /* @__PURE__ */ new Map();
	for (const format of videoFormats) {
		const key = format.resolution;
		const list = byRes.get(key) ?? [];
		list.push(format);
		byRes.set(key, list);
	}
	for (const step of HEIGHT_STEPS) {
		const group = byRes.get(step.label);
		if (!group?.length) continue;
		const best = pickBest(group);
		if (!best) continue;
		presets.push({
			id: `preset:${step.min}`,
			label: PRESET_LABELS[step.label] ?? step.label,
			resolution: step.label,
			container: preferContainer(best),
			fileSize: best.fileSize,
			hasVideo: true,
			hasAudio: true,
			formatId: `preset:${step.min}`,
			videoCodec: best.videoCodec,
			audioCodec: best.audioCodec,
			fps: best.fps
		});
	}
	const bestAudio = pickBest(audioFormats.length ? audioFormats : formats.filter((f) => f.hasAudio));
	if (bestAudio) {
		presets.push({
			id: "preset:audio",
			label: "Audio only",
			resolution: "audio",
			container: bestAudio.hasVideo ? "m4a" : bestAudio.container,
			fileSize: bestAudio.fileSize,
			hasVideo: false,
			hasAudio: true,
			formatId: "preset:audio",
			videoCodec: null,
			audioCodec: bestAudio.audioCodec,
			fps: null
		});
		if (options.mp3) presets.push({
			id: "preset:mp3",
			label: "Audio only (MP3)",
			resolution: "audio",
			container: "mp3",
			fileSize: null,
			hasVideo: false,
			hasAudio: true,
			formatId: "preset:mp3",
			videoCodec: null,
			audioCodec: "mp3",
			fps: null
		});
	}
	return presets;
}
function preferContainer(format) {
	if (format.container === "mp4" || format.container === "m4a") return format.container;
	if (format.videoCodec === "h264" || format.videoCodec === "h265") return "mp4";
	if (format.container === "webm") return "webm";
	return "mp4";
}
function ytDlpFormatSelector(formatId) {
	if (formatId === "preset:best") return {
		selector: "bv*+ba/b",
		extractAudio: false,
		mergeFormat: "mp4"
	};
	if (formatId === "preset:audio") return {
		selector: "ba/b",
		extractAudio: true
	};
	if (formatId === "preset:mp3") return {
		selector: "ba/b",
		extractAudio: true,
		audioFormat: "mp3"
	};
	const preset = /^preset:(\d+)$/.exec(formatId);
	if (preset) {
		const height = Number(preset[1]);
		return {
			selector: `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`,
			extractAudio: false,
			mergeFormat: "mp4",
			heightCap: height
		};
	}
	return {
		selector: formatId,
		extractAudio: false
	};
}
function mimeForContainer(container) {
	switch (container.toLowerCase()) {
		case "mp4":
		case "m4v": return "video/mp4";
		case "webm": return "video/webm";
		case "mkv": return "video/x-matroska";
		case "mp3": return "audio/mpeg";
		case "m4a": return "audio/mp4";
		case "ogg":
		case "opus": return "audio/ogg";
		case "wav": return "audio/wav";
		default: return "application/octet-stream";
	}
}
function parseYtdlpProgress(line) {
	const percentMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
	if (!percentMatch) {
		if (line.includes("[Merger]") || line.includes("[ExtractAudio]") || line.includes("[VideoConvertor]")) return {
			progress: null,
			downloadedBytes: null,
			totalBytes: null,
			speed: null,
			eta: null
		};
		return null;
	}
	const progress = Number(percentMatch[1]);
	const totalMatch = line.match(/of\s+~?\s*([\d.]+)\s*([KMG]i?B)/i);
	const speedMatch = line.match(/at\s+([\d.]+)\s*([KMG]i?B)\/s/i);
	const etaMatch = line.match(/ETA\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
	line.match(/(\d+(?:\.\d+)?)%\s+of\s+~?\s*([\d.]+)\s*([KMG]i?B)/i);
	const totalBytes = totalMatch ? parseSize(totalMatch[1], totalMatch[2]) : null;
	const downloadedBytes = totalBytes != null && Number.isFinite(progress) ? Math.round(progress / 100 * totalBytes) : null;
	const speed = speedMatch ? parseSize(speedMatch[1], speedMatch[2]) : null;
	let eta = null;
	if (etaMatch) {
		const a = Number(etaMatch[1]);
		const b = Number(etaMatch[2]);
		const c = etaMatch[3] != null ? Number(etaMatch[3]) : null;
		eta = c == null ? a * 60 + b : a * 3600 + b * 60 + c;
	}
	return {
		progress,
		downloadedBytes,
		totalBytes,
		speed,
		eta
	};
}
function parseSize(value, unit) {
	const n = Number(value);
	const u = unit.toUpperCase();
	if (u.startsWith("KI")) return n * 1024;
	if (u.startsWith("K")) return n * 1e3;
	if (u.startsWith("MI")) return n * 1024 * 1024;
	if (u.startsWith("M")) return n * 1e3 * 1e3;
	if (u.startsWith("GI")) return n * 1024 * 1024 * 1024;
	if (u.startsWith("G")) return n * 1e3 * 1e3 * 1e3;
	return n;
}
function runProcess(opts) {
	const { command, args, timeoutMs, cwd, signal, onStdout, onStderr, env } = opts;
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			env: env ?? process.env,
			shell: false,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killed = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killed = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		const onAbort = () => {
			killed = true;
			child.kill("SIGKILL");
		};
		signal?.addEventListener("abort", onAbort);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 8e6) stdout = stdout.slice(-4e6);
			onStdout?.(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.length > 2e6) stderr = stderr.slice(-1e6);
			onStderr?.(chunk);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (timedOut) {
				reject(new AppError("TIMEOUT"));
				return;
			}
			if (signal?.aborted) {
				reject(new AppError("PROCESSING_FAILED", "Download was cancelled."));
				return;
			}
			if (killed && code !== 0) {
				reject(new AppError("PROCESSING_FAILED"));
				return;
			}
			resolve({
				code,
				stdout,
				stderr
			});
		});
	});
}
async function ffmpegAvailable() {
	try {
		await access(config.ffmpegPath);
		const result = await runProcess({
			command: config.ffmpegPath,
			args: ["-version"],
			timeoutMs: 8e3
		});
		return (result.stdout + result.stderr).toLowerCase().includes("ffmpeg version");
	} catch {
		return false;
	}
}
async function convertMedia(opts) {
	const outName = opts.target === "mp3" ? "converted.mp3" : opts.target === "webm" ? "converted.webm" : "converted.mp4";
	const outputPath = join(opts.workDir, outName);
	const args = opts.target === "mp3" ? [
		"-y",
		"-nostdin",
		"-i",
		opts.inputPath,
		"-vn",
		"-c:a",
		"libmp3lame",
		"-q:a",
		"2",
		outputPath
	] : opts.target === "webm" ? [
		"-y",
		"-nostdin",
		"-i",
		opts.inputPath,
		"-c:v",
		"libvpx-vp9",
		"-b:v",
		"0",
		"-crf",
		"32",
		"-c:a",
		"libopus",
		outputPath
	] : [
		"-y",
		"-nostdin",
		"-i",
		opts.inputPath,
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-movflags",
		"+faststart",
		outputPath
	];
	opts.onProgress?.(null);
	if ((await runProcess({
		command: config.ffmpegPath,
		args,
		timeoutMs: opts.timeoutMs,
		cwd: opts.workDir,
		signal: opts.signal
	})).code !== 0) throw new AppError("PROCESSING_FAILED");
	opts.onProgress?.(100);
	return outputPath;
}
function probeFromFfmpegOutput(stderr) {
	const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
	let duration = null;
	if (durationMatch) duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
	const videoMatch = stderr.match(/Stream #0:\d+.*Video:\s*([a-zA-Z0-9_]+).*?(\d{2,5})x(\d{2,5})(?:.*?(\d+(?:\.\d+)?)\s*fps)?/);
	const audioMatch = stderr.match(/Stream #0:\d+.*Audio:\s*([a-zA-Z0-9_]+)/);
	const containerMatch = stderr.match(/Input #0,\s*([^,]+),/);
	return {
		duration,
		videoCodec: videoMatch?.[1] ?? null,
		width: videoMatch?.[2] ? Number(videoMatch[2]) : null,
		height: videoMatch?.[3] ? Number(videoMatch[3]) : null,
		fps: videoMatch?.[4] ? Number(videoMatch[4]) : null,
		audioCodec: audioMatch?.[1] ?? null,
		container: containerMatch?.[1]?.split(",")[0]?.trim() ?? null
	};
}
async function generateSampleClip(workDir, timeoutMs) {
	const outputPath = join(workDir, "sample.mp4");
	if ((await runProcess({
		command: config.ffmpegPath,
		args: [
			"-y",
			"-nostdin",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=5:size=1280x720:rate=24",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=5",
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-shortest",
			"-movflags",
			"+faststart",
			outputPath
		],
		timeoutMs,
		cwd: workDir
	})).code !== 0) throw new AppError("PROCESSING_FAILED", `Could not generate sample clip. ${basename(outputPath)}`);
	return outputPath;
}
var MEDIA_EXT = /* @__PURE__ */ new Set([
	"mp4",
	"webm",
	"mkv",
	"mov",
	"m4v",
	"avi",
	"ogv",
	"m4a",
	"mp3",
	"ogg",
	"wav",
	"aac",
	"flac",
	"opus"
]);
function extensionFromUrl(url) {
	try {
		const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
		return MEDIA_EXT.has(ext) ? ext : null;
	} catch {
		return null;
	}
}
var directExtractor = {
	id: "direct",
	name: "Direct media",
	canHandle(url) {
		return Boolean(extensionFromUrl(url));
	},
	async getMetadata(url) {
		return probeDirect(url);
	},
	async getFormats(url) {
		return (await probeDirect(url)).formats;
	},
	async download(url, format, ctx) {
		return downloadDirect(url, format, ctx);
	}
};
async function probeDirect(url) {
	const ext = extensionFromUrl(url) || "mp4";
	let contentLength = null;
	let contentType = null;
	try {
		const head = await fetchFollow(url, "HEAD");
		contentLength = parseLen(head.headers.get("content-length"));
		contentType = head.headers.get("content-type");
	} catch {}
	let probe = {
		duration: null,
		width: null,
		height: null,
		fps: null,
		videoCodec: null,
		audioCodec: null,
		container: ext
	};
	try {
		const result = await runProcess({
			command: config.ffmpegPath,
			args: [
				"-nostdin",
				"-hide_banner",
				"-i",
				url
			],
			timeoutMs: Math.min(config.analysisTimeoutMs, 2e4)
		});
		const probed = probeFromFfmpegOutput(result.stderr + result.stdout);
		probe = {
			...probe,
			...probed,
			container: probed.container || probe.container
		};
	} catch {}
	const hasVideo = Boolean(probe.videoCodec) || ![
		"mp3",
		"m4a",
		"aac",
		"wav",
		"ogg",
		"flac",
		"opus"
	].includes(ext);
	const hasAudio = Boolean(probe.audioCodec) || true;
	const format = {
		id: "direct-original",
		resolution: hasVideo ? resolutionFromHeight(probe.height) : "audio",
		width: probe.width,
		height: probe.height,
		fps: probe.fps,
		container: ext,
		videoCodec: hasVideo ? normalizeCodec(probe.videoCodec) : null,
		audioCodec: hasAudio ? normalizeCodec(probe.audioCodec) : null,
		bitrate: null,
		fileSize: contentLength,
		hasVideo,
		hasAudio,
		formatNote: contentType
	};
	const mp3 = await ffmpegAvailable();
	return {
		title: decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "Video").replace(/\.[a-z0-9]+$/i, "") || "Video",
		thumbnail: null,
		duration: probe.duration,
		source: extractDomain(url),
		extractor: "direct",
		webpageUrl: url,
		formats: [format],
		presets: buildPresets([format], { mp3 }),
		capabilities: {
			mp3,
			merge: mp3
		}
	};
}
async function downloadDirect(url, format, ctx) {
	const ext = extensionFromUrl(url) || "bin";
	const dest = join(ctx.workDir, `source.${ext}`);
	await streamDownload(url, dest, ctx);
	if ((await stat(dest)).size > config.maxFileSize) throw new AppError("TOO_LARGE");
	let filePath = dest;
	let container = ext;
	if (format.formatId === "preset:mp3" || format.convertMp3) {
		ctx.onProgress?.({
			progress: null,
			stage: "converting"
		});
		filePath = await convertMedia({
			inputPath: dest,
			workDir: ctx.workDir,
			target: "mp3",
			timeoutMs: config.downloadTimeoutMs,
			signal: ctx.signal
		});
		container = "mp3";
	} else if (format.preferredContainer && format.preferredContainer !== ext) {
		const target = format.preferredContainer === "webm" ? "webm" : "mp4";
		ctx.onProgress?.({
			progress: null,
			stage: "converting"
		});
		filePath = await convertMedia({
			inputPath: dest,
			workDir: ctx.workDir,
			target,
			timeoutMs: config.downloadTimeoutMs,
			signal: ctx.signal
		});
		container = target;
	}
	const outStat = await stat(filePath);
	return {
		filePath,
		container,
		mime: mimeForContainer(container),
		fileSize: outStat.size,
		quality: format.formatId.startsWith("preset:") ? format.formatId.replace("preset:", "") : "original"
	};
}
async function streamDownload(url, dest, ctx) {
	let current = url;
	for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
		await assertSafeUrl(current);
		const res = await fetch(current, {
			method: "GET",
			redirect: "manual",
			signal: ctx.signal,
			headers: {
				"User-Agent": "VideoFetch/1.0",
				Accept: "video/*,audio/*,*/*;q=0.8"
			}
		});
		if ([
			301,
			302,
			303,
			307,
			308
		].includes(res.status)) {
			const loc = res.headers.get("location");
			if (!loc) throw new AppError("NETWORK_ERROR");
			current = new URL(loc, current).toString();
			continue;
		}
		if (!res.ok || !res.body) throw new AppError(res.status === 404 ? "VIDEO_UNAVAILABLE" : "NETWORK_ERROR");
		if ((res.headers.get("content-type") || "").startsWith("text/html")) throw new AppError("EXTRACTION_FAILED");
		const total = parseLen(res.headers.get("content-length"));
		let downloaded = 0;
		const started = Date.now();
		const nodeReadable = Readable.fromWeb(res.body);
		nodeReadable.on("data", (chunk) => {
			downloaded += chunk.length;
			if (downloaded > config.maxFileSize) {
				nodeReadable.destroy(new AppError("TOO_LARGE"));
				return;
			}
			const elapsed = (Date.now() - started) / 1e3;
			const speed = elapsed > 0 ? downloaded / elapsed : null;
			const progress = total ? Math.min(99, Math.round(downloaded / total * 100)) : null;
			const eta = speed && total ? Math.max(0, (total - downloaded) / speed) : null;
			ctx.onProgress?.({
				progress,
				downloadedBytes: downloaded,
				totalBytes: total,
				speed,
				eta,
				stage: "downloading"
			});
		});
		await pipeline(nodeReadable, createWriteStream(dest));
		return;
	}
	throw new AppError("NETWORK_ERROR");
}
async function fetchFollow(url, method) {
	let current = url;
	for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
		await assertSafeUrl(current);
		const res = await fetch(current, {
			method,
			redirect: "manual",
			headers: { "User-Agent": "VideoFetch/1.0" }
		});
		if ([
			301,
			302,
			303,
			307,
			308
		].includes(res.status)) {
			const loc = res.headers.get("location");
			if (!loc) throw new AppError("NETWORK_ERROR");
			current = new URL(loc, current).toString();
			continue;
		}
		return res;
	}
	throw new AppError("NETWORK_ERROR");
}
function parseLen(value) {
	if (!value) return null;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : null;
}
var SAMPLE_FORMATS = [{
	id: "sample-720",
	resolution: "720p",
	width: 1280,
	height: 720,
	fps: 24,
	container: "mp4",
	videoCodec: "h264",
	audioCodec: "aac",
	bitrate: 12e5,
	fileSize: 4e5,
	hasVideo: true,
	hasAudio: true
}, {
	id: "sample-audio",
	resolution: "audio",
	width: null,
	height: null,
	fps: null,
	container: "m4a",
	videoCodec: null,
	audioCodec: "aac",
	bitrate: 128e3,
	fileSize: 8e4,
	hasVideo: false,
	hasAudio: true
}];
var sampleExtractor = {
	id: "sample",
	name: "Sample clip",
	canHandle(url) {
		return /^sample:/i.test(url);
	},
	async getMetadata() {
		const mp3 = await ffmpegAvailable();
		return {
			title: "VideoFetch sample clip",
			thumbnail: null,
			duration: 5,
			source: "sample",
			extractor: "sample",
			webpageUrl: "sample://demo",
			formats: SAMPLE_FORMATS,
			presets: buildPresets(SAMPLE_FORMATS, { mp3 }),
			capabilities: {
				mp3,
				merge: mp3
			}
		};
	},
	async getFormats() {
		return SAMPLE_FORMATS;
	},
	async download(_url, format, ctx) {
		ctx.onProgress?.({
			progress: 10,
			stage: "processing"
		});
		const generated = await generateSampleClip(ctx.workDir, 3e4);
		ctx.onProgress?.({
			progress: 70,
			stage: "processing"
		});
		let filePath = generated;
		let container = "mp4";
		if (format.formatId === "preset:mp3" || format.formatId === "preset:audio" || format.convertMp3) {
			const target = format.formatId === "preset:mp3" || format.convertMp3 ? "mp3" : "mp3";
			filePath = await convertMedia({
				inputPath: generated,
				workDir: ctx.workDir,
				target: target === "mp3" ? "mp3" : "mp3",
				timeoutMs: 3e4,
				signal: ctx.signal
			});
			container = "mp3";
		}
		const st = await stat(filePath);
		if (st.size > config.maxFileSize) throw new AppError("TOO_LARGE");
		ctx.onProgress?.({
			progress: 100,
			stage: "processing"
		});
		return {
			filePath,
			container,
			mime: mimeForContainer(container),
			fileSize: st.size,
			quality: container === "mp3" ? "audio" : "720p"
		};
	}
};
function ytdlpArgs(extra, opts) {
	const { argsPrefix } = resolveYtdlp();
	return [
		...argsPrefix,
		"--no-playlist",
		"--no-warnings",
		"--socket-timeout",
		"20",
		"--retries",
		"2",
		"--fragment-retries",
		"2",
		"--restrict-filenames",
		"--no-mtime",
		...opts?.quiet ? ["--no-progress"] : ["--newline"],
		...extra
	];
}
function parseJsonPayload(stdout) {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start < 0 || end <= start) throw new AppError("EXTRACTION_FAILED");
	try {
		return JSON.parse(stdout.slice(start, end + 1));
	} catch {
		throw new AppError("EXTRACTION_FAILED");
	}
}
async function ytdlpAvailable() {
	try {
		const { command } = resolveYtdlp();
		const result = await runProcess({
			command,
			args: ytdlpArgs(["--version"], { quiet: true }),
			timeoutMs: 1e4
		});
		return result.code === 0 && /20\d{2}/.test(result.stdout + result.stderr);
	} catch {
		return false;
	}
}
async function dumpInfo(url) {
	const { command } = resolveYtdlp();
	const result = await runProcess({
		command,
		args: ytdlpArgs([
			"-J",
			"--skip-download",
			url
		], { quiet: true }),
		timeoutMs: config.analysisTimeoutMs
	});
	if (result.code !== 0) {
		log.warn("yt-dlp analyze failed", {
			url: redactUrl(url),
			stderr: result.stderr.slice(-800)
		});
		throw mapExtractorMessage(result.stderr || result.stdout);
	}
	return parseJsonPayload(result.stdout);
}
function formatsFromInfo(info) {
	const normalized = (info.formats?.length ? info.formats : []).map((f) => normalizeYtdlpFormat(f)).filter((f) => f != null);
	if (normalized.length === 0 && info.format_id) {
		const fallback = normalizeYtdlpFormat({
			format_id: info.format_id,
			ext: info.ext,
			width: info.width,
			height: info.height,
			fps: info.fps,
			vcodec: info.vcodec,
			acodec: info.acodec,
			filesize: info.filesize,
			filesize_approx: info.filesize_approx
		});
		if (fallback) normalized.push(fallback);
	}
	return normalized;
}
function metadataFromInfo(info, url, mp3) {
	const formats = formatsFromInfo(info);
	const thumbnail = info.thumbnail || [...info.thumbnails ?? []].reverse().find((t) => t.url)?.url || null;
	return {
		title: (info.title || extractDomain(url) || "Video").trim(),
		thumbnail,
		duration: typeof info.duration === "number" ? info.duration : null,
		source: extractDomain(info.webpage_url || url),
		extractor: info.extractor || info.extractor_key || "yt-dlp",
		webpageUrl: info.webpage_url || info.original_url || url,
		formats,
		presets: buildPresets(formats, { mp3 }),
		capabilities: {
			mp3,
			merge: mp3
		}
	};
}
var ytdlpExtractor = {
	id: "yt-dlp",
	name: "yt-dlp",
	canHandle(url) {
		return /^https?:\/\//i.test(url);
	},
	async getMetadata(url) {
		const mp3 = await ffmpegAvailable();
		const meta = metadataFromInfo(await dumpInfo(url), url, mp3);
		if (!meta.formats.length && !meta.presets.length) throw new AppError("EXTRACTION_FAILED");
		if (meta.duration && meta.duration > config.maxVideoDuration) throw new AppError("TOO_LONG");
		return meta;
	},
	async getFormats(url) {
		return (await this.getMetadata(url)).formats;
	},
	async download(url, format, ctx) {
		return downloadWithYtdlp(url, format, ctx);
	}
};
async function downloadWithYtdlp(url, format, ctx) {
	const { command } = resolveYtdlp();
	const plan = ytDlpFormatSelector(format.formatId);
	const extra = [
		"-o",
		join(ctx.workDir, "download.%(ext)s"),
		"-f",
		plan.selector,
		"--max-filesize",
		String(config.maxFileSize)
	];
	if (plan.mergeFormat) extra.push("--merge-output-format", plan.mergeFormat);
	if (plan.extractAudio) {
		extra.push("-x");
		if (plan.audioFormat) extra.push("--audio-format", plan.audioFormat, "--audio-quality", "0");
	}
	let lastProgress = 0;
	const result = await runProcess({
		command,
		args: ytdlpArgs([...extra, url]),
		timeoutMs: config.downloadTimeoutMs,
		cwd: ctx.workDir,
		signal: ctx.signal,
		onStdout: (chunk) => handleProgress(chunk, ctx, (v) => {
			lastProgress = v;
		}),
		onStderr: (chunk) => handleProgress(chunk, ctx, (v) => {
			lastProgress = v;
		})
	});
	if (result.code !== 0) {
		log.warn("yt-dlp download failed", {
			url: redactUrl(url),
			stderr: result.stderr.slice(-800)
		});
		throw mapExtractorMessage(result.stderr || result.stdout);
	}
	const filePath = await findDownloadedFile(ctx.workDir);
	const st = await stat(filePath);
	if (st.size > config.maxFileSize) throw new AppError("TOO_LARGE");
	const ext = filePath.split(".").pop()?.toLowerCase() || "mp4";
	ctx.onProgress?.({ progress: lastProgress == null ? 100 : 100 });
	return {
		filePath,
		container: ext,
		mime: mimeForContainer(ext),
		fileSize: st.size,
		quality: plan.heightCap ? `${plan.heightCap}p` : plan.extractAudio ? "audio" : "best"
	};
}
function handleProgress(chunk, ctx, setLast) {
	for (const line of chunk.split(/\r?\n/)) {
		const parsed = parseYtdlpProgress(line);
		if (!parsed) continue;
		if (parsed.progress != null) setLast(parsed.progress);
		const stage = line.includes("[Merger]") ? "merging" : line.includes("[ExtractAudio]") || line.includes("[VideoConvertor]") ? "converting" : "downloading";
		ctx.onProgress?.({
			progress: parsed.progress,
			downloadedBytes: parsed.downloadedBytes,
			totalBytes: parsed.totalBytes,
			speed: parsed.speed,
			eta: parsed.eta,
			stage
		});
	}
}
async function findDownloadedFile(workDir) {
	const entries = await readdir(workDir);
	const files = [];
	for (const name of entries) {
		if (name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".json")) continue;
		const path = join(workDir, name);
		const st = await stat(path);
		if (st.isFile() && st.size > 0) files.push({
			path,
			mtime: st.mtimeMs,
			size: st.size
		});
	}
	files.sort((a, b) => b.mtime - a.mtime);
	if (!files[0]) throw new AppError("PROCESSING_FAILED");
	return files[0].path;
}
var EXTRACTORS = [
	sampleExtractor,
	directExtractor,
	ytdlpExtractor
];
function listExtractors() {
	return EXTRACTORS.map((e) => ({
		id: e.id,
		name: e.name
	}));
}
function getExtractorFor(url) {
	const found = EXTRACTORS.find((extractor) => extractor.canHandle(url));
	if (!found) throw new AppError("UNSUPPORTED_SITE");
	return found;
}
async function analyzeUrl(url) {
	const extractor = getExtractorFor(url);
	try {
		return {
			extractor: extractor.id,
			video: await extractor.getMetadata(url)
		};
	} catch (err) {
		if (extractor.id === "direct") try {
			const fallback = ytdlpExtractor;
			return {
				extractor: fallback.id,
				video: await fallback.getMetadata(url)
			};
		} catch {
			throw err;
		}
		throw err;
	}
}
var UNSAFE = /[^a-zA-Z0-9._-]+/g;
function sanitizeFilename(input, fallback = "video") {
	const cut = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(UNSAFE, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 80);
	const safe = cut.length > 0 ? cut : fallback;
	if (safe === "." || safe === ".." || safe.toLowerCase() === "con") return fallback;
	return safe;
}
function buildDownloadFilename(opts) {
	const base = sanitizeFilename(opts.title, "video");
	const quality = opts.quality ? sanitizeFilename(opts.quality) : "";
	const ext = sanitizeFilename(opts.container.replace(/^\./, ""), "mp4").replace(/-/g, "");
	return `${quality ? `${base}-${quality}` : base}.${ext}`;
}
var initialized = false;
async function ensureTempRoot() {
	if (!initialized) {
		await mkdir(config.tempDirectory, { recursive: true });
		initialized = true;
	}
	return config.tempDirectory;
}
async function createJobDir(jobId) {
	const root = await ensureTempRoot();
	const dir = join(root, "jobs", jobId);
	await mkdir(dir, { recursive: true });
	return dir;
}
async function removeJobDir(workDir) {
	await rm(workDir, {
		recursive: true,
		force: true
	});
}
async function tempUsage() {
	return walkSize(await ensureTempRoot());
}
async function walkSize(dir) {
	let bytes = 0;
	let files = 0;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return {
			bytes: 0,
			files: 0
		};
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			const inner = await walkSize(path);
			bytes += inner.bytes;
			files += inner.files;
		} else if (entry.isFile()) try {
			const st = await stat(path);
			bytes += st.size;
			files += 1;
		} catch {}
	}
	return {
		bytes,
		files
	};
}
var jobs = /* @__PURE__ */ new Map();
function createJobId() {
	return randomBytes(16).toString("hex");
}
function nowMs() {
	return Date.now();
}
function createJob(input) {
	const id = createJobId();
	const createdAt = nowMs();
	const job = {
		id,
		url: input.url,
		formatId: input.formatId,
		ip: input.ip,
		workDir: input.workDir,
		outputPath: null,
		outputMime: null,
		status: "queued",
		progress: 0,
		stageLabel: "Queued",
		downloadedBytes: null,
		totalBytes: null,
		speed: null,
		eta: null,
		error: null,
		errorCode: null,
		filename: null,
		fileSize: null,
		quality: null,
		container: null,
		title: input.title ?? null,
		thumbnail: input.thumbnail ?? null,
		source: input.source ?? null,
		extractor: input.extractor ?? null,
		createdAt,
		updatedAt: createdAt,
		expiresAt: createdAt + config.fileExpirationMinutes * 6e4,
		downloadUrl: null,
		startedAt: null,
		finishedAt: null
	};
	jobs.set(id, job);
	return job;
}
function getJob(id) {
	return jobs.get(id);
}
function listJobs() {
	return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}
function updateJob(id, patch) {
	const current = jobs.get(id);
	if (!current) return void 0;
	const next = {
		...current,
		...patch,
		updatedAt: nowMs()
	};
	jobs.set(id, next);
	return next;
}
function countActive() {
	let n = 0;
	for (const job of jobs.values()) if (job.status !== "ready" && job.status !== "failed") n += 1;
	return n;
}
function countActiveForIp(ip) {
	let n = 0;
	for (const job of jobs.values()) if (job.ip === ip && job.status !== "ready" && job.status !== "failed") n += 1;
	return n;
}
function expiredJobs(at = nowMs()) {
	return [...jobs.values()].filter((job) => job.expiresAt <= at);
}
function deleteJob(id) {
	jobs.delete(id);
}
function averageProcessingMs() {
	const done = [...jobs.values()].filter((j) => j.finishedAt && j.startedAt);
	if (!done.length) return null;
	const total = done.reduce((sum, j) => sum + ((j.finishedAt ?? 0) - (j.startedAt ?? 0)), 0);
	return Math.round(total / done.length);
}
function toPublicJob(job) {
	return {
		jobId: job.id,
		status: job.status,
		progress: job.progress,
		stageLabel: job.stageLabel,
		downloadedBytes: job.downloadedBytes,
		totalBytes: job.totalBytes,
		speed: job.speed,
		eta: job.eta,
		error: job.error,
		errorCode: job.errorCode,
		filename: job.filename,
		fileSize: job.fileSize,
		quality: job.quality,
		container: job.container,
		title: job.title,
		thumbnail: job.thumbnail,
		source: job.source,
		extractor: job.extractor,
		createdAt: job.createdAt,
		updatedAt: job.updatedAt,
		expiresAt: job.expiresAt,
		downloadUrl: job.status === "ready" ? `/api/download/${job.id}/file` : null
	};
}
var STAGE_LABEL = {
	queued: "Waiting in queue",
	analyzing: "Analyzing video...",
	downloading: "Downloading source media",
	processing: "Processing video",
	merging: "Merging audio and video",
	converting: "Converting format",
	ready: "Ready to download",
	failed: "Failed"
};
function labelFor(status, override) {
	if (override) return override;
	return STAGE_LABEL[status] ?? "Working...";
}
async function processJob(jobId) {
	const job = getJob(jobId);
	if (!job) return;
	updateJob(jobId, {
		status: "downloading",
		stageLabel: labelFor("downloading"),
		startedAt: Date.now(),
		progress: 0
	});
	const started = Date.now();
	try {
		const extractor = getExtractorFor(job.url);
		updateJob(jobId, { extractor: extractor.id });
		const result = await extractor.download(job.url, { formatId: job.formatId }, {
			workDir: job.workDir,
			onProgress: (update) => {
				const status = update.stage || "downloading";
				updateJob(jobId, {
					status: status === "merging" || status === "converting" || status === "processing" ? status : "downloading",
					stageLabel: labelFor(status === "merging" || status === "converting" || status === "processing" ? status : "downloading"),
					progress: update.progress,
					downloadedBytes: update.downloadedBytes ?? getJob(jobId)?.downloadedBytes ?? null,
					totalBytes: update.totalBytes ?? getJob(jobId)?.totalBytes ?? null,
					speed: update.speed ?? null,
					eta: update.eta ?? null
				});
			}
		});
		let filePath = result.filePath;
		let container = result.container;
		const wantsMp3 = job.formatId === "preset:mp3";
		const wantsWebm = job.formatId.endsWith("-webm");
		if (wantsMp3 && container !== "mp3") {
			updateJob(jobId, {
				status: "converting",
				stageLabel: labelFor("converting"),
				progress: null
			});
			filePath = await convertMedia({
				inputPath: filePath,
				workDir: job.workDir,
				target: "mp3",
				timeoutMs: config.downloadTimeoutMs
			});
			container = "mp3";
		} else if (wantsWebm && container !== "webm") {
			updateJob(jobId, {
				status: "converting",
				stageLabel: labelFor("converting"),
				progress: null
			});
			filePath = await convertMedia({
				inputPath: filePath,
				workDir: job.workDir,
				target: "webm",
				timeoutMs: config.downloadTimeoutMs
			});
			container = "webm";
		}
		const st = await stat(filePath);
		const quality = result.quality || (job.formatId.startsWith("preset:") ? job.formatId.replace("preset:", "") : null);
		const filename = buildDownloadFilename({
			title: job.title || "video",
			quality,
			container
		});
		updateJob(jobId, {
			status: "ready",
			stageLabel: labelFor("ready"),
			progress: 100,
			outputPath: filePath,
			outputMime: result.mime,
			filename,
			fileSize: st.size,
			quality,
			container,
			finishedAt: Date.now(),
			downloadUrl: `/api/download/${jobId}/file`,
			speed: null,
			eta: 0
		});
		log.info("job complete", {
			jobId,
			domain: job.source,
			extractor: extractor.id,
			stage: "ready",
			durationMs: Date.now() - started,
			outputSize: st.size
		});
	} catch (err) {
		const appErr = err instanceof AppError ? err : new AppError("PROCESSING_FAILED");
		updateJob(jobId, {
			status: "failed",
			stageLabel: labelFor("failed"),
			progress: null,
			error: appErr.message,
			errorCode: appErr.code,
			finishedAt: Date.now()
		});
		log.error("job failed", {
			jobId,
			domain: job.source,
			extractor: job.extractor,
			stage: "failed",
			durationMs: Date.now() - started,
			error: appErr.code,
			url: redactUrl(job.url)
		});
		try {
			await removeJobDir(job.workDir);
		} catch {}
	}
}
var queue = [];
var running = 0;
var cleanupTimer = null;
function ensureCleanup() {
	if (cleanupTimer) return;
	cleanupTimer = setInterval(() => {
		cleanupExpired();
	}, 6e4);
	cleanupTimer.unref?.();
}
async function cleanupExpired() {
	const expired = expiredJobs();
	for (const job of expired) {
		try {
			await removeJobDir(job.workDir);
		} catch {}
		deleteJob(job.id);
	}
	return expired.length;
}
function pump() {
	while (running < config.maxConcurrentDownloads && queue.length > 0) {
		const id = queue.shift();
		if (!id) break;
		running += 1;
		processJob(id).catch(() => void 0).finally(() => {
			running -= 1;
			pump();
		});
	}
}
async function analyzeVideo(url) {
	ensureCleanup();
	log.info("analyze start", { url: redactUrl(url) });
	const started = Date.now();
	const result = await analyzeUrl(url);
	log.info("analyze complete", {
		url: redactUrl(url),
		extractor: result.extractor,
		domain: result.video.source,
		durationMs: Date.now() - started,
		formats: result.video.formats.length
	});
	if (result.video.duration && result.video.duration > config.maxVideoDuration) throw new AppError("TOO_LONG");
	const oversized = result.video.formats.every((f) => f.fileSize && f.fileSize > config.maxFileSize);
	if (result.video.formats.length && oversized) throw new AppError("TOO_LARGE");
	return result.video;
}
async function enqueueDownload(input) {
	ensureCleanup();
	if (countActive() >= config.maxConcurrentDownloads + 8) throw new AppError("SERVER_OVERLOAD");
	if (countActiveForIp(input.ip) >= config.maxConcurrentPerIp) throw new AppError("SERVER_OVERLOAD");
	let metaTitle = input.title ?? null;
	let metaThumb = input.thumbnail ?? null;
	let metaSource = input.source ?? null;
	let extractorId = null;
	try {
		const analyzed = await analyzeUrl(input.url);
		const video = analyzed.video;
		extractorId = analyzed.extractor;
		metaTitle = metaTitle || video.title;
		metaThumb = metaThumb || video.thumbnail;
		metaSource = metaSource || video.source;
		if (!(video.presets.some((p) => p.id === input.formatId) || video.formats.some((f) => f.id === input.formatId))) throw new AppError("FORMAT_UNAVAILABLE");
		if (video.duration && video.duration > config.maxVideoDuration) throw new AppError("TOO_LONG");
	} catch (err) {
		if (err instanceof AppError) throw err;
		throw new AppError("ANALYSIS_FAILED");
	}
	const job = createJob({
		url: input.url,
		formatId: input.formatId,
		ip: input.ip,
		workDir: "/tmp",
		title: metaTitle,
		thumbnail: metaThumb,
		source: metaSource,
		extractor: extractorId
	});
	const workDir = await createJobDir(job.id);
	updateJob(job.id, { workDir });
	queue.push(job.id);
	log.info("job queued", {
		jobId: job.id,
		domain: metaSource,
		extractor: extractorId,
		stage: "queued"
	});
	pump();
	return toPublicJob(getJob(job.id));
}
function getPublicJob(id) {
	const job = getJob(id);
	if (!job) return null;
	if (job.expiresAt <= Date.now()) return null;
	return toPublicJob(job);
}
function getJobOrThrow(id) {
	const job = getJob(id);
	if (!job) throw new AppError("NOT_FOUND");
	if (job.expiresAt <= Date.now()) throw new AppError("EXPIRED");
	return job;
}
async function healthSnapshot() {
	const [ffmpeg, extractor, disk] = await Promise.all([
		ffmpegAvailable(),
		ytdlpAvailable(),
		tempUsage()
	]);
	return {
		status: ffmpeg || extractor ? "ok" : "degraded",
		ffmpeg,
		extractor,
		activeJobs: countActive(),
		queuedJobs: queue.length,
		tempBytes: disk.bytes
	};
}
async function diagnosticsSnapshot() {
	const jobs = listJobs();
	const disk = await tempUsage();
	const grouped = {
		queued: jobs.filter((j) => j.status === "queued").length,
		active: jobs.filter((j) => ![
			"queued",
			"ready",
			"failed"
		].includes(j.status)).length,
		completed: jobs.filter((j) => j.status === "ready").length,
		failed: jobs.filter((j) => j.status === "failed").length
	};
	return {
		jobs: jobs.slice(0, 50).map((j) => ({
			id: j.id,
			status: j.status,
			source: j.source,
			extractor: j.extractor,
			quality: j.quality,
			createdAt: j.createdAt,
			updatedAt: j.updatedAt,
			fileSize: j.fileSize,
			error: j.error
		})),
		counts: grouped,
		disk,
		averageProcessingMs: averageProcessingMs(),
		worker: {
			running,
			queue: queue.length,
			maxConcurrent: config.maxConcurrentDownloads
		},
		limits: {
			maxFileSize: config.maxFileSize,
			maxVideoDuration: config.maxVideoDuration,
			expirationMinutes: config.fileExpirationMinutes
		}
	};
}
var Route$6 = createFileRoute("/api/analyze")({ server: { handlers: { POST: async ({ request }) => {
	try {
		if (!consumeRateLimit(`analyze:${clientIp()}`, config.rateLimitPerMinute)) throw new AppError("RATE_LIMITED");
		const body = await request.json().catch(() => null);
		const video = await analyzeVideo((await assertSafeUrl(typeof body?.url === "string" ? body.url : "")).url);
		return Response.json({
			success: true,
			video
		});
	} catch (err) {
		return jsonError(err instanceof Error ? err : /* @__PURE__ */ new Error("analyze"), "ANALYSIS_FAILED");
	}
} } } });
function allowed(request) {
	if (!isProd()) return true;
	const token = config.diagnosticsToken;
	if (!token) return false;
	return request.headers.get("x-diagnostics-token") === token;
}
var Route$5 = createFileRoute("/api/diagnostics")({ server: { handlers: { GET: async ({ request }) => {
	try {
		if (!allowed(request)) throw new AppError("FORBIDDEN");
		const data = await diagnosticsSnapshot();
		return Response.json(data);
	} catch (err) {
		return jsonError(err instanceof Error ? err : /* @__PURE__ */ new Error("diagnostics"), "FORBIDDEN");
	}
} } } });
var Route$4 = createFileRoute("/api/download")({ server: { handlers: { POST: async ({ request }) => {
	try {
		const ip = clientIp();
		if (!consumeRateLimit(`download:${ip}`, Math.max(8, Math.floor(config.rateLimitPerMinute / 2)))) throw new AppError("RATE_LIMITED");
		const body = await request.json().catch(() => null);
		const url = typeof body?.url === "string" ? body.url : "";
		const formatId = typeof body?.formatId === "string" ? body.formatId : "";
		if (!formatId) throw new AppError("FORMAT_UNAVAILABLE");
		const job = await enqueueDownload({
			url: (await assertSafeUrl(url)).url,
			formatId,
			ip,
			title: typeof body?.title === "string" ? body.title : null,
			thumbnail: typeof body?.thumbnail === "string" ? body.thumbnail : null,
			source: typeof body?.source === "string" ? body.source : null
		});
		return Response.json(job);
	} catch (err) {
		return jsonError(err instanceof Error ? err : /* @__PURE__ */ new Error("download"), "PROCESSING_FAILED");
	}
} } } });
var Route$3 = createFileRoute("/api/health")({ server: { handlers: { GET: async () => {
	const health = await healthSnapshot();
	const status = health.status === "ok" ? 200 : 503;
	return Response.json(health, { status });
} } } });
var SITE_CATALOG = [
	{
		id: "direct",
		name: "Direct media files",
		domain: "direct file URLs",
		category: "direct",
		status: "supported",
		notes: "MP4, WebM, MKV, MOV, M4A, MP3 and similar direct file links."
	},
	{
		id: "archive",
		name: "Internet Archive",
		domain: "archive.org",
		category: "video",
		status: "supported"
	},
	{
		id: "youtube",
		name: "YouTube",
		domain: "youtube.com",
		category: "video",
		status: "limited",
		notes: "May require additional verification depending on the source."
	},
	{
		id: "vimeo",
		name: "Vimeo",
		domain: "vimeo.com",
		category: "video",
		status: "limited",
		notes: "Some videos require a signed-in session."
	},
	{
		id: "dailymotion",
		name: "Dailymotion",
		domain: "dailymotion.com",
		category: "video",
		status: "limited"
	},
	{
		id: "twitch",
		name: "Twitch",
		domain: "twitch.tv",
		category: "video",
		status: "limited",
		notes: "VODs and clips when publicly available."
	},
	{
		id: "x",
		name: "X",
		domain: "x.com",
		category: "social",
		status: "limited"
	},
	{
		id: "reddit",
		name: "Reddit",
		domain: "reddit.com",
		category: "social",
		status: "limited"
	},
	{
		id: "tiktok",
		name: "TikTok",
		domain: "tiktok.com",
		category: "social",
		status: "limited"
	},
	{
		id: "facebook",
		name: "Facebook",
		domain: "facebook.com",
		category: "social",
		status: "limited"
	},
	{
		id: "instagram",
		name: "Instagram",
		domain: "instagram.com",
		category: "social",
		status: "limited"
	},
	{
		id: "soundcloud",
		name: "SoundCloud",
		domain: "soundcloud.com",
		category: "other",
		status: "limited"
	},
	{
		id: "bandcamp",
		name: "Bandcamp",
		domain: "bandcamp.com",
		category: "other",
		status: "limited"
	},
	{
		id: "bbc",
		name: "BBC",
		domain: "bbc.co.uk",
		category: "news",
		status: "limited"
	},
	{
		id: "cnn",
		name: "CNN",
		domain: "cnn.com",
		category: "news",
		status: "limited"
	}
];
var CATEGORY_LABELS = {
	video: "Video platforms",
	social: "Social",
	news: "News & media",
	direct: "Direct files",
	other: "Other sources"
};
var Route$2 = createFileRoute("/api/sites")({ server: { handlers: { GET: async () => {
	const [ytdlp, ffmpeg] = await Promise.all([ytdlpAvailable(), ffmpegAvailable()]);
	return Response.json({
		extractors: listExtractors(),
		ytdlp,
		ffmpeg,
		sites: SITE_CATALOG,
		note: "Support depends on each website’s delivery method and can change without notice. Direct media files and publicly accessible archive sources are the most reliable."
	});
} } } });
var Route$1 = createFileRoute("/api/download/$jobId/file")({ server: { handlers: { GET: async ({ params }) => {
	try {
		const job = getJobOrThrow(params.jobId);
		if (job.status !== "ready" || !job.outputPath) throw new AppError("NOT_FOUND");
		const fileStat = await stat(job.outputPath);
		const stream = Readable.toWeb(createReadStream(job.outputPath));
		const filename = (job.filename || "video.bin").replace(/"/g, "");
		return new Response(stream, { headers: {
			"Content-Type": job.outputMime || "application/octet-stream",
			"Content-Length": String(fileStat.size),
			"Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
			"Cache-Control": "no-store"
		} });
	} catch (err) {
		return jsonError(err instanceof Error ? err : /* @__PURE__ */ new Error("file"), "NOT_FOUND");
	}
} } } });
var Route = createFileRoute("/api/download/$jobId/status")({ server: { handlers: { GET: async ({ params }) => {
	try {
		const job = getPublicJob(params.jobId);
		if (!job) throw new AppError("NOT_FOUND");
		return Response.json(job);
	} catch (err) {
		return jsonError(err instanceof Error ? err : /* @__PURE__ */ new Error("status"), "NOT_FOUND");
	}
} } } });
var IndexRoute = Route$10.update({
	id: "/",
	path: "/",
	getParentRoute: () => Route$11
});
var DiagnosticsRoute = Route$9.update({
	id: "/diagnostics",
	path: "/diagnostics",
	getParentRoute: () => Route$11
});
var FaqRoute = Route$8.update({
	id: "/faq",
	path: "/faq",
	getParentRoute: () => Route$11
});
var SupportedSitesRoute = Route$7.update({
	id: "/supported-sites",
	path: "/supported-sites",
	getParentRoute: () => Route$11
});
var ApiAnalyzeRoute = Route$6.update({
	id: "/api/analyze",
	path: "/api/analyze",
	getParentRoute: () => Route$11
});
var ApiDiagnosticsRoute = Route$5.update({
	id: "/api/diagnostics",
	path: "/api/diagnostics",
	getParentRoute: () => Route$11
});
var ApiDownloadRoute = Route$4.update({
	id: "/api/download",
	path: "/api/download",
	getParentRoute: () => Route$11
});
var ApiHealthRoute = Route$3.update({
	id: "/api/health",
	path: "/api/health",
	getParentRoute: () => Route$11
});
var ApiSitesRoute = Route$2.update({
	id: "/api/sites",
	path: "/api/sites",
	getParentRoute: () => Route$11
});
var ApiDownloadRouteChildren = {
	ApiDownloadJobIdFileRoute: Route$1.update({
		id: "/$jobId/file",
		path: "/$jobId/file",
		getParentRoute: () => ApiDownloadRoute
	}),
	ApiDownloadJobIdStatusRoute: Route.update({
		id: "/$jobId/status",
		path: "/$jobId/status",
		getParentRoute: () => ApiDownloadRoute
	})
};
var rootRouteChildren = {
	IndexRoute,
	DiagnosticsRoute,
	FaqRoute,
	SupportedSitesRoute,
	ApiAnalyzeRoute,
	ApiDiagnosticsRoute,
	ApiDownloadRoute: ApiDownloadRoute._addFileChildren(ApiDownloadRouteChildren),
	ApiHealthRoute,
	ApiSitesRoute
};
var routeTree = Route$11._addFileChildren(rootRouteChildren)._addFileTypes();
var router_exports = /* @__PURE__ */ __exportAll({ getRouter: () => getRouter });
function getRouter() {
	return createRouter({
		routeTree,
		defaultErrorComponent: AppErrorComponent,
		scrollRestoration: true
	});
}
//#endregion
export { validatePublicHttpUrl as a, formatBytes as c, formatSpeed as d, extractDomain as i, formatDuration as l, CATEGORY_LABELS as n, Button as o, SITE_CATALOG as r, cn as s, router_exports as t, formatEta as u };
