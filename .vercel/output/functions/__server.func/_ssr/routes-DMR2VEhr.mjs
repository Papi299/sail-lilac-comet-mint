import { i as __toESM } from "../_runtime.mjs";
import { u as require_react } from "../_libs/@floating-ui/react-dom+[...].mjs";
import { y as require_jsx_runtime } from "../_libs/@radix-ui/react-accordion+[...].mjs";
import { n as Card, r as CardContent, t as Badge } from "./badge-ChXm3OgM.mjs";
import { a as LoaderCircle, c as Clock, d as Check, l as ClipboardPaste, o as Globe, s as Download, t as X, u as ChevronDown } from "../_libs/lucide-react.mjs";
import { a as SelectItemIndicator, c as SelectTrigger$1, i as SelectItem$1, l as SelectValue$1, n as SelectContent$1, o as SelectItemText, r as SelectIcon, s as SelectPortal, t as Select$1, u as SelectViewport } from "../_libs/@radix-ui/react-select+[...].mjs";
import { n as toast } from "../_libs/sonner.mjs";
import { a as validatePublicHttpUrl, c as formatBytes, d as formatSpeed, i as extractDomain, l as formatDuration, o as Button, s as cn, u as formatEta } from "./router-KTtJilPJ.mjs";
import { n as SwitchThumb, t as Switch$1 } from "../_libs/radix-ui__react-switch.mjs";
import { n as Root, t as Indicator } from "../_libs/radix-ui__react-progress.mjs";
//#region node_modules/.nitro/vite/services/ssr/assets/routes-DMR2VEhr.js
var import_react = /* @__PURE__ */ __toESM(require_react());
var import_jsx_runtime = require_jsx_runtime();
function Input({ className, type, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", {
		type,
		className: cn("flex h-12 w-full rounded-lg border border-input bg-card px-4 text-base text-foreground shadow-[var(--shadow-border)] outline-none transition-[box-shadow,border-color] duration-150 placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className),
		...props
	});
}
var SAMPLE_VIDEO_URL = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
async function readError(res) {
	try {
		return (await res.json()).error?.message || "Something went wrong.";
	} catch {
		return "Something went wrong.";
	}
}
async function analyzeVideo(url) {
	const res = await fetch("/api/analyze", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ url })
	});
	if (!res.ok) throw new Error(await readError(res));
	const data = await res.json();
	if (!data.success) throw new Error("We couldn't analyze this video.");
	return data.video;
}
async function startDownload(input) {
	const res = await fetch("/api/download", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input)
	});
	if (!res.ok) throw new Error(await readError(res));
	return await res.json();
}
async function getJobStatus(jobId) {
	const res = await fetch(`/api/download/${jobId}/status`);
	if (!res.ok) throw new Error(await readError(res));
	return await res.json();
}
var HISTORY_KEY = "videofetch:history";
var RECENT_KEY = "videofetch:recent-urls";
function loadHistory() {
	try {
		const raw = localStorage.getItem(HISTORY_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.slice(0, 8) : [];
	} catch {
		return [];
	}
}
function saveHistoryItem(item) {
	const next = [item, ...loadHistory().filter((h) => h.jobId !== item.jobId)].slice(0, 8);
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
	} catch {}
}
function loadRecentUrls() {
	try {
		const raw = sessionStorage.getItem(RECENT_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
	} catch {
		return [];
	}
}
function rememberUrl(url) {
	const next = [url, ...loadRecentUrls().filter((u) => u !== url)].slice(0, 5);
	try {
		sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {}
}
function UrlInput({ value, onChange, onSubmit, loading, disabled }) {
	const [error, setError] = (0, import_react.useState)(null);
	const [recent, setRecent] = (0, import_react.useState)([]);
	const [focused, setFocused] = (0, import_react.useState)(false);
	(0, import_react.useEffect)(() => {
		setRecent(loadRecentUrls());
	}, []);
	const detected = (0, import_react.useMemo)(() => {
		const check = validatePublicHttpUrl(value);
		if (!check.ok) return null;
		return extractDomain(check.url) || null;
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
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-3",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "rounded-2xl bg-card p-2 shadow-[var(--shadow-border)] sm:p-2.5",
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex flex-col gap-2 sm:flex-row sm:items-center",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "relative min-w-0 flex-1",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Input, {
							value,
							onChange: (e) => {
								onChange(e.target.value);
								if (error) setError(null);
							},
							onFocus: () => setFocused(true),
							onBlur: () => setTimeout(() => setFocused(false), 150),
							onKeyDown: (e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									submit();
								}
							},
							placeholder: "Paste a video link here...",
							inputMode: "url",
							autoComplete: "off",
							spellCheck: false,
							"aria-label": "Video URL",
							disabled: loading || disabled,
							className: "h-12 border-0 bg-transparent pr-20 shadow-none focus-visible:ring-0"
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1",
							children: value ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								className: "flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted",
								"aria-label": "Clear URL",
								onClick: () => onChange(""),
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { className: "size-4" })
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								className: "flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted",
								"aria-label": "Paste from clipboard",
								onClick: () => void paste(),
								children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ClipboardPaste, { className: "size-4" })
							})
						})]
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
						size: "lg",
						className: "h-12 w-full shrink-0 sm:w-auto",
						onClick: submit,
						disabled: loading || disabled,
						children: loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "size-4 animate-spin" }), "Analyzing..."] }) : "Analyze Video"
					})]
				})
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex min-h-6 flex-wrap items-center justify-between gap-2 px-1",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-destructive",
						children: error
					}) : detected ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: ["Detected: ", detected] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "hidden sm:inline",
						children: "Works with direct media files and many public video pages."
					})
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					className: "text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline",
					onClick: () => {
						onChange(SAMPLE_VIDEO_URL);
						setError(null);
						onSubmit(SAMPLE_VIDEO_URL);
					},
					children: "Try a sample clip"
				})]
			}),
			focused && recent.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "rounded-xl bg-card px-3 py-2 shadow-[var(--shadow-border)]",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "px-1 pb-1 text-xs text-muted-foreground",
					children: "Recent"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", { children: recent.map((url) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
					type: "button",
					className: "w-full truncate rounded-md px-2 py-2 text-left text-sm hover:bg-muted",
					onMouseDown: (e) => e.preventDefault(),
					onClick: () => onChange(url),
					children: url
				}) }, url)) })]
			}) : null
		]
	});
}
function VideoCard({ video }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "flex flex-col gap-4 sm:flex-row",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
			className: "aspect-video w-full overflow-hidden rounded-lg bg-muted sm:w-56 sm:shrink-0",
			children: video.thumbnail ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
				src: video.thumbnail,
				alt: "",
				className: "size-full object-cover",
				referrerPolicy: "no-referrer",
				crossOrigin: "anonymous"
			}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "flex size-full items-center justify-center text-sm text-muted-foreground",
				children: "No thumbnail"
			})
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
			className: "min-w-0 flex-1 space-y-3",
			children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
				className: "text-lg font-medium leading-snug tracking-tight sm:text-xl",
				children: video.title
			}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-wrap items-center gap-2 text-sm text-muted-foreground",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
					variant: "muted",
					className: "gap-1",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Globe, { className: "size-3" }), video.source]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Badge, {
					variant: "muted",
					className: "gap-1",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Clock, { className: "size-3" }), formatDuration(video.duration)]
				})]
			})]
		})]
	});
}
function Label({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", {
		className: cn("text-sm font-medium text-foreground", className),
		...props
	});
}
var Select = Select$1;
var SelectValue = SelectValue$1;
function SelectTrigger({ className, children, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SelectTrigger$1, {
		className: cn("flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-input bg-card px-3 text-sm outline-none transition-[box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className),
		...props,
		children: [children, /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectIcon, {
			asChild: true,
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronDown, { className: "size-4 opacity-60" })
		})]
	});
}
function SelectContent({ className, children, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectPortal, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectContent$1, {
		className: cn("z-50 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[var(--shadow-border)]", className),
		position: "popper",
		sideOffset: 6,
		...props,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectViewport, {
			className: "p-1",
			children
		})
	}) });
}
function SelectItem({ className, children, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SelectItem$1, {
		className: cn("relative flex cursor-pointer items-center rounded-md py-2 pr-8 pl-3 text-sm outline-none data-highlighted:bg-muted", className),
		...props,
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectItemText, { children }), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectItemIndicator, {
			className: "absolute right-2",
			children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "size-4" })
		})]
	});
}
function Switch({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Switch$1, {
		className: cn("peer inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-border bg-muted transition-colors data-[state=checked]:bg-primary", className),
		...props,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SwitchThumb, { className: "pointer-events-none block size-5 translate-x-0.5 rounded-full bg-card shadow-sm transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-foreground" })
	});
}
function FormatSelector({ video, simpleMode, onSimpleMode, selectedId, onSelect, onDownload, downloading }) {
	const selectedPreset = video.presets.find((p) => p.id === selectedId);
	const selectedFormat = video.formats.find((f) => f.id === selectedId);
	const size = selectedPreset?.fileSize ?? selectedFormat?.fileSize ?? null;
	const container = selectedPreset?.container ?? selectedFormat?.container ?? "mp4";
	const codec = selectedPreset?.videoCodec ?? selectedFormat?.videoCodec;
	const audio = selectedPreset?.audioCodec ?? selectedFormat?.audioCodec;
	const advancedGroups = (0, import_react.useMemo)(() => groupAdvanced(video), [video]);
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-5",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-center justify-between gap-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: "Choose quality and format"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", {
					className: "flex items-center gap-2 text-sm",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-muted-foreground",
						children: "Advanced"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Switch, {
						checked: !simpleMode,
						onCheckedChange: (v) => onSimpleMode(!v)
					})]
				})]
			}),
			simpleMode ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "grid gap-4 sm:grid-cols-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Label, {
						htmlFor: "quality",
						children: "Quality"
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Select, {
						value: selectedId,
						onValueChange: onSelect,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectTrigger, {
							id: "quality",
							className: "w-full",
							children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectValue, { placeholder: "Select quality" })
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectContent, { children: video.presets.map((preset) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SelectItem, {
							value: preset.id,
							children: [preset.label, preset.fileSize ? ` · ${formatBytes(preset.fileSize)}` : ""]
						}, preset.id)) })]
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "space-y-2",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Label, { children: "Format" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "flex h-11 items-center rounded-lg border border-input bg-card px-3 text-sm",
						children: [
							container.toUpperCase(),
							codec ? ` · ${codec}` : "",
							audio ? ` / ${audio}` : ""
						]
					})]
				})]
			}) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Label, {
					htmlFor: "advanced",
					children: "Source format"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Select, {
					value: selectedId,
					onValueChange: onSelect,
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectTrigger, {
						id: "advanced",
						className: "w-full",
						children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectValue, { placeholder: "Select format" })
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SelectContent, { children: [video.presets.filter((p) => p.id === "preset:best" || p.id === "preset:mp3").map((preset) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectItem, {
						value: preset.id,
						children: preset.label
					}, preset.id)), advancedGroups.map((group) => group.formats.map((format) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(SelectItem, {
						value: format.id,
						children: [
							group.label,
							" · ",
							format.container.toUpperCase(),
							format.fps ? ` ${Math.round(format.fps)}fps` : "",
							format.videoCodec ? ` · ${format.videoCodec}` : "",
							format.audioCodec ? ` / ${format.audioCodec}` : "",
							format.hasVideo && !format.hasAudio ? " · video only" : "",
							format.fileSize ? ` · ${formatBytes(format.fileSize)}` : ""
						]
					}, format.id)))] })]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "text-sm text-muted-foreground",
					children: ["Estimated size: ", /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						className: "text-foreground",
						children: formatBytes(size)
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
					className: "w-full sm:w-auto",
					onClick: onDownload,
					disabled: downloading || !selectedId,
					children: downloading ? "Starting..." : "Download"
				})]
			})
		]
	});
}
function groupAdvanced(video) {
	const order = [
		"2160p",
		"1440p",
		"1080p",
		"720p",
		"480p",
		"360p",
		"240p",
		"144p",
		"audio",
		"unknown"
	];
	const groups = [];
	for (const key of order) {
		const formats = video.formats.filter((f) => f.resolution === key);
		if (formats.length) groups.push({
			label: key === "audio" ? "Audio" : key,
			formats
		});
	}
	return groups;
}
function Progress({ className, value, indeterminate, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Root, {
		className: cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className),
		value: indeterminate ? void 0 : value,
		...props,
		children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Indicator, {
			className: cn("h-full bg-primary transition-transform duration-150 ease-out", indeterminate && "w-1/3 animate-pulse"),
			style: indeterminate ? { transform: "translateX(50%)" } : { transform: `translateX(-${100 - (value || 0)}%)` }
		})
	});
}
function ProgressCard({ job }) {
	const indeterminate = job.progress == null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-5",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start gap-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoaderCircle, { className: "mt-0.5 size-5 animate-spin text-muted-foreground" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-lg font-medium tracking-tight",
					children: "Preparing your video"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: job.stageLabel
				})] })]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "space-y-2",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Progress, {
					value: job.progress ?? 0,
					indeterminate
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "flex items-center justify-between text-sm tabular-nums text-muted-foreground",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: indeterminate ? "Working" : `${Math.round(job.progress ?? 0)}%` }), job.eta != null && job.eta > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [formatEta(job.eta), " remaining"] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {})]
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "grid grid-cols-2 gap-3 text-sm sm:grid-cols-3",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meta, {
						label: "Transferred",
						value: job.downloadedBytes != null ? `${formatBytes(job.downloadedBytes)}${job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ""}` : "—"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meta, {
						label: "Speed",
						value: formatSpeed(job.speed)
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Meta, {
						label: "Status",
						value: job.status
					})
				]
			})
		]
	});
}
function Meta({ label, value }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
		className: "text-xs text-muted-foreground",
		children: label
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
		className: "mt-1 font-medium tabular-nums",
		children: value
	})] });
}
function CompleteCard({ job, onReset }) {
	const href = job.downloadUrl || "#";
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "space-y-6",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex items-start gap-3",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
					className: "mt-0.5 flex size-8 items-center justify-center rounded-full bg-success/15 text-success",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { className: "size-4" })
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
					className: "text-lg font-medium tracking-tight",
					children: "Your video is ready"
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
					className: "text-sm text-muted-foreground",
					children: "The file will expire automatically after a short period."
				})] })]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("dl", {
				className: "grid gap-3 text-sm sm:grid-cols-2",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, {
						label: "Filename",
						value: job.filename || "video"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, {
						label: "Quality",
						value: job.quality || "—"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, {
						label: "Format",
						value: job.container ? job.container.toUpperCase() : "—"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Row, {
						label: "File size",
						value: formatBytes(job.fileSize)
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "flex flex-col gap-2 sm:flex-row",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
					asChild: true,
					className: "w-full sm:w-auto",
					children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("a", {
						href,
						download: job.filename ?? void 0,
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Download, { className: "size-4" }), "Download File"]
					})
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, {
					variant: "outline",
					className: "w-full sm:w-auto",
					onClick: onReset,
					children: "Download Another Video"
				})]
			})
		]
	});
}
function Row({ label, value }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("dt", {
		className: "text-xs text-muted-foreground",
		children: label
	}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("dd", {
		className: "mt-1 break-all font-medium",
		children: value
	})] });
}
function DownloadHistory({ items }) {
	if (!items.length) return null;
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
		className: "space-y-4",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
			className: "text-sm font-medium text-muted-foreground",
			children: "Recent in this browser"
		}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("ul", {
			className: "space-y-2",
			children: items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", {
				className: "flex items-center gap-3 rounded-xl bg-card p-3 shadow-[var(--shadow-border)]",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "size-12 overflow-hidden rounded-md bg-muted",
						children: item.thumbnail ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", {
							src: item.thumbnail,
							alt: "",
							className: "size-full object-cover",
							referrerPolicy: "no-referrer"
						}) : null
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "min-w-0 flex-1",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "truncate text-sm font-medium",
							children: item.title
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "text-xs text-muted-foreground",
							children: [item.quality, item.format].filter(Boolean).join(" · ") || "Processed"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, {
						variant: item.status === "ready" ? "success" : item.status === "failed" ? "outline" : "muted",
						children: item.status
					})
				]
			}, item.jobId))
		})]
	});
}
function Skeleton({ className, ...props }) {
	return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
		className: cn("animate-pulse rounded-md bg-muted", className),
		...props
	});
}
function Home() {
	const [url, setUrl] = (0, import_react.useState)("");
	const [phase, setPhase] = (0, import_react.useState)("idle");
	const [video, setVideo] = (0, import_react.useState)(null);
	const [simpleMode, setSimpleMode] = (0, import_react.useState)(true);
	const [selectedId, setSelectedId] = (0, import_react.useState)("");
	const [job, setJob] = (0, import_react.useState)(null);
	const [error, setError] = (0, import_react.useState)(null);
	const [history, setHistory] = (0, import_react.useState)([]);
	const [starting, setStarting] = (0, import_react.useState)(false);
	(0, import_react.useEffect)(() => {
		setHistory(loadHistory());
	}, []);
	(0, import_react.useEffect)(() => {
		if (phase !== "processing" || !job || !("jobId" in job) || !job.jobId) return;
		const jobId = job.jobId;
		let cancelled = false;
		const timer = window.setInterval(() => {
			getJobStatus(jobId).then((next) => {
				if (cancelled) return;
				setJob(next);
				if (next.status === "ready") {
					setPhase("complete");
					saveHistoryItem({
						jobId,
						title: next.title || video?.title || "Video",
						thumbnail: next.thumbnail || video?.thumbnail || null,
						status: "ready",
						format: next.container,
						quality: next.quality,
						completedAt: Date.now()
					});
					setHistory(loadHistory());
				} else if (next.status === "failed") {
					setPhase("error");
					setError(next.error || "We couldn't process this video. Try another format or source.");
					saveHistoryItem({
						jobId,
						title: next.title || video?.title || "Video",
						thumbnail: next.thumbnail || video?.thumbnail || null,
						status: "failed",
						format: next.container,
						quality: next.quality,
						completedAt: Date.now()
					});
					setHistory(loadHistory());
				}
			}).catch((err) => {
				if (cancelled) return;
				setPhase("error");
				setError(err.message);
			});
		}, 800);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [
		phase,
		job,
		video
	]);
	async function handleAnalyze(nextUrl) {
		setUrl(nextUrl);
		setPhase("analyzing");
		setError(null);
		setJob(null);
		setVideo(null);
		rememberUrl(nextUrl);
		try {
			const result = await analyzeVideo(nextUrl);
			setVideo(result);
			setSelectedId(result.presets[0]?.id || result.formats[0]?.id || "");
			setPhase("ready");
		} catch (err) {
			setPhase("error");
			setError(err instanceof Error ? err.message : "We couldn't analyze this video.");
			toast.error(err instanceof Error ? err.message : "We couldn't analyze this video.");
		}
	}
	async function handleDownload() {
		if (!video || !selectedId) return;
		setStarting(true);
		setError(null);
		try {
			const created = await startDownload({
				url: video.webpageUrl || url,
				formatId: selectedId,
				title: video.title,
				thumbnail: video.thumbnail,
				source: video.source
			});
			setJob(created);
			setPhase("processing");
		} catch (err) {
			const message = err instanceof Error ? err.message : "We couldn't process this video.";
			setError(message);
			toast.error(message);
		} finally {
			setStarting(false);
		}
	}
	function reset() {
		setPhase("idle");
		setVideo(null);
		setJob(null);
		setError(null);
		setSelectedId("");
	}
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "mx-auto w-full max-w-3xl px-4 py-12 sm:px-6 sm:py-20",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", {
				className: "mb-10 space-y-4 text-center sm:mb-14",
				children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "text-sm font-medium tracking-wide text-muted-foreground",
						children: "VideoFetch"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h1", {
						className: "font-display text-4xl leading-tight tracking-tight sm:text-5xl",
						children: ["Download videos", /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
							className: "mt-1 block italic text-muted-foreground",
							children: "in the format you want"
						})]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
						className: "mx-auto max-w-lg text-base text-muted-foreground",
						children: "Paste a video link, choose your quality, and download."
					})
				]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)(UrlInput, {
				value: url,
				onChange: setUrl,
				onSubmit: (next) => void handleAnalyze(next),
				loading: phase === "analyzing",
				disabled: phase === "processing"
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
				className: "mt-8 space-y-8",
				children: [
					phase === "analyzing" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Card, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(CardContent, {
						className: "space-y-4 p-5 sm:p-6",
						children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
							className: "text-sm text-muted-foreground",
							children: "Analyzing video..."
						}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "flex flex-col gap-4 sm:flex-row",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Skeleton, { className: "aspect-video w-full rounded-lg sm:w-56" }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
								className: "flex-1 space-y-3",
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Skeleton, { className: "h-6 w-4/5" }),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Skeleton, { className: "h-4 w-1/3" }),
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(Skeleton, { className: "h-4 w-1/2" })
								]
							})]
						})]
					}) }) : null,
					phase === "error" && error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Card, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(CardContent, {
						className: "space-y-3 p-5 sm:p-6",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", {
								className: "font-medium",
								children: "We hit a snag"
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", {
								className: "text-sm text-muted-foreground",
								children: error
							}),
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								type: "button",
								className: "text-sm underline-offset-4 hover:underline",
								onClick: reset,
								children: "Start over"
							})
						]
					}) }) : null,
					video && (phase === "ready" || phase === "processing" || phase === "complete") ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Card, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(CardContent, {
						className: "space-y-6 p-5 sm:p-6",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)(VideoCard, { video }),
							phase === "ready" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FormatSelector, {
								video,
								simpleMode,
								onSimpleMode: setSimpleMode,
								selectedId,
								onSelect: setSelectedId,
								onDownload: () => void handleDownload(),
								downloading: starting
							}) : null,
							phase === "processing" && job ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ProgressCard, { job }) : null,
							phase === "complete" && job ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CompleteCard, {
								job,
								onReset: reset
							}) : null
						]
					}) }) : null,
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)(DownloadHistory, { items: history })
				]
			})
		]
	});
}
//#endregion
export { Home as component };
