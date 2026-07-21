/**
 * Example: Express app instrumented with Autter Runtime.
 *
 *   AUTTER_RUNTIME_KEY=dev-key AUTTER_ENDPOINT=http://localhost:4318 node server.js
 *
 * - Server tracing/errors via @autter/runtime-node (OTel → /v1/traces)
 * - Browser errors via @autter/runtime-browser → same-origin relay → /v1/browser
 */
import { initAutterServer, createBrowserRelayHandler, captureException } from "@autter/runtime-node";

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

const { default: express } = await import("express");
const app = express();

app.use(express.static("public"));

// Same-origin relay: the browser posts here; the key stays server-side.
app.post("/api/autter-runtime", createBrowserRelayHandler({ apiKey, endpoint }));

app.get("/api/ok", (_req, res) => res.json({ ok: true }));

app.get("/api/boom", (_req, res) => {
	try {
		throw new TypeError("cannot read properties of undefined (reading 'total')");
	} catch (err) {
		captureException(err, { route: "/api/boom" });
		res.status(500).json({ error: "boom" });
	}
});

app.listen(3000, () => {
	console.log("example app on http://localhost:3000 (open it, then click the buttons)");
});
