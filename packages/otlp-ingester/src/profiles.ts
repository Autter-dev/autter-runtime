import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs";

// Only the pprof fields needed for a bounded, symbolized CPU sample index.
const schema = protobuf.parse(`syntax = "proto3";
message Profile {
  repeated ValueType sample_type = 1;
  repeated Sample sample = 2;
  repeated Location location = 4;
  repeated Function function = 5;
  repeated string string_table = 6;
  int64 time_nanos = 9;
}
message ValueType { int64 type = 1; int64 unit = 2; }
message Sample { repeated uint64 location_id = 1 [packed=true]; repeated int64 value = 2 [packed=true]; }
message Location { uint64 id = 1; repeated Line line = 4; }
message Line { uint64 function_id = 1; int64 line = 2; }
message Function { uint64 id = 1; int64 name = 2; int64 system_name = 3; int64 filename = 4; }
`).root.lookupType("Profile");

export interface ProfileSample {
	profileId: string;
	sampleIndex: number;
	service: string;
	environment: string;
	release: string;
	traceId: string;
	observedAt: Date;
	sampleType: string;
	unit: string;
	stack: string[];
	value: number;
}

export function profileTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_profile_samples (
		org_id String, repository_id String, profile_id String, sample_index UInt16,
		service LowCardinality(String), environment LowCardinality(String), release String,
		trace_id String DEFAULT '', observed_at DateTime64(3, 'UTC'),
		sample_type LowCardinality(String), unit LowCardinality(String),
		stack Array(String), value UInt64
	) ENGINE = MergeTree PARTITION BY toDate(observed_at)
	ORDER BY (org_id, repository_id, service, environment, release, observed_at, profile_id)
	TTL toDateTime(observed_at) + INTERVAL 7 DAY`;
}

export function decodeProfile(body: Buffer, meta: {
	service: string; environment: string; release: string; traceId: string;
}): ProfileSample[] {
	if (body.length === 0 || body.length > 1024 * 1024) throw new Error("invalid profile size");
	const payload = body[0] === 0x1f && body[1] === 0x8b
		? gunzipSync(body, { maxOutputLength: 1024 * 1024 }) : body;
	const profile = schema.toObject(schema.decode(payload), { longs: String, arrays: true }) as {
		sampleType?: Array<{ type?: string; unit?: string }>;
		sample?: Array<{ locationId?: string[]; value?: string[] }>;
		location?: Array<{ id?: string; line?: Array<{ functionId?: string }> }>;
		function?: Array<{ id?: string; name?: string }>;
		stringTable?: string[];
		timeNanos?: string;
	};
	const strings = profile.stringTable ?? [];
	const locations = new Map((profile.location ?? []).map((location) => [location.id, location]));
	const functions = new Map((profile.function ?? []).map((fn) => [fn.id, fn]));
	const type = profile.sampleType?.[0];
	const observedMs = Number(BigInt(profile.timeNanos ?? "0") / 1_000_000n);
	const observedAt = observedMs > 0 && observedMs <= Date.now() + 300_000 ? new Date(observedMs) : new Date();
	const profileId = createHash("sha256").update(body).digest("hex").slice(0, 32);
	const samples: ProfileSample[] = [];
	for (const [sampleIndex, sample] of (profile.sample ?? []).slice(0, 1000).entries()) {
		const stack = (sample.locationId ?? []).slice(0, 64).flatMap((id) => {
			const fnId = locations.get(id)?.line?.[0]?.functionId;
			const name = fnId ? strings[Number(functions.get(fnId)?.name ?? 0)] : undefined;
			return name ? [name.slice(0, 200)] : [];
		});
		const value = Number(sample.value?.[0] ?? 0);
		if (!stack.length || !Number.isSafeInteger(value) || value <= 0) continue;
		samples.push({ profileId, sampleIndex, ...meta, observedAt,
			sampleType: (strings[Number(type?.type ?? 0)] ?? "samples").slice(0, 80),
			unit: (strings[Number(type?.unit ?? 0)] ?? "count").slice(0, 40),
			stack, value });
	}
	return samples;
}
