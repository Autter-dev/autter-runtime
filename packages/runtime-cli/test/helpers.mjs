// Shared test helpers: temp build directories, a real ingester app with an
// in-memory source map store, and a VLQ mappings decoder.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { loadConfig } from "../../otlp-ingester/dist/config.js";
import { createIngesterApp } from "../../otlp-ingester/dist/server.js";

export const SERVER_KEY = "autter_rt_test_server_key";

/** A fresh temp directory with `files` ({ "a/b.js": "content" }) written into it. */
export function tempDir(files = {}) {
	const dir = mkdtempSync(join(tmpdir(), "autter-cli-"));
	writeFiles(dir, files);
	return dir;
}

export function writeFiles(dir, files) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
	}
}

/** sha256 of every file under `dir`, keyed by relative path. */
export function snapshot(dir) {
	const out = {};
	const walk = (d) => {
		for (const name of readdirSync(d)) {
			const full = join(d, name);
			if (statSync(full).isDirectory()) walk(full);
			else out[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
		}
	};
	walk(dir);
	return out;
}

export const read = (dir, path) => readFileSync(join(dir, path), "utf8");
export const readJson = (dir, path) => JSON.parse(read(dir, path));

/** A small hand-written map: line 0 → src/app.ts:0:0, line 1 → src/app.ts:1:2. */
export const SIMPLE_MAP = { version: 3, file: "app.js", sources: ["../src/app.ts"], sourcesContent: ["secret source"], names: [], mappings: "AAAA;AACE" };

/**
 * The real ingester (built dist) with its ClickHouse store replaced by an
 * in-memory one: uploads go through the real routes, auth and validation.
 */
export async function startIngester({ legacy = false, failFirst = 0, rejectUploads = 0 } = {}) {
	const config = {
		...loadConfig(),
		clickhouseUrl: "http://127.0.0.1:8123",
		ingestKeys: [
			{ key: SERVER_KEY, orgId: "org-a", repositoryId: "repo-a", scope: "server" },
			{ key: "autter_rtc_client", orgId: "org-a", repositoryId: "repo-a", scope: "client" },
		],
	};
	const { app, store } = createIngesterApp(config);
	const rows = [];
	const requests = [];
	let failures = failFirst;
	store.insertSourceMap = async (ctx, sourceMap) => {
		rows.push({ tenant: `${ctx.orgId}/${ctx.repositoryId}`, ...sourceMap });
	};
	store.sourceMapsPresent = async (_ctx, check) =>
		check.entries
			.map((entry, index) =>
				rows.some((r) => r.release === check.release && r.filename === entry.filename && r.debugId === entry.debugId && r.contentHash === entry.hash) ? index : -1)
			.filter((index) => index >= 0);
	// Record every request; optionally emulate an old ingester (no check
	// route) or a flaky one, before the real app sees it.
	const server = createServer((req, res) => {
		requests.push({ method: req.method, url: req.url, encoding: req.headers["content-encoding"] ?? null, bytes: Number(req.headers["content-length"] ?? 0) });
		if (legacy && req.url.startsWith("/v1/sourcemaps/check")) {
			req.resume();
			res.writeHead(404).end("not found");
			return;
		}
		if (rejectUploads && req.url === "/v1/sourcemaps") {
			req.resume();
			res.writeHead(rejectUploads).end("request entity too large");
			return;
		}
		if (failures > 0 && req.url === "/v1/sourcemaps") {
			failures--;
			req.resume();
			res.writeHead(503).end("try later");
			return;
		}
		app(req, res);
	});
	server.listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		rows,
		requests,
		uploads: () => requests.filter((r) => r.url === "/v1/sourcemaps"),
		close: () => new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		}),
	};
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode VLQ `mappings` to absolute [genCol, source, line, col, name?] per generated line. */
export function decodeMappings(mappings) {
	const lines = [];
	let source = 0;
	let line = 0;
	let column = 0;
	let name = 0;
	for (const text of mappings.split(";")) {
		const segments = [];
		let genCol = 0;
		for (const seg of text ? text.split(",") : []) {
			const values = [];
			let shift = 0;
			let value = 0;
			for (const ch of seg) {
				const digit = B64.indexOf(ch);
				value += (digit & 31) << shift;
				if (digit & 32) shift += 5;
				else {
					values.push(value & 1 ? -(value >>> 1) : value >>> 1);
					value = 0;
					shift = 0;
				}
			}
			genCol += values[0];
			const out = [genCol];
			if (values.length > 1) {
				source += values[1];
				line += values[2];
				column += values[3];
				out.push(source, line, column);
				if (values.length > 4) {
					name += values[4];
					out.push(name);
				}
			}
			segments.push(out);
		}
		lines.push(segments);
	}
	return lines;
}
