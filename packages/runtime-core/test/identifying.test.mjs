// Identifying attributes (client address, raw user agent, host, command
// line): the shared list and filter the Node SDK's exporters use. The
// Python adapter and the ingester hold the same list, checked against the
// same vectors (test-vectors/redaction.json, `identifying`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	DROP_ATTRIBUTES_ENV,
	dropAttributesFromEnv,
	IDENTIFYING_ATTRIBUTE_KEYS,
	KEEP_IDENTIFYING_ATTRIBUTES_ENV,
	keepIdentifyingFromEnv,
	makeIdentifyingAttributeFilter,
} from "../dist/index.js";

const vectors = JSON.parse(
	readFileSync(new URL("../../../test-vectors/redaction.json", import.meta.url), "utf8"),
).identifying;

const sample = () => ({
	...Object.fromEntries(vectors.drop.map((key) => [key, `v:${key}`])),
	...Object.fromEntries(vectors.keep.map((key) => [key, `v:${key}`])),
});

test("the list is exactly the shared vectors' drop list", () => {
	assert.deepEqual([...IDENTIFYING_ATTRIBUTE_KEYS].sort(), [...vectors.drop].sort());
	assert.equal(new Set(IDENTIFYING_ATTRIBUTE_KEYS).size, IDENTIFYING_ATTRIBUTE_KEYS.length, "no duplicates");
	for (const key of vectors.keep) assert.ok(!IDENTIFYING_ATTRIBUTE_KEYS.includes(key), `${key} must not be dropped`);
	assert.ok(Object.isFrozen(IDENTIFYING_ATTRIBUTE_KEYS));
});

test("by default every listed key is dropped and every other key survives", () => {
	const filter = makeIdentifyingAttributeFilter();
	const input = sample();
	const out = filter.apply(input);
	assert.deepEqual(Object.keys(out).sort(), [...vectors.keep].sort());
	for (const key of vectors.keep) assert.equal(out[key], `v:${key}`);
	assert.equal(out["service.instance.id"], "v:service.instance.id");
	// Never mutates its input.
	assert.equal(Object.keys(input).length, vectors.drop.length + vectors.keep.length);
});

test("an attribute bag without identifying keys is returned as is", () => {
	const filter = makeIdentifyingAttributeFilter();
	const attributes = { "http.route": "/users/:id", "service.instance.id": "abc" };
	assert.equal(filter.apply(attributes), attributes);
});

test("keep: true keeps everything; a list keeps only its keys", () => {
	const all = makeIdentifyingAttributeFilter(true);
	const input = sample();
	assert.equal(all.apply(input), input);
	assert.equal(all.dropped.size, 0);

	const some = makeIdentifyingAttributeFilter(["http.user_agent", "host.id", "not.a.listed.key"]);
	const out = some.apply(sample());
	assert.equal(out["http.user_agent"], "v:http.user_agent");
	assert.equal(out["host.id"], "v:host.id");
	assert.equal(out["host.name"], "v:host.name");
	assert.equal(out["net.peer.ip"], undefined);
	assert.equal(out["client.address"], undefined);
	assert.equal(out["process.command_args"], undefined);
	assert.equal(out["service.instance.id"], "v:service.instance.id");
	assert.equal(some.dropped.size, vectors.drop.length - 2);

	// false and an empty list are the default.
	assert.equal(makeIdentifyingAttributeFilter(false).dropped.size, vectors.drop.length);
	assert.equal(makeIdentifyingAttributeFilter([]).dropped.size, vectors.drop.length);
});

test("AUTTER_KEEP_IDENTIFYING_ATTRIBUTES: true, false or a comma-separated list", () => {
	assert.equal(KEEP_IDENTIFYING_ATTRIBUTES_ENV, "AUTTER_KEEP_IDENTIFYING_ATTRIBUTES");
	assert.equal(keepIdentifyingFromEnv(undefined), undefined);
	assert.equal(keepIdentifyingFromEnv("  "), undefined);
	for (const raw of ["true", "TRUE", "1", "yes", "on", "all"]) assert.equal(keepIdentifyingFromEnv(raw), true, raw);
	for (const raw of ["false", "0", "no", "off", "none"]) assert.equal(keepIdentifyingFromEnv(raw), false, raw);
	assert.deepEqual(keepIdentifyingFromEnv(" http.user_agent, host.name ,,"), ["http.user_agent", "host.name"]);
});

test("host.name is kept by default; the extra drop list removes it (and wins over keep)", () => {
	assert.ok(!IDENTIFYING_ATTRIBUTE_KEYS.includes("host.name"));
	const input = { "host.name": "web-7f9c", "service.instance.id": "abc", "host.id": "m-1" };
	assert.deepEqual(makeIdentifyingAttributeFilter().apply(input), { "host.name": "web-7f9c", "service.instance.id": "abc" });
	const extra = makeIdentifyingAttributeFilter(undefined, ["host.name"]);
	assert.deepEqual(extra.apply(input), { "service.instance.id": "abc" });
	assert.equal(extra.dropped.size, vectors.drop.length + 1);
	assert.deepEqual(makeIdentifyingAttributeFilter(true, ["host.name"]).apply(input), { "service.instance.id": "abc", "host.id": "m-1" });
	assert.deepEqual(makeIdentifyingAttributeFilter(["host.name"], ["host.name"]).apply({ "host.name": "x" }), {});

	assert.equal(DROP_ATTRIBUTES_ENV, "AUTTER_DROP_ATTRIBUTES");
	assert.equal(dropAttributesFromEnv(undefined), undefined);
	assert.equal(dropAttributesFromEnv(" , "), undefined);
	assert.deepEqual(dropAttributesFromEnv("host.name, k8s.pod.name"), ["host.name", "k8s.pod.name"]);
});
