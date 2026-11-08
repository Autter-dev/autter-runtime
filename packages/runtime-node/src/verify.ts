import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compatRequest, fetchIngesterCompat, SDK_IDENTITY, type HttpResult } from "./compat.js";
import { diagnoseConnectivity } from "./connectivity.js";
import { checkStorage, resolveEndpoint, versionSkew, installedSdks } from "./doctor.js";
import { refusalReason, resolveIngestKey } from "./ingest-auth.js";
import { versionAtLeast } from "../../otlp-ingester/src/compat.js";

/**
 * `npx @autter/runtime-node verify` — send one tagged test event through the
 * real path and read it back, step by step, stopping at the first step
 * that fails and naming it:
 *
 *   key → network → ingester → storage → auth → ingest → stored → trace → release → logs
 *
 * The test request carries `autter.verify.id` on its resource, so the
 * ingester stores it (that is what is checked) but never rolls it up or
 * forwards it to the sink: it never opens an issue or moves a dashboard.
 * Against an ingester without `/v1/verify` (older than this feature) only
 * a plain span is sent, and "stored" is reported as not checked.
 *
 * Exit codes: 0 every check passed, 1 a step failed, 2 the ingester could
 * not be reached.
 */

export type VerifyStepName =
	| "key"
	| "network"
	| "ingester"
	| "storage"
	| "auth"
	| "ingest"
	| "stored"
	| "trace"
	| "release"
	| "logs";

export interface VerifyStep {
	step: VerifyStepName;
	status: "pass" | "fail" | "warn" | "skip";
	detail: string;
	/** On failure: what to do. */
	fix?: string;
}

export interface VerifyReport {
	endpoint: string;
	service: string;
	environment: string;
	release: string | null;
	traceId: string;
	steps: VerifyStep[];
	firstFailure: VerifyStep | null;
	exitCode: 0 | 1 | 2;
}

export interface VerifyOptions {
	endpoint?: string;
	key?: string;
	service?: string;
	environment?: string;
	release?: string;
	/** How long to wait for the test event to be stored. Default 20 s. */
	waitMs?: number;
	timeoutMs?: number;
	json?: boolean;
	cwd?: string;
	/** Test hook: the poll interval. */
	pollMs?: number;
}

const ORDER: VerifyStepName[] = ["key", "network", "ingester", "storage", "auth", "ingest", "stored", "trace", "release", "logs"];

function defaultService(cwd: string, env: NodeJS.ProcessEnv): string {
	if (env.AUTTER_SERVICE) return env.AUTTER_SERVICE;
	if (env.OTEL_SERVICE_NAME) return env.OTEL_SERVICE_NAME;
	try {
		const name = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown }).name;
		if (typeof name === "string" && name) return name.replace(/^@[^/]+\//, "");
	} catch {
		// no package.json
	}
	return "autter-verify";
}

function defaultRelease(env: NodeJS.ProcessEnv): string | null {
	return (
		env.AUTTER_RELEASE ||
		env.GIT_SHA ||
		env.VERCEL_GIT_COMMIT_SHA ||
		env.RENDER_GIT_COMMIT ||
		env.RAILWAY_GIT_COMMIT_SHA ||
		env.CF_PAGES_COMMIT_SHA ||
		env.GITHUB_SHA ||
		null
	);
}

const nowNanos = () => (BigInt(Date.now()) * 1_000_000n).toString();
const str = (key: string, value: string) => ({ key, value: { stringValue: value } });

function resourceAttributes(opts: { service: string; environment: string; release: string | null; traceId: string }) {
	return [
		str("service.name", opts.service),
		str("deployment.environment", opts.environment),
		...(opts.release ? [str("service.version", opts.release)] : []),
		str("autter.verify.id", opts.traceId),
	];
}

function testTraces(opts: { service: string; environment: string; release: string | null; traceId: string; withError: boolean }) {
	const end = nowNanos();
	const start = (BigInt(end) - 1_000_000n).toString();
	return {
		resourceSpans: [
			{
				resource: { attributes: resourceAttributes(opts) },
				scopeSpans: [
					{
						scope: { name: "autter-verify", version: SDK_IDENTITY.version },
						spans: [
							{
								traceId: opts.traceId,
								spanId: randomBytes(8).toString("hex"),
								name: "autter verify",
								kind: 1,
								startTimeUnixNano: start,
								endTimeUnixNano: end,
								attributes: [str("autter.verify", "true")],
								...(opts.withError
									? {
											status: { code: 2, message: "autter verify test event" },
											events: [
												{
													name: "exception",
													timeUnixNano: end,
													attributes: [
														str("exception.type", "AutterVerifyTestEvent"),
														str("exception.message", "Test event from autter-runtime verify (never opens an issue)"),
														str("autter.severity", "info"),
													],
												},
											],
										}
									: {}),
							},
						],
					},
				],
			},
		],
	};
}

function testLogs(opts: { service: string; environment: string; release: string | null; traceId: string }) {
	return {
		resourceLogs: [
			{
				resource: { attributes: resourceAttributes(opts) },
				scopeLogs: [
					{
						scope: { name: "autter-verify" },
						logRecords: [
							{
								timeUnixNano: nowNanos(),
								severityNumber: 9,
								severityText: "INFO",
								body: { stringValue: "autter verify test log record" },
								traceId: opts.traceId,
								attributes: [str("autter.verify", "true")],
							},
						],
					},
				],
			},
		],
	};
}

interface StoredRows {
	rows: number;
	services: string[];
	releases: string[];
}

interface VerifyLookupBody {
	storage?: string;
	stored?: { spans: StoredRows; occurrences: StoredRows; logs: StoredRows | null };
	delivery?: { lastRejected?: { route: string; status: number; reason?: string; error?: string; at: string } | null } | null;
}

function parse<T>(res: HttpResult | null): T | null {
	if (!res) return null;
	try {
		return JSON.parse(res.body) as T;
	} catch {
		return null;
	}
}

const AUTH_FIX: Record<number, string> = {
	401: "Check AUTTER_RUNTIME_KEY: it must be a server key (autter_rt_…) of this repository, not revoked. Create one in Autter → Repository → Settings → Runtime.",
	403: "Server SDKs need a server key (autter_rt_…). Client keys (autter_rtc_…) are for browsers only, upload keys (autter_rtu_…) for source maps only.",
	429: "The ingester is rate limiting this key or address; wait for Retry-After and run verify again.",
	503: "The ingester could not check the key or store data right now. Run again in a few seconds; if it persists, see storage above.",
};

export async function runVerify(options: VerifyOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<VerifyReport> {
	const endpoint = resolveEndpoint(options.endpoint, env);
	const timeoutMs = options.timeoutMs ?? 5000;
	const waitMs = options.waitMs ?? 20_000;
	const pollMs = options.pollMs ?? 500;
	const cwd = options.cwd ?? process.cwd();
	const service = options.service || defaultService(cwd, env);
	const environment = options.environment || "verify";
	const release = options.release || defaultRelease(env);
	const traceId = randomBytes(16).toString("hex");
	const key = resolveIngestKey(options.key, env);
	const steps: VerifyStep[] = [];
	const add = (step: VerifyStep) => steps.push(step);
	const finish = (exitCode?: 0 | 1 | 2): VerifyReport => {
		const firstFailure = steps.find((s) => s.status === "fail") ?? null;
		for (const name of ORDER) {
			if (!steps.some((s) => s.step === name)) steps.push({ step: name, status: "skip", detail: "not run: an earlier step failed" });
		}
		steps.sort((a, b) => ORDER.indexOf(a.step) - ORDER.indexOf(b.step));
		return {
			endpoint,
			service,
			environment,
			release,
			traceId,
			steps,
			firstFailure,
			exitCode: exitCode ?? (firstFailure ? 1 : 0),
		};
	};
	const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};

	// key
	if (!key) {
		add({
			step: "key",
			status: "fail",
			detail: "no ingest key: --key not given and AUTTER_RUNTIME_KEY is not set",
			fix: "Set AUTTER_RUNTIME_KEY to a server key (autter_rt_…), or pass --key. Locally with the repo's docker compose: autter_rt_local_dev_only.",
		});
		return finish();
	}
	const kind = key.startsWith("autter_rtc_") ? "client key" : key.startsWith("autter_rtu_") ? "upload key" : "key";
	if (kind !== "key") {
		add({ step: "key", status: "fail", detail: `the key is a ${kind}`, fix: AUTH_FIX[403] });
		return finish();
	}
	add({ step: "key", status: "pass", detail: `${key.slice(0, Math.min(10, key.length))}… (${key.length} characters)` });

	// network
	const network = await diagnoseConnectivity(endpoint, { timeoutMs, env });
	if (!network.ok) {
		add({ step: "network", status: "fail", detail: `${network.failed!.step.toUpperCase()}: ${network.failed!.detail}`, fix: network.failed!.hint });
		return finish(2);
	}
	const total = network.steps.reduce((sum, s) => sum + s.ms, 0);
	add({ step: "network", status: "pass", detail: `${network.steps.map((s) => s.step.toUpperCase()).join(", ")} ok (${network.host}:${network.port}, ${total} ms)` });

	// ingester
	const { info, error } = await fetchIngesterCompat(endpoint, { unref: false, timeoutMs });
	if (!info) {
		add({
			step: "ingester",
			status: "fail",
			detail: `the server answered but is not an Autter ingester (${error ?? "unknown"})`,
			fix: "Point --endpoint (AUTTER_ENDPOINT) at the ingester's base URL, without /v1/traces.",
		});
		return finish();
	}
	const skew = versionSkew(installedSdks(cwd), info).filter((line) => line.status === "ingester_behind");
	add({
		step: "ingester",
		status: skew.length ? "warn" : "pass",
		detail: `@autter/otlp-ingester@${info.version ?? "1.4.0 or older"}${info.schema ? `, schema ${info.schema.status}` : ""}${skew.length ? `; ${skew.map((l) => l.detail).join("; ")}` : ""}`,
	});

	// storage
	const storage = await checkStorage(endpoint, timeoutMs);
	if (storage && !storage.ok) {
		add({ step: "storage", status: "fail", detail: `ClickHouse ${storage.state}`, fix: storage.detail });
		return finish();
	}
	add({ step: "storage", status: storage?.writeChecked ? "pass" : "warn", detail: storage?.detail ?? "not checked: /healthz did not answer" });

	// auth (and: does this ingester have /v1/verify?)
	const authRes = await compatRequest("GET", `${endpoint}/v1/verify`, { headers, unref: false, timeoutMs });
	let lookupSupported = true;
	if (authRes?.status === 404) {
		lookupSupported = false;
		const probe = await compatRequest("POST", `${endpoint}/v1/traces`, {
			body: JSON.stringify({ resourceSpans: [] }),
			headers,
			unref: false,
			timeoutMs,
		});
		if (!probe || probe.status >= 300) {
			const status = probe?.status ?? 0;
			add({ step: "auth", status: "fail", detail: probe ? `${status}: ${refusalReason(probe.body) || "refused"}` : "no answer", fix: AUTH_FIX[status] });
			return finish();
		}
		add({ step: "auth", status: "pass", detail: "key accepted" });
	} else if (!authRes || authRes.status !== 200) {
		const status = authRes?.status ?? 0;
		add({ step: "auth", status: "fail", detail: authRes ? `${status}: ${refusalReason(authRes.body) || "refused"}` : "no answer", fix: AUTH_FIX[status] });
		return finish();
	} else {
		const body = parse<VerifyLookupBody>(authRes);
		const lastRejected = body?.delivery?.lastRejected;
		add({
			step: "auth",
			status: "pass",
			detail:
				"key accepted" +
				(lastRejected
					? `; this key's last refused request: ${lastRejected.route} ${lastRejected.status} ${lastRejected.reason ?? ""}${lastRejected.error ? ` (${lastRejected.error})` : ""} at ${lastRejected.at}`
					: ""),
		});
	}

	// ingest
	const ingestRes = await compatRequest("POST", `${endpoint}/v1/traces`, {
		body: JSON.stringify(testTraces({ service, environment, release, traceId, withError: lookupSupported })),
		headers,
		unref: false,
		timeoutMs,
	});
	if (!ingestRes || ingestRes.status >= 300) {
		const status = ingestRes?.status ?? 0;
		add({
			step: "ingest",
			status: "fail",
			detail: ingestRes ? `/v1/traces ${status}: ${refusalReason(ingestRes.body) || "refused"}` : "no answer from /v1/traces",
			fix: AUTH_FIX[status] ?? "Run with --json and check the ingester's logs.",
		});
		return finish();
	}
	const partial = parse<{ partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string } }>(ingestRes)?.partialSuccess;
	const rejected = Number(partial?.rejectedSpans ?? 0);
	const summary = ingestRes.headers["x-autter-ingest"];
	if (rejected > 0) {
		add({ step: "ingest", status: "fail", detail: `/v1/traces accepted the request but rejected ${rejected} span(s): ${partial?.errorMessage ?? ""}` });
		return finish();
	}
	add({ step: "ingest", status: "pass", detail: `/v1/traces ${ingestRes.status}${summary ? `: ${summary}` : ""}` });

	// stored, trace, release
	if (!lookupSupported) {
		add({
			step: "stored",
			status: "warn",
			detail: `not checked: ingester ${info.version ?? "1.4.0 or older"} has no /v1/verify (upgrade it to have verify read the event back)`,
		});
		add({ step: "trace", status: "skip", detail: "not checked (needs /v1/verify)" });
		add({ step: "release", status: release ? "skip" : "warn", detail: release ? "not checked (needs /v1/verify)" : "no release set (see below)" });
		add({ step: "logs", status: "skip", detail: "not checked (needs /v1/verify)" });
		return finish();
	}
	const started = Date.now();
	let lookup: VerifyLookupBody | null = null;
	let lookupStatus = 0;
	for (;;) {
		const res = await compatRequest("GET", `${endpoint}/v1/verify/${traceId}`, { headers, unref: false, timeoutMs });
		lookupStatus = res?.status ?? 0;
		const body = res?.status === 200 ? parse<VerifyLookupBody>(res) : null;
		if (body?.stored) {
			lookup = body;
			if (body.stored.spans.rows > 0 && body.stored.occurrences.rows > 0) break;
		}
		if (Date.now() - started >= waitMs) break;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	const stored = lookup?.stored;
	if (!stored || stored.spans.rows === 0 || stored.occurrences.rows === 0) {
		add({
			step: "stored",
			status: "fail",
			detail: !stored
				? `could not read it back (GET /v1/verify answered ${lookupStatus || "nothing"})`
				: `accepted but not found after ${seconds} s: ${stored.spans.rows} span(s), ${stored.occurrences.rows} error(s) stored`,
			fix: "The ingester answered 200 but the rows are not in ClickHouse. Check the ingester's logs for write errors and its /healthz `writes` section.",
		});
		return finish();
	}
	add({ step: "stored", status: "pass", detail: `${stored.spans.rows} span and ${stored.occurrences.rows} error stored after ${seconds} s` });
	add({ step: "trace", status: "pass", detail: `the error is linked to its span by trace id ${traceId}` });
	if (!release) {
		add({
			step: "release",
			status: "warn",
			detail: "no release set: errors are not tied to a deploy, so \"broke in release X\" can't work",
			fix: "Pass `release` to initAutterServer (and initAutterBrowser), e.g. process.env.GIT_SHA; run verify with --release or GIT_SHA set.",
		});
	} else if (stored.occurrences.releases.includes(release) && stored.spans.releases.includes(release)) {
		add({ step: "release", status: "pass", detail: `release ${release} stored on the error and the span` });
	} else {
		add({
			step: "release",
			status: "fail",
			detail: `sent release ${release}, stored ${JSON.stringify(stored.occurrences.releases)}`,
			fix: "The ingester did not keep service.version: check for a collector or proxy that rewrites resource attributes.",
		});
	}

	// logs
	const logsSupported = info.version === null ? false : versionAtLeast(info.version, "1.4.0") === true;
	if (!logsSupported || stored.logs === null) {
		add({ step: "logs", status: "skip", detail: "not checked: this ingester stores no OTLP logs (operation logging needs ingester >= 1.4.0)" });
		return finish();
	}
	const logRes = await compatRequest("POST", `${endpoint}/v1/logs`, {
		body: JSON.stringify(testLogs({ service, environment, release, traceId })),
		headers,
		unref: false,
		timeoutMs,
	});
	if (!logRes || logRes.status >= 300) {
		add({
			step: "logs",
			status: "fail",
			detail: logRes ? `/v1/logs ${logRes.status}: ${refusalReason(logRes.body) || "refused"}` : "no answer from /v1/logs",
			fix: logRes?.status === 404 ? "This ingester has no /v1/logs: upgrade it, or check for a path prefix in the endpoint." : AUTH_FIX[logRes?.status ?? 0],
		});
		return finish();
	}
	const logStart = Date.now();
	let logRows = 0;
	for (;;) {
		const body = parse<VerifyLookupBody>(await compatRequest("GET", `${endpoint}/v1/verify/${traceId}`, { headers, unref: false, timeoutMs }));
		logRows = body?.stored?.logs?.rows ?? 0;
		if (logRows > 0 || Date.now() - logStart >= waitMs) break;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	add(
		logRows > 0
			? { step: "logs", status: "pass", detail: `${logRows} log record stored after ${((Date.now() - logStart) / 1000).toFixed(1)} s` }
			: { step: "logs", status: "fail", detail: "/v1/logs accepted the record but it was not stored", fix: "Check the ingester's logs for runtime_logs write errors." },
	);
	return finish();
}

const MARK: Record<VerifyStep["status"], string> = { pass: "ok  ", fail: "FAIL", warn: "warn", skip: "--  " };

export function formatVerifyReport(report: VerifyReport): string {
	const lines = [
		"Autter Runtime verify",
		`  endpoint   ${report.endpoint}`,
		`  service    ${report.service} (environment ${report.environment}${report.release ? `, release ${report.release}` : ", no release"})`,
		`  test id    ${report.traceId}`,
		"",
	];
	for (const step of report.steps) {
		lines.push(`  ${MARK[step.status]} ${step.step.padEnd(9)} ${step.detail}`);
		if (step.status !== "pass" && step.status !== "skip" && step.fix) lines.push(`                 -> ${step.fix}`);
	}
	lines.push("");
	if (report.firstFailure) {
		lines.push(`First failing step: ${report.firstFailure.step}. ${report.firstFailure.fix ?? ""}`.trim());
	} else {
		const warned = report.steps.filter((s) => s.status === "warn").map((s) => s.step);
		lines.push(
			`Delivered: a test event from "${report.service}" was accepted and stored.` +
				(warned.length ? ` Check the warnings: ${warned.join(", ")}.` : "") +
				" It is stored under environment \"" + report.environment + "\" and never opens an issue.",
		);
	}
	return lines.join("\n");
}

export const VERIFY_USAGE = `Usage: npx @autter/runtime-node verify [options]

Sends one tagged test event (a span with an error, and a log record) through
the real path and reads it back, naming the first step that fails:
key, network (DNS/TCP/TLS/HTTP), ingester, storage, auth, ingest, stored,
trace, release, logs. The test event is stored under environment "verify"
and never opens an issue.

Options:
  --endpoint <url>      Ingester base URL (default: $AUTTER_ENDPOINT, $OTEL_EXPORTER_OTLP_ENDPOINT, or https://otlp.autter.dev)
  --key <key>           Server ingest key (default: $AUTTER_RUNTIME_KEY)
  --service <name>      Service name (default: $AUTTER_SERVICE, $OTEL_SERVICE_NAME, or package.json name)
  --environment <name>  Environment for the test event (default: verify)
  --release <id>        Release to check (default: $AUTTER_RELEASE, $GIT_SHA or your platform's commit variable)
  --wait <ms>           How long to wait for the event to be stored (default 20000)
  --timeout <ms>        Per-request timeout (default 5000)
  --json                Machine-readable output

Exit codes: 0 delivered, 1 a step failed, 2 ingester unreachable.`;

export function parseVerifyArgs(argv: string[]): VerifyOptions | { help: true } | { error: string } {
	const options: VerifyOptions = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		const value = () => inline ?? argv[++i];
		const ms = (name: string): number | { error: string } => {
			const n = Number(value());
			return Number.isFinite(n) && n > 0 ? n : { error: `${name} needs a positive number of ms` };
		};
		switch (flag) {
			case "-h":
			case "--help":
				return { help: true };
			case "--endpoint":
				options.endpoint = value();
				break;
			case "--key":
				options.key = value();
				break;
			case "--service":
				options.service = value();
				break;
			case "--environment":
				options.environment = value();
				break;
			case "--release":
				options.release = value();
				break;
			case "--json":
				options.json = true;
				break;
			case "--wait": {
				const n = ms("--wait");
				if (typeof n !== "number") return n;
				options.waitMs = n;
				break;
			}
			case "--timeout": {
				const n = ms("--timeout");
				if (typeof n !== "number") return n;
				options.timeoutMs = n;
				break;
			}
			default:
				return { error: `unknown option ${arg}` };
		}
	}
	return options;
}
