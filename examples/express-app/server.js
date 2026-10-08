/**
 * Example: Express app instrumented with Autter Runtime.
 *
 *   AUTTER_RUNTIME_KEY=dev-key AUTTER_ENDPOINT=http://localhost:4318 node server.js
 *
 * - Server tracing/errors via @autter/runtime-node (OTel → /v1/traces)
 * - One request summary per HTTP request via autterRequests (→ /v1/logs),
 *   echoed request ids, coded errors and client-safe error responses
 * - Browser errors via @autter/runtime-browser → same-origin relay → /v1/browser
 */
import {
	initAutterServer,
	createBrowserRelayHandler,
	captureException,
	withLlmCall,
	emitLlmSelftestTrace,
	autterRequests,
	autterErrorResponse,
	defineRuntimeErrors,
	runtimeContext,
} from "@autter/runtime-node";

const endpoint = process.env.AUTTER_ENDPOINT ?? "https://otlp.autter.dev";
const apiKey = process.env.AUTTER_RUNTIME_KEY ?? "dev-key";

// Must run before other imports create connections — in real apps put this
// in a preloaded module (node --import ./instrument.js).
initAutterServer({
	apiKey,
	endpoint,
	service: "example-express",
	environment: "development",
	release: process.env.GIT_SHA ?? "dev",
	traceSampleRate: 1, // sample everything in the example
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

app.get("/api/boom", (_req, res) => {
	try {
		throw new TypeError("cannot read properties of undefined (reading 'total')");
	} catch (err) {
		captureException(err, { route: "/api/boom" });
		res.status(500).json({ error: "boom" });
	}
});

// LLM tracing: withLlmCall records the call at 100% with tokens + cost.
// Simulated here — swap the body for a real openai/anthropic call.
app.get("/api/ai-summary", async (_req, res) => {
	const out = await withLlmCall(
		{ provider: "openai", model: "gpt-5-mini", userId: "u_demo" },
		async (llm) => {
			await new Promise((resolve) => setTimeout(resolve, 120));
			llm.setUsage({ inputTokens: 42, outputTokens: 18 });
			return { summary: "Everything is fine." };
		},
	);
	res.json(out);
});

// Proves LLM traces reach the ingester without any model call: one fake
// "autter-selftest" call, flushed immediately, trace id returned.
app.get("/api/llm-selftest", async (_req, res) => {
	res.json(await emitLlmSelftestTrace());
});

// Last: turns errors into client-safe JSON (never `internal`), records them on
// the request summary and reports coded/5xx errors.
app.use(autterErrorResponse());

app.listen(3000, () => {
	console.log("example app on http://localhost:3000 (open it, then click the buttons)");
});
