/**
 * Example: Express app instrumented with Autter Runtime.
 *
 *   AUTTER_RUNTIME_KEY=<your local key> AUTTER_ENDPOINT=http://localhost:4318 node server.js
 *
 * (The local `docker compose up` ingester has no built-in key: it accepts
 * only the keys in AUTTER_INGEST_KEYS, so without one every export answers
 * 401. docs/GETTING-STARTED.md generates a key and its .env mapping.)
 *
 * - Server tracing/errors via @autter/runtime-node (OTel → /v1/traces); thrown
 *   errors keep their stack through autterErrorHandler
 * - One request summary per HTTP request via autterRequests (→ /v1/logs),
 *   echoed request ids, coded errors and client-safe error responses
 * - Browser errors via @autter/runtime-browser → same-origin relay → /v1/browser
 */
import {
	initAutterServer,
	createBrowserRelayHandler,
	withLlmCall,
	emitLlmSelftestTrace,
	autterRequests,
	autterErrorHandler,
	autterErrorResponse,
	defineRuntimeErrors,
	runtimeContext,
} from "@autter/runtime-node";

const endpoint = process.env.AUTTER_ENDPOINT ?? "https://otlp.autter.dev";
const apiKey = process.env.AUTTER_RUNTIME_KEY ?? "";
if (!apiKey) {
	console.warn(
		"[example] AUTTER_RUNTIME_KEY is not set: the ingester will refuse every export (401). " +
			"The app still runs; see docs/GETTING-STARTED.md to create a local key.",
	);
}

// Last line of defence for the app's own code: log an unhandled rejection
// instead of letting Node exit. (Autter never rejects into your app: export
// failures are printed and passed to onExportError below.) With a listener
// here, Autter records the rejection as an error and the process stays up.
process.on("unhandledRejection", (reason) => {
	console.error("[example] unhandled promise rejection:", reason);
});

/** The latest failed export, shown by GET /api/telemetry-status. */
let lastExportError = null;

// Must run before other imports create connections — in real apps put this
// in a preloaded module (node --import ./instrument.js).
const runtime = initAutterServer({
	apiKey,
	endpoint,
	service: "example-express",
	environment: "development",
	release: process.env.GIT_SHA ?? "dev",
	traceSampleRate: 1, // sample everything in the example
	// Failed exports (a wrong key, the ingester down) never throw into the
	// app; they are printed once a minute per kind and passed here.
	onExportError: (error) => {
		lastExportError = { kind: error.kind, status: error.status, message: error.message, at: new Date().toISOString() };
	},
});

// Coded errors: one code = one issue, whatever the message says. `expected`
// failures are recorded but never open incidents.
const checkoutErrors = defineRuntimeErrors("checkout", {
	card_declined: {
		status: 402,
		message: "Payment declined",
		expected: true,
		why: "The card issuer rejected the charge",
		fix: "Ask the customer for another card",
	},
	out_of_stock: ({ sku }) => ({
		status: 409,
		message: `Item ${sku} is out of stock`,
		fix: "Remove the item or wait for restock",
	}),
});

const { default: express } = await import("express");
const app = express();

// One `kind: "request"` summary per request (always kept), with the request
// id echoed in `x-request-id`. Health checks are not worth a record.
app.use(autterRequests({ ignore: ["/healthz"] }));
app.use(express.static("public"));
app.get("/healthz", (_req, res) => res.send("ok"));

// Same-origin relay: the browser posts here; the key stays server-side.
app.post("/api/autter-runtime", createBrowserRelayHandler({ apiKey, endpoint }));

app.get("/api/ok", (_req, res) => res.json({ ok: true }));
app.get("/api/telemetry-status", (_req, res) => res.json({ lastExportError }));

// Param route: shows up in runtime_metrics_1m as "/api/users/:id" — one
// rollup row per route template, not one per user id.
app.get("/api/users/:id", (req, res) => {
	runtimeContext.set({ user: { id: req.params.id } });
	res.json({ id: req.params.id, requestId: runtimeContext.requestId });
});

// Coded errors flow to autterErrorResponse below:
//   402 { error: { message, code: "checkout.card_declined", why, fix, requestId } }
app.post("/api/checkout", express.json(), (req, res, next) => {
	runtimeContext.set({ cart: { items: req.body?.items ?? 0 } });
	runtimeContext.info("Validating cart");
	if (req.query.declined !== undefined) return next(checkoutErrors.card_declined());
	if (req.query.sku) return next(checkoutErrors.out_of_stock({ sku: String(req.query.sku) }));
	runtimeContext.outcome("succeeded");
	res.json({ ok: true, requestId: runtimeContext.requestId });
});

// A plain bug: no try/catch, no manual captureException. autterErrorHandler
// below records it with its stack on the request span.
app.get("/api/boom", () => {
	throw new TypeError("cannot read properties of undefined (reading 'total')");
});

// Express 4 does not catch a rejected async handler: the rejection is
// unhandled and, without a listener, Node exits. Route every async handler's
// errors to next(err) so autterErrorHandler / autterErrorResponse see them.
// (Express 5 does this itself.)
const asyncRoute = (handler) => (req, res, next) => {
	Promise.resolve()
		.then(() => handler(req, res, next))
		.catch(next);
};

// LLM tracing: withLlmCall records the call at 100% with tokens + cost.
// Simulated here — swap the body for a real openai/anthropic call.
app.get(
	"/api/ai-summary",
	asyncRoute(async (_req, res) => {
		const out = await withLlmCall(
			{ provider: "openai", model: "gpt-5-mini", userId: "u_demo" },
			async (llm) => {
				await new Promise((resolve) => setTimeout(resolve, 120));
				llm.setUsage({ inputTokens: 42, outputTokens: 18 });
				return { summary: "Everything is fine." };
			},
		);
		res.json(out);
	}),
);

// Proves LLM traces reach the ingester without any model call: one fake
// "autter-selftest" call, flushed immediately, trace id returned. It never
// rejects: `ok: false` with `errors` (e.g. kind "unauthorized" for a wrong
// key) when the trace did not reach the ingester.
app.get(
	"/api/llm-selftest",
	asyncRoute(async (_req, res) => {
		const result = await emitLlmSelftestTrace();
		res.status(result.ok ? 200 : 502).json({
			ok: result.ok,
			traceId: result.traceId,
			errors: result.errors.map(({ kind, status, message }) => ({ kind, status, message })),
		});
	}),
);

// After the routes: records every 5xx/coded error, stack included, on the
// request span, then calls next(err) unchanged. Keep your own error handler
// after it; here that is autterErrorResponse.
app.use(autterErrorHandler());

// Last: turns errors into client-safe JSON (never `internal`) and records them
// on the request summary. (It reports errors too; autterErrorHandler got there
// first, so each error is reported once.)
app.use(autterErrorResponse());

const server = app.listen(3000, () => {
	console.log("example app on http://localhost:3000 (open it, then click the buttons)");
});

// Graceful shutdown: stop taking requests, flush what Autter buffered, exit.
// shutdown() never rejects (a failed final export is printed instead), and a
// second signal exits at once.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		if (stopping) process.exit(1);
		stopping = true;
		server.close();
		const force = setTimeout(() => process.exit(1), 10_000);
		force.unref();
		runtime.shutdown().finally(() => process.exit(0));
	});
}
