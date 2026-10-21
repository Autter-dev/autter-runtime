import type { Attributes, Context, Link, SpanKind } from "@opentelemetry/api";
import { getRPCMetadata, RPCType } from "@opentelemetry/core";
import type { Sampler, SamplingResult } from "@opentelemetry/sdk-trace-base";

/**
 * Route templates on request metrics for frameworks that open their own
 * spans inside the HTTP instrumentation's request span (Next.js).
 *
 * The HTTP instrumentation names a request's route on BOTH its server span
 * and its `http.server.duration` data point from one place: the request's
 * RPC metadata (`rpcMetadata.route`), read when the response closes. Express
 * gets it from runtime-node's response hook, router instrumentations set it
 * themselves, but nothing sets it for Next.js: Next puts `http.route` on its
 * own `BaseServer.handleRequest` span only at the very end, after the
 * response has closed and the metric was recorded without a route. Next does
 * name the route template at the start of the spans it opens while handling
 * the request — `next.route` on "resolve page components", "render route
 * (app) /blog/[slug]", "executing api route (app) /api/…" — and those
 * spans' parent context carries the request's RPC metadata. So every span
 * start is looked at here, in the sampler, which sees all of them, recorded
 * or not (a span processor would miss head-unsampled spans when tail
 * retention is off).
 *
 * The latest `next.route` wins (Next's own final `http.route` is the last
 * one it set), except that a template with a dynamic segment (`[slug]`) is
 * never replaced by one without, nor a template by itself plus its file's
 * last segment (Next 15's "executing api route (app) /api/x/route" after
 * "resolve page components" named "/api/x"), and `BaseServer.renderToResponse`
 * spans (opened only with `NEXT_OTEL_VERBOSE`) are skipped: they carry the
 * raw path. A route set by someone else (a router instrumentation) is never
 * replaced.
 */

/** The route this module last put on each request's RPC metadata. */
const ours = new WeakMap<object, string>();

/** Span types whose `next.route` is the request path, not its template. */
const RAW_PATH_SPAN_TYPES = new Set(["BaseServer.renderToResponse"]);

export function noteFrameworkRoute(parent: Context, attributes: Attributes | undefined): void {
	const route = attributes?.["next.route"];
	if (typeof route !== "string" || !route.startsWith("/")) return;
	if (RAW_PATH_SPAN_TYPES.has(String(attributes?.["next.span_type"] ?? ""))) return;
	const rpc = getRPCMetadata(parent);
	if (!rpc || rpc.type !== RPCType.HTTP) return;
	const mine = ours.get(rpc);
	if (rpc.route !== undefined && rpc.route !== mine) return;
	if (mine !== undefined && mine.includes("[") && !route.includes("[")) return;
	// Next 15 names a route handler's span after its file ("/api/items/[id]/route")
	// right after naming the template itself ("/api/items/[id]").
	if (mine !== undefined && (route === `${mine}/route` || route === `${mine}/page`)) return;
	rpc.route = route;
	ours.set(rpc, route);
}

/** Delegates every decision; on the way, names the request's route from
 * the span's start attributes (noteFrameworkRoute). */
export class RouteLabelSampler implements Sampler {
	constructor(private readonly delegate: Sampler) {}

	shouldSample(
		ctx: Context,
		traceId: string,
		spanName: string,
		spanKind: SpanKind,
		attributes: Attributes,
		links: Link[],
	): SamplingResult {
		try {
			noteFrameworkRoute(ctx, attributes);
		} catch {
			/* naming a route never affects sampling */
		}
		return this.delegate.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
	}

	toString(): string {
		return `RouteLabel(${this.delegate.toString()})`;
	}
}
