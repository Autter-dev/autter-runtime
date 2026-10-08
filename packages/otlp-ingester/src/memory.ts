import { createHash } from "node:crypto";
import { z } from "zod";
import type { OtlpMetricsRequest } from "./normalize-otlp.js";

export type MemoryMetric = "rss" | "heap_used" | "heap_limit" | "memory_limit" | "heap_after_gc" | "gc_count" | "gc_duration_ms";
export interface MemorySample {
	service: string; environment: string; release: string; instanceId: string;
	metric: MemoryMetric; value: number; observedAt: Date; temporality: "gauge" | "delta" | "cumulative";
}

type Attribute = { key?: string; value?: { stringValue?: string; intValue?: string | number; doubleValue?: number } };
function attrsOf(attributes?: Attribute[]): Map<string, string> {
	return new Map((attributes ?? []).flatMap((a) => {
		const v = a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue;
		return a.key && v !== undefined ? [[a.key, String(v)]] : [];
	}));
}
function metricOf(name: string, attrs: Map<string, string>): MemoryMetric | null {
	switch (name) {
		case "autter.process.memory.rss": case "process.runtime.nodejs.memory.rss": return "rss";
		case "autter.process.memory.heap.used": case "process.runtime.nodejs.memory.heap.used": return "heap_used";
		case "autter.process.memory.heap.limit": case "process.runtime.nodejs.memory.heap.limit": return "heap_limit";
		case "autter.process.memory.limit": case "container.memory.limit": return "memory_limit";
		case "autter.process.memory.heap.after_gc": return "heap_after_gc";
		case "autter.process.gc.count": case "process.runtime.nodejs.gc.count": return "gc_count";
		case "autter.process.gc.duration": case "process.runtime.nodejs.gc.duration": return "gc_duration_ms";
		case "process.memory.usage": {
			const type = attrs.get("type") ?? attrs.get("state");
			return type === "rss" || type === "physical" ? "rss" : type === "heap_used" ? "heap_used" : null;
		}
		default: return null;
	}
}

export function normalizeMemoryMetrics(request: OtlpMetricsRequest): MemorySample[] {
	const out: MemorySample[] = [];
	const now = Date.now();
	for (const rm of request.resourceMetrics ?? []) {
		const resource = attrsOf(rm.resource?.attributes);
		const instanceId = resource.get("service.instance.id")?.slice(0, 128) ?? "";
		const service = resource.get("service.name")?.slice(0, 200) ?? "";
		if (!instanceId || !service) continue;
		const environment = (resource.get("deployment.environment.name") ?? resource.get("deployment.environment") ?? "production").slice(0, 100);
		const release = (resource.get("service.version") ?? "").slice(0, 200);
		for (const scope of rm.scopeMetrics ?? []) for (const metric of scope.metrics ?? []) {
			const name = metric.name ?? "";
			const points = metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? [];
			for (const point of points) {
				const kind = metricOf(name, attrsOf(point.attributes));
				if (!kind) continue;
				const counter = kind === "gc_count" || kind === "gc_duration_ms";
				const aggregation = metric.sum?.aggregationTemporality;
				const temporality = counter && (aggregation === 2 || aggregation === "AGGREGATION_TEMPORALITY_CUMULATIVE")
					? "cumulative" : counter ? "delta" : "gauge";
				const value = Number(point.asDouble ?? point.asInt);
				let observedMs = 0;
				try { observedMs = Number(BigInt(String(point.timeUnixNano ?? "0")) / 1_000_000n); }
				catch { continue; }
				if (!Number.isFinite(value) || value < 0 || value > 1e15 || observedMs < now - 30 * 86400_000 || observedMs > now + 300_000) continue;
				const isBytes = kind === "rss" || kind === "heap_used" || kind === "heap_limit" || kind === "memory_limit" || kind === "heap_after_gc";
				const unit = metric.unit ?? "By";
				if (isBytes && !["By", "byte", "bytes", "KiBy", "MiBy"].includes(unit)) continue;
				// Standard OTel runtimes report GC duration in seconds; Autter uses ms.
				out.push({ service, environment, release, instanceId, metric: kind,
					value: isBytes ? value * (unit === "KiBy" ? 1024 : unit === "MiBy" ? 1048576 : 1)
						: kind === "gc_duration_ms" && unit === "s" ? value * 1000 : value,
					observedAt: new Date(observedMs), temporality });
				if (out.length >= 5000) return out;
			}
		}
	}
	return out;
}

export const platformEventSchema = z.object({
	service: z.string().regex(/^[a-zA-Z0-9._-]{1,200}$/),
	environment: z.string().min(1).max(100).default("production"),
	release: z.string().max(200).default(""),
	instanceId: z.string().min(1).max(128),
	platform: z.enum(["ecs", "kubernetes", "other"]),
	kind: z.enum(["oom_kill", "restart"]),
	occurredAt: z.string().datetime(),
});
export type PlatformEvent = z.infer<typeof platformEventSchema> & { eventId: string };
export function normalizePlatformEvent(input: z.infer<typeof platformEventSchema>): PlatformEvent | null {
	const time = Date.parse(input.occurredAt);
	if (time < Date.now() - 30 * 86400_000 || time > Date.now() + 300_000) return null;
	const eventId = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);
	return { ...input, eventId };
}

export function memoryTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_memory_samples (
		org_id String, repository_id String, service LowCardinality(String),
		environment LowCardinality(String), release String DEFAULT '', instance_id String,
		metric LowCardinality(String), value Float64, temporality LowCardinality(String) DEFAULT 'gauge',
		observed_at DateTime64(3, 'UTC')
	) ENGINE = ReplacingMergeTree PARTITION BY toDate(observed_at)
	ORDER BY (org_id, repository_id, service, environment, instance_id, metric, observed_at)
	TTL toDateTime(observed_at) + INTERVAL 14 DAY`;
}
export function platformEventTableDDL(db: string): string {
	return `CREATE TABLE IF NOT EXISTS ${db}.runtime_platform_events (
		org_id String, repository_id String, event_id String, service LowCardinality(String),
		environment LowCardinality(String), release String DEFAULT '', instance_id String,
		platform LowCardinality(String), kind LowCardinality(String), occurred_at DateTime64(3, 'UTC')
	) ENGINE = ReplacingMergeTree PARTITION BY toDate(occurred_at)
	ORDER BY (org_id, repository_id, event_id)
	TTL toDateTime(occurred_at) + INTERVAL 30 DAY`;
}
