import { lookup } from "node:dns/promises";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { compatRequest } from "./compat.js";

/**
 * Where the path to an ingester breaks: DNS, TCP, TLS or HTTP. Used by
 * `doctor` when the ingester can't be reached and as the first step of
 * `verify`. "Timed out" alone (what an exporter reports) can mean a
 * firewall dropping packets, an IPv6 route that goes nowhere, a proxy
 * that is required but not used, or TLS interception; each step below
 * narrows it to one.
 */

export type ConnectivityStepName = "dns" | "tcp" | "tls" | "http";

export interface ConnectivityStep {
	step: ConnectivityStepName;
	ok: boolean;
	ms: number;
	detail: string;
}

export interface ConnectivityReport {
	ok: boolean;
	host: string;
	port: number;
	steps: ConnectivityStep[];
	/** The first failed step, with what to try. */
	failed?: { step: ConnectivityStepName; detail: string; hint: string };
}

const elapsed = (start: number) => Math.round(performance.now() - start);

function errCode(err: unknown): string {
	const e = err as { code?: unknown; message?: unknown };
	return typeof e?.code === "string" ? e.code : String(e?.message ?? err);
}

function proxyNote(env: NodeJS.ProcessEnv): string {
	const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
	return proxy
		? ` HTTPS_PROXY is set, but Node's HTTP client (and the OTLP exporter) do not use it: if this network only allows traffic through the proxy, allow the ingester host directly or run the app where it can reach it.`
		: "";
}

function connectOnce(
	address: string,
	port: number,
	timeoutMs: number,
	tls: { servername: string } | null,
): Promise<{ ok: true } | { ok: false; code: string }> {
	return new Promise((resolve) => {
		let socket: Socket | undefined;
		const timer = setTimeout(() => {
			socket?.destroy();
			resolve({ ok: false, code: "TIMEOUT" });
		}, timeoutMs);
		const done = (result: { ok: true } | { ok: false; code: string }) => {
			clearTimeout(timer);
			socket?.destroy();
			resolve(result);
		};
		try {
			socket = tls
				? tlsConnect({ host: address, port, servername: tls.servername, ALPNProtocols: ["http/1.1"] }, () => done({ ok: true }))
				: netConnect({ host: address, port }, () => done({ ok: true }));
			socket.on("error", (err) => done({ ok: false, code: errCode(err) }));
		} catch (err) {
			done({ ok: false, code: errCode(err) });
		}
	});
}

const TCP_HINTS: Record<string, string> = {
	TIMEOUT:
		"Packets to this address get no answer: an outbound firewall, security group or egress rule is dropping them, or (for an IPv6 address) the network has no IPv6 route.",
	ECONNREFUSED: "The host answered but nothing listens on this port: check the port in the endpoint, or that the ingester is running.",
	ENETUNREACH: "No route to this network from here (often IPv6 on an IPv4-only network).",
	EHOSTUNREACH: "No route to this host from here.",
};

const TLS_HINTS: Record<string, string> = {
	SELF_SIGNED_CERT_IN_CHAIN:
		"A proxy or security product is intercepting TLS with its own certificate. Point NODE_EXTRA_CA_CERTS at its CA certificate.",
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
		"The certificate's issuer is not trusted here (TLS interception or a private CA). Point NODE_EXTRA_CA_CERTS at that CA certificate.",
	DEPTH_ZERO_SELF_SIGNED_CERT: "The ingester uses a self-signed certificate. Point NODE_EXTRA_CA_CERTS at it.",
	ERR_TLS_CERT_ALTNAME_INVALID: "The certificate is not for this host name: check the endpoint URL.",
	CERT_HAS_EXPIRED: "The ingester's certificate has expired.",
	TIMEOUT: "TCP connected but the TLS handshake never finished: a middlebox may be blocking it.",
};

export async function diagnoseConnectivity(
	endpoint: string,
	options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ConnectivityReport> {
	const timeoutMs = options.timeoutMs ?? 5000;
	const env = options.env ?? process.env;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return {
			ok: false,
			host: endpoint,
			port: 0,
			steps: [],
			failed: { step: "dns", detail: `not a URL: ${endpoint}`, hint: "Use the ingester's base URL, e.g. https://otlp.autter.dev or http://localhost:4318." },
		};
	}
	const host = url.hostname.replace(/^\[|\]$/g, "");
	const secure = url.protocol === "https:";
	const port = Number(url.port) || (secure ? 443 : 80);
	const steps: ConnectivityStep[] = [];
	const report = (failed?: ConnectivityReport["failed"]): ConnectivityReport => ({
		ok: !failed,
		host,
		port,
		steps,
		...(failed ? { failed } : {}),
	});

	// DNS
	let addresses: Array<{ address: string; family: number }>;
	if (isIP(host)) {
		addresses = [{ address: host, family: isIP(host) }];
	} else {
		const start = performance.now();
		try {
			addresses = await lookup(host, { all: true });
			steps.push({ step: "dns", ok: true, ms: elapsed(start), detail: `${host} → ${addresses.map((a) => a.address).join(", ")}` });
		} catch (err) {
			const code = errCode(err);
			const detail = `${host} does not resolve (${code})`;
			steps.push({ step: "dns", ok: false, ms: elapsed(start), detail });
			return report({
				step: "dns",
				detail,
				hint: "Check the host name in the endpoint; on a VPN or in a container, check its DNS settings.",
			});
		}
	}

	// TCP: IPv4 first (an IPv6 address with no route is the classic
	// "DNS resolves but every request times out"), at most three addresses.
	const ordered = [...addresses].sort((a, b) => a.family - b.family).slice(0, 3);
	let reached: string | null = null;
	const tcpFailures: string[] = [];
	let lastCode = "TIMEOUT";
	for (const { address } of ordered) {
		const start = performance.now();
		const result = await connectOnce(address, port, timeoutMs, null);
		if (result.ok) {
			steps.push({ step: "tcp", ok: true, ms: elapsed(start), detail: `connected to ${address}:${port}` });
			reached = address;
			break;
		}
		lastCode = result.code;
		tcpFailures.push(`${address}:${port} ${result.code === "TIMEOUT" ? `timed out after ${timeoutMs} ms` : result.code}`);
	}
	if (tcpFailures.length && reached) {
		steps[steps.length - 1]!.detail += ` (failed first: ${tcpFailures.join("; ")})`;
	}
	if (!reached) {
		const detail = tcpFailures.join("; ");
		steps.push({ step: "tcp", ok: false, ms: 0, detail });
		return report({ step: "tcp", detail, hint: (TCP_HINTS[lastCode] ?? "The connection failed.") + proxyNote(env) });
	}

	// TLS
	if (secure) {
		const start = performance.now();
		const result = await connectOnce(reached, port, timeoutMs, { servername: host });
		if (!result.ok) {
			const detail = `TLS handshake with ${host} failed (${result.code})`;
			steps.push({ step: "tls", ok: false, ms: elapsed(start), detail });
			return report({ step: "tls", detail, hint: TLS_HINTS[result.code] ?? "The TLS handshake failed." });
		}
		steps.push({ step: "tls", ok: true, ms: elapsed(start), detail: `certificate valid for ${host}` });
	}

	// HTTP: any answer from the ingester proves the path; /livez is cheap.
	const start = performance.now();
	const base = endpoint.replace(/\/$/, "");
	const res = await compatRequest("GET", `${base}/livez`, { unref: false, timeoutMs });
	if (!res) {
		const detail = `no HTTP answer from ${base}/livez within ${timeoutMs} ms`;
		steps.push({ step: "http", ok: false, ms: elapsed(start), detail });
		return report({
			step: "http",
			detail,
			hint: "The connection opens but no HTTP response comes back: a proxy or load balancer in front of the ingester may be holding the request." + proxyNote(env),
		});
	}
	steps.push({ step: "http", ok: true, ms: elapsed(start), detail: `GET /livez answered ${res.status}` });
	return report();
}
