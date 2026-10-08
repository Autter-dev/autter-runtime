/**
 * A fixed 1.4.0-era operation, exported to a fake collector and normalised
 * so it can be compared byte-for-byte across SDK versions. Volatile values
 * (ids, timestamps, durations, stacks, trace ids) are replaced with stable
 * placeholders; everything else, including attribute ORDER, is preserved.
 *
 * `golden-1.4.0-logs.json` was written by `write-golden.mjs` from the
 * runtime-node 1.4.0 build, BEFORE the 1.5.0 logger refactor. Never
 * regenerate it from a newer build — that would defeat the test.
 */
import { createServer } from "node:http";

/** Keys 1.5.0 adds to every operation summary (additive, see OPERATION-LOGGING.md). */
export const ADDITIVE_SUMMARY_KEYS = new Set([
	"autter.operation.kind",
	"autter.operation.level",
]);

export async function runGoldenScenario(sdk) {
	const bodies = [];
	const collector = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.url === "/v1/logs") bodies.push(JSON.parse(body));
			res.end("{}");
		});
	});
	await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
	const runtime = sdk.initAutterServer({
		service: "golden",
		environment: "test",
		release: "v1",
		apiKey: "golden-key",
		endpoint: `http://127.0.0.1:${collector.address().port}`,
		captureGlobalErrors: false,
		autoFlush: false,
		memoryMetrics: false,
		logging: { console: false, inline: false },
	});
	try {
		await sdk.withRuntimeOperation(
			"checkout",
			async (op) => {
				op.setContext({
					cart: { items: 3, coupon: "SPRING" },
					token: "secret-value",
					note: "person@example.com",
					"autter.operation.id": "spoofed",
				});
				op.setContext({ cart: { total: 42.5 } });
				await op.step("reserve", async () => true);
				await sdk
					.withRuntimeOperation("charge", async (child) => {
						await child.step("authorize", async () => {
							throw new TypeError("card declined");
						});
					})
					.catch(() => {});
				sdk.runtimeLogger.info("reserved", { sku: "A1" });
				sdk.runtimeLogger.warn("slow dependency", { ms: 900 });
				op.outcome("degraded", "Used cached prices");
			},
			{ tenant: "acme" },
		);
		sdk.runtimeLogger.error(new RangeError("outside"), { phase: "boot" });
		sdk.runtimeLogger.debug("debug line");
		await sdk.flushRuntimeLogs();
	} finally {
		await runtime.shutdown();
		await new Promise((resolve) => collector.close(resolve));
	}
	return normalise(bodies);
}

export function normalise(bodies, { stripAdditive = false } = {}) {
	const ids = new Map();
	const stable = (value) => {
		if (!ids.has(value)) ids.set(value, `<id-${ids.size + 1}>`);
		return ids.get(value);
	};
	const scrub = (key, value) => {
		if (key === "autter.event.id") return { stringValue: "<event-id>" };
		if (
			key === "autter.operation.id" ||
			key === "autter.operation.parent_id"
		)
			return { stringValue: stable(value.stringValue) };
		if (key === "autter.operation.duration_ms")
			return { doubleValue: "<duration>" };
		if (key === "exception.stacktrace") return { stringValue: "<stack>" };
		if (key === "autter.operation.steps")
			return {
				arrayValue: {
					values: value.arrayValue.values.map((step) => ({
						kvlistValue: {
							values: step.kvlistValue.values.map((entry) =>
								entry.key === "durationMs"
									? { key: "durationMs", value: { doubleValue: "<ms>" } }
									: entry,
							),
						},
					})),
				},
			};
		return value;
	};
	return bodies.map((body) => ({
		resourceLogs: body.resourceLogs.map((resourceLog) => ({
			...resourceLog,
			scopeLogs: resourceLog.scopeLogs.map((scopeLog) => ({
				...scopeLog,
				logRecords: scopeLog.logRecords.map((record) => {
					const out = {};
					for (const [key, value] of Object.entries(record)) {
						if (key === "timeUnixNano") out[key] = "<time>";
						else if (key === "traceId") out[key] = "<trace>";
						else if (key === "spanId") out[key] = "<span>";
						else if (key === "attributes")
							out[key] = value
								.filter(
									(attribute) =>
										!stripAdditive || !ADDITIVE_SUMMARY_KEYS.has(attribute.key),
								)
								.map((attribute) => ({
									key: attribute.key,
									value: scrub(attribute.key, attribute.value),
								}));
						else out[key] = value;
					}
					return out;
				}),
			})),
		})),
	}));
}
