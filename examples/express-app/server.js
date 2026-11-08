/**
 * Example: Express app instrumented with Autter Runtime.
 *
 *   docker compose up        # in the autter-runtime repo: ClickHouse + ingester on :4318
 *   npm start                # here: sends to http://localhost:4318 with the local key
 *
 * Against another ingester, set both:
 *
 *   AUTTER_ENDPOINT=https://otlp.autter.dev AUTTER_RUNTIME_KEY=autter_rt_… npm start
 *
 * - Server tracing/errors via @autter/runtime-node (OTel → /v1/traces); thrown
 *   errors keep their stack through autterErrorHandler
 * - One request summary per HTTP request via autterRequests (→ /v1/logs),
 *   echoed request ids, coded errors and client-safe error responses
 * - Browser errors via @autter/runtime-browser → same-origin relay → /v1/browser
 */
import { fileURLToPath } from "node:url";
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

// With nothing set, the example talks to the local `docker compose up`
// ingester, never to a hosted one: that takes an explicit AUTTER_ENDPOINT
// and a real key.
const LOCAL_ENDPOINT = "http://localhost:4318";
// Built into the ingester, accepted only by the repo's docker compose setup.
const LOCAL_DEV_KEY = "autter_rt_local_dev_only";

const endpoint = (process.env.AUTTER_ENDPOINT || LOCAL_ENDPOINT).replace(/\/+$/, "");
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(endpoint);
const apiKey = process.env.AUTTER_RUNTIME_KEY || (isLocal ? LOCAL_DEV_KEY : "");
if (!apiKey) {
	console.error(`AUTTER_ENDPOINT is ${endpoint}, but AUTTER_RUNTIME_KEY is not set. Set it to a server key (autter_rt_…).`);
	process.exit(1);
}
if (apiKey === LOCAL_DEV_KEY && !isLocal) {
	console.error(
		`${LOCAL_DEV_KEY} only works with the local docker compose ingester, not ${endpoint}. Set AUTTER_RUNTIME_KEY to a server key (autter_rt_…).`,
	);
	process.exit(1);
}
console.log(
	`Sending telemetry to ${endpoint}${process.env.AUTTER_ENDPOINT ? "" : " (AUTTER_ENDPOINT not set: the local docker compose ingester)"}, ` +
		`key ${apiKey === LOCAL_DEV_KEY ? `${LOCAL_DEV_KEY} (built-in local key)` : "from AUTTER_RUNTIME_KEY"}.`,
);
console.log(
	`Check the connection: npx @autter/runtime-node doctor --endpoint ${endpoint}${apiKey === LOCAL_DEV_KEY ? ` --key ${LOCAL_DEV_KEY}` : ""}`,
);

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
app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));
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

// A plain bug: no try/catch, no manual captureException. autterErrorHandler
// below records it with its stack on the request span.
app.get("/api/boom", () => {
	throw new TypeError("cannot read properties of undefined (reading 'total')");
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

// After the routes: records every 5xx/coded error, stack included, on the
// request span, then calls next(err) unchanged. Keep your own error handler
// after it; here that is autterErrorResponse.
app.use(autterErrorHandler());

// Last: turns errors into client-safe JSON (never `internal`) and records them
// on the request summary. (It reports errors too; autterErrorHandler got there
// first, so each error is reported once.)
app.use(autterErrorResponse());

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
	console.log(`example app on http://localhost:${port} (open it, then click the buttons)`);
});
