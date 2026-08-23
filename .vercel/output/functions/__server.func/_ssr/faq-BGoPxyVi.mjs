import { a as Trigger2, i as Root2, n as Header, r as Item, t as Content2, y as require_jsx_runtime } from "../_libs/@radix-ui/react-accordion+[...].mjs";
import { u as ChevronDown } from "../_libs/lucide-react.mjs";
import { s as cn } from "./router-KTtJilPJ.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/faq-BGoPxyVi.js
var import_jsx_runtime = require_jsx_runtime();
var Accordion = Root2;
function AccordionItem({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Item, {
		className: cn("border-b border-border", className),
		...props
	});
}
function AccordionTrigger({ className, children, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Header, {
		className: "flex",
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Trigger2, {
			className: cn("flex flex-1 items-center justify-between gap-4 py-5 text-left text-base font-medium transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180", className),
			...props,
			children: [children, /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronDown, { className: "size-4 shrink-0 text-muted-foreground transition-transform duration-200" })]
		})
	});
}
function AccordionContent({ className, children, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Content2, {
		className: "overflow-hidden text-sm text-muted-foreground data-[state=closed]:animate-none",
		...props,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: cn("pb-5", className),
			children
		})
	});
}
var FAQS = [
	{
		q: "How do I download a video?",
		a: "Paste the video URL, analyze it, select the desired quality, and click Download. When processing finishes, save the file to your device."
	},
	{
		q: "Why isn't a website working?",
		a: "The website may use a delivery method that the current extractor does not support, or it may require a signed-in session. Direct media file links are the most reliable option."
	},
	{
		q: "What formats are available?",
		a: "Available formats depend on the source. Common outputs include MP4, WebM, and audio-only formats. MP3 conversion is offered when media processing is available."
	},
	{
		q: "How long are files stored?",
		a: "Generated files are temporary and automatically deleted after the configured expiration period, typically around 45 minutes."
	},
	{
		q: "Why are video and audio processed separately?",
		a: "Some websites provide video and audio as separate streams. The application combines them automatically before offering the download."
	},
	{
		q: "Can I download any video on the internet?",
		a: "Only download videos you have the right to save. Respect copyright and the terms of each website. VideoFetch does not bypass paid, private, or DRM-protected content."
	}
];
function FaqPage() {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-16",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", {
				className: "font-display text-4xl tracking-tight",
				children: "FAQ"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
				className: "mt-3 text-muted-foreground",
				children: "Straightforward answers about how VideoFetch works."
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Accordion, {
				type: "single",
				collapsible: true,
				className: "mt-8",
				children: FAQS.map((item, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(AccordionItem, {
					value: `item-${index}`,
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AccordionTrigger, { children: item.q }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AccordionContent, { children: item.a })]
				}, item.q))
			})
		]
	});
}
//#endregion
export { FaqPage as component };
