/**
 * @autter/runtime-browser/breadcrumbs — the steps before an error.
 *
 * Opt-in on purpose: console patching, the ring buffer and its bounds would
 * push the main tracker past its 5 KB budget, and the main bundle promises
 * "no console patching". Importing this module and calling
 * `enableBreadcrumbs()` turns it on:
 *
 *   import { initAutterBrowser } from "@autter/runtime-browser";
 *   import { enableBreadcrumbs, addBreadcrumb } from "@autter/runtime-browser/breadcrumbs";
 *   initAutterBrowser({ endpoint: "/api/autter-runtime", service: "web" });
 *   enableBreadcrumbs();                       // { console: false } to skip console
 *   addBreadcrumb({ message: "Opened checkout", data: { items: 3 } });
 *
 * It keeps the last 30 breadcrumbs (requests, navigations, clicks,
 * console.warn/error, your own) and attaches them, oldest first, to the
 * failures the tracker reports: exceptions, unhandled rejections, request
 * failures, error messages and outcomes. Every message and data value is
 * scrubbed with the tracker's own redaction (`scrubText`, `redactContext`).
 */

import { _useBreadcrumbs, redactContext, scrubText } from "./index";

export type BreadcrumbType = "console" | "request" | "navigation" | "click" | "log" | "custom";
export type BreadcrumbLevel = "debug" | "info" | "warning" | "error";

/** Wire shape (sink contract §1): oldest first, at most 30 per event. */
export interface Breadcrumb {
	type: BreadcrumbType;
	/** ISO timestamp. */
	at: string;
	level?: BreadcrumbLevel;
	/** At most 500 characters, scrubbed. */
	message: string;
	/** At most 10 keys; strings at most 200 characters, scrubbed. */
	data?: Record<string, string | number | boolean | null>;
}

export interface BreadcrumbInput {
	/** Default "custom". */
	type?: BreadcrumbType;
	message: string;
	level?: BreadcrumbLevel;
	data?: Record<string, unknown>;
}

export interface BreadcrumbOptions {
	/** Record console.warn and console.error calls (default true). */
	console?: boolean;
}

export const MAX_BREADCRUMBS = 30;
const MAX_MESSAGE = 500;
const MAX_DATA_KEYS = 10;
const MAX_DATA_STRING = 200;
/** Per event: keep the newest breadcrumbs that fit this much JSON. */
const EVENT_BUDGET = 8 * 1024;
/** Per 5 s (the longest a batch stays queued): beacons and keepalive
 * fetches are capped at 64 KB, so breadcrumbs may never crowd out errors. */
const WINDOW_BUDGET = 24 * 1024;
const WINDOW_MS = 5000;

const TYPES: BreadcrumbType[] = ["console", "request", "navigation", "click", "log", "custom"];
const LEVELS: BreadcrumbLevel[] = ["debug", "info", "warning", "error"];
/** Event types that get breadcrumbs: the ones that become issues. */
const FAILURES = ["exception", "unhandled_rejection", "request_failure", "message", "outcome"];

let trail: Breadcrumb[] = [];
let sent: Array<[at: number, bytes: number]> = [];
let lastPath = "";
let installed = false;
let consoleWrapped = false;
let busy = false;

function text(value: unknown, max: number): string {
	return scrubText(String(value).slice(0, max + 512)).slice(0, max);
}

function boundData(raw: Record<string, unknown> | undefined): Breadcrumb["data"] {
	if (!raw || typeof raw !== "object") return undefined;
	const out: Record<string, string | number | boolean | null> = {};
	let count = 0;
	try {
		// redactContext masks sensitive keys and scrubs string values.
		const clean = redactContext(raw);
		for (const key in clean) {
			if (count >= MAX_DATA_KEYS) break;
			const value = clean[key];
			if (typeof value === "string") out[key.slice(0, 100)] = value.slice(0, MAX_DATA_STRING);
			else if (typeof value === "number") {
				if (!Number.isFinite(value)) continue;
				out[key.slice(0, 100)] = value;
			} else if (typeof value === "boolean" || value === null) out[key.slice(0, 100)] = value;
			else continue;
			count++;
		}
	} catch {
		// Throwing getter or revoked Proxy: keep the breadcrumb, drop its data.
		return undefined;
	}
	return count > 0 ? out : undefined;
}

function record(crumb: BreadcrumbInput): void {
	if (busy) return;
	busy = true;
	try {
		const type = TYPES.includes(crumb.type as BreadcrumbType) ? (crumb.type as BreadcrumbType) : "custom";
		const level = LEVELS.includes(crumb.level as BreadcrumbLevel) ? crumb.level : undefined;
		const data = boundData(crumb.data);
		trail.push({
			type,
			at: new Date().toISOString(),
			...(level ? { level } : {}),
			message: text(crumb.message ?? "", MAX_MESSAGE),
			...(data ? { data } : {}),
		});
		if (trail.length > MAX_BREADCRUMBS) trail.splice(0, trail.length - MAX_BREADCRUMBS);
	} catch {
		/* a breadcrumb must never break the app */
	} finally {
		busy = false;
	}
}

/** Steps the tracker saw itself, reported through its hooks. */
function fromTracker(kind: string, a?: unknown, b?: unknown, status?: unknown, ms?: unknown): void {
	if (kind === "request") {
		const method = String(a || "GET").toUpperCase().slice(0, 16);
		const path = String(b || "/");
		const code = Number(status) || 0;
		record({
			type: "request",
			level: code === 0 || code >= 500 ? "error" : code >= 400 ? "warning" : "info",
			message: `${method} ${path} ${code || "failed"}`,
			data: { method, path, status: code, durationMs: Math.max(0, Math.round(Number(ms) || 0)) },
		});
	} else if (kind === "navigation") {
		const to = String(a || "");
		if (!to || to === lastPath) return;
		const from = lastPath;
		lastPath = to;
		record({ type: "navigation", level: "info", message: to, data: from ? { from, to } : { to } });
	} else if (kind === "click") {
		record({ type: "click", level: "info", message: String(a || "") });
	}
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : undefined;

/** UTF-8 size of one breadcrumb in the JSON array (plus its comma). */
function jsonBytes(crumb: Breadcrumb): number {
	const json = JSON.stringify(crumb);
	return (encoder ? encoder.encode(json).length : json.length * 3) + 1;
}

/** The breadcrumbs to attach to a failure event, oldest first — or none. */
function forEvent(eventType: string): Breadcrumb[] | undefined {
	if (!FAILURES.includes(eventType) || trail.length === 0) return undefined;
	const now = Date.now();
	sent = sent.filter(([at]) => now - at < WINDOW_MS);
	const room = Math.min(EVENT_BUDGET, WINDOW_BUDGET - sent.reduce((n, [, bytes]) => n + bytes, 0));
	const out: Breadcrumb[] = [];
	let used = 0;
	for (let i = trail.length - 1; i >= 0; i--) {
		const crumb = trail[i]!;
		const bytes = jsonBytes(crumb);
		if (used + bytes > room) break;
		used += bytes;
		out.unshift({ ...crumb, ...(crumb.data ? { data: { ...crumb.data } } : {}) });
	}
	if (out.length === 0) return undefined;
	sent.push([now, used]);
	return out;
}

function install(): void {
	if (installed) return;
	installed = true;
	try {
		lastPath = location.pathname || "";
	} catch {
		/* no location */
	}
	_useBreadcrumbs({ add: fromTracker, list: forEvent });
}

/** Render console arguments as one line; objects are serialised, bounded. */
function consoleLine(args: unknown[]): string {
	return args
		.map((arg) => {
			if (typeof arg === "string") return arg;
			if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
			if (arg === null || typeof arg !== "object") return String(arg);
			try {
				let nodes = 0;
				// Stop descending after 50 values: a console.warn of a huge object
				// must not cost a full serialisation.
				return JSON.stringify(arg, (_key, value) => (nodes++ > 50 ? undefined : value)) ?? String(arg);
			} catch {
				return Object.prototype.toString.call(arg);
			}
		})
		.join(" ");
}

function wrapConsole(): void {
	if (consoleWrapped || typeof console === "undefined") return;
	consoleWrapped = true;
	for (const method of ["warn", "error"] as const) {
		const original = console[method];
		if (typeof original !== "function") continue;
		console[method] = function (this: Console, ...args: unknown[]) {
			// `busy` also stops recursion when scrubbing or a hook logs.
			if (!busy) {
				try {
					record({
						type: "console",
						level: method === "warn" ? "warning" : "error",
						message: consoleLine(args).slice(0, 4000),
					});
				} catch {
					/* never break console */
				}
			}
			return original.apply(this, args);
		};
	}
}

/**
 * Start recording breadcrumbs and attaching them to failures. Safe to call
 * before or after `initAutterBrowser`, and more than once.
 */
export function enableBreadcrumbs(options: BreadcrumbOptions = {}): void {
	if (typeof window === "undefined") return;
	install();
	if (options.console !== false) wrapConsole();
}

/**
 * Record your own step (type "custom" unless you say otherwise). The next
 * failure carries it. Never throws.
 */
export function addBreadcrumb(crumb: BreadcrumbInput): void {
	if (!crumb || typeof window === "undefined") return;
	install();
	record(crumb);
}

/** Forget every recorded breadcrumb (e.g. on logout). */
export function clearBreadcrumbs(): void {
	trail = [];
	sent = [];
}
