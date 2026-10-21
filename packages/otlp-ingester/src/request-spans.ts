/**
 * Which request each span of an export batch belongs to, so the span-fed
 * usage rollups (`runtime_metrics_1m`) count one request once.
 *
 * A framework that opens its own SERVER span under the HTTP
 * instrumentation's gives one request two server spans: Next.js's
 * `BaseServer.handleRequest` span is a child of the HTTP server span, and
 * some NestJS and Fastify setups and gRPC gateways serving RPCs in-process do
 * the same. Each server span used to add a request, its latency and its error
 * to the rollups, so every traced request of such an app counted twice.
 *
 * The request is the OUTERMOST server span. Walking up from a span through
 * the parent links present in the batch, its request is the highest SERVER
 * span reached. The walk stops:
 *   - at a parent that is not in the batch: the span's own chain ends there,
 *     so a server span whose parent is missing is a request of its own, as
 *     before. When an exporter's timer splits one request's spans across two
 *     batches, the nested server span therefore counts in its batch and the
 *     outer one in the other; a batch cannot tell a parent exported elsewhere
 *     from a remote caller;
 *   - at a parent in another process (service, environment, release and
 *     `service.instance.id`): one process serves one request;
 *   - where a SERVER or CONSUMER span's parent is a CLIENT or PRODUCER span:
 *     that edge is a call over the wire, a request of its own even when a
 *     service calls itself.
 */

export interface RequestSpanLink {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	/** Lower-case OTel span kind: "server", "client", "internal", … */
	kind: string;
	/** The process the span was recorded in; spans of different processes
	 * are never one request. */
	process: string;
}

export interface RequestMembership {
	/** Per span: the batch index of its request's (outermost) server span,
	 * or -1 when no server span is on its chain. */
	requestOf: number[];
	/** Per span: how many parent links the walk followed above it (0 at the
	 * top of its chain). Nested spans are deeper than their request span. */
	depth: number[];
}

const UNSET = -2;

function isRemoteCallEdge(child: string, parent: string): boolean {
	return (child === "server" || child === "consumer") && (parent === "client" || parent === "producer");
}

export function requestMembership(spans: RequestSpanLink[]): RequestMembership {
	const byKey = new Map<string, number>();
	spans.forEach((span, i) => {
		if (!span.traceId || !span.spanId) return;
		const key = `${span.traceId}\u0000${span.spanId}`;
		if (!byKey.has(key)) byKey.set(key, i);
	});

	/** The parent the walk may step to, or -1. */
	const parentOf = (i: number): number => {
		const span = spans[i]!;
		if (!span.traceId || !span.parentSpanId) return -1;
		const p = byKey.get(`${span.traceId}\u0000${span.parentSpanId}`);
		if (p === undefined || p === i) return -1;
		const parent = spans[p]!;
		if (parent.process !== span.process) return -1;
		if (isRemoteCallEdge(span.kind, parent.kind)) return -1;
		return p;
	};

	const requestOf = new Array<number>(spans.length).fill(UNSET);
	const depth = new Array<number>(spans.length).fill(0);
	for (let start = 0; start < spans.length; start++) {
		if (requestOf[start] !== UNSET) continue;
		// Walk up until a resolved span, the top of the chain, or a cycle
		// (malformed parent links).
		const path: number[] = [];
		const onPath = new Set<number>();
		let above = -1;
		let aboveDepth = -1;
		let cur = start;
		for (;;) {
			path.push(cur);
			onPath.add(cur);
			const p = parentOf(cur);
			if (p < 0 || onPath.has(p)) break;
			if (requestOf[p] !== UNSET) {
				above = requestOf[p]!;
				aboveDepth = depth[p]!;
				break;
			}
			cur = p;
		}
		// Resolve top-down: the outermost server span wins.
		for (let k = path.length - 1; k >= 0; k--) {
			const node = path[k]!;
			if (above === -1 && spans[node]!.kind === "server") above = node;
			aboveDepth += 1;
			requestOf[node] = above;
			depth[node] = aboveDepth;
		}
	}
	return { requestOf, depth };
}
