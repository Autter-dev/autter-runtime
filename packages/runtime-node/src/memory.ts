import { PerformanceObserver } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { metrics } from "@opentelemetry/api";

/** One bounded set of process gauges per metric export, keyed by service.instance.id. */
export function startMemoryMetrics(): () => void {
	const meter = metrics.getMeter("autter-process-memory");
	const rss = meter.createObservableGauge("autter.process.memory.rss", { unit: "By" });
	const heapUsed = meter.createObservableGauge("autter.process.memory.heap.used", { unit: "By" });
	const heapLimit = meter.createObservableGauge("autter.process.memory.heap.limit", { unit: "By" });
	const containerLimit = meter.createObservableGauge("autter.process.memory.limit", { unit: "By" });
	const afterGc = meter.createObservableGauge("autter.process.memory.heap.after_gc", { unit: "By" });
	const gcCount = meter.createObservableCounter("autter.process.gc.count", { unit: "{collection}" });
	const gcDuration = meter.createObservableCounter("autter.process.gc.duration", { unit: "ms" });
	let collections = 0;
	let durationMs = 0;
	let lastAfterGc: number | null = null;
	const callbacks = [
		[rss, (result: { observe(value: number): void }) => result.observe(process.memoryUsage().rss)],
		[heapUsed, (result: { observe(value: number): void }) => result.observe(process.memoryUsage().heapUsed)],
		[heapLimit, (result: { observe(value: number): void }) => result.observe(getHeapStatistics().heap_size_limit)],
		[containerLimit, (result: { observe(value: number): void }) => {
			const constrained = process.constrainedMemory?.() ?? 0;
			if (constrained > 0) result.observe(constrained);
		}],
		[afterGc, (result: { observe(value: number): void }) => {
			if (lastAfterGc !== null) result.observe(lastAfterGc);
		}],
		[gcCount, (result: { observe(value: number): void }) => result.observe(collections)],
		[gcDuration, (result: { observe(value: number): void }) => result.observe(durationMs)],
	] as const;
	for (const [instrument, callback] of callbacks) instrument.addCallback(callback);
	const observer = new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) {
			collections++;
			durationMs += entry.duration;
			lastAfterGc = process.memoryUsage().heapUsed;
		}
	});
	observer.observe({ entryTypes: ["gc"] });
	return () => {
		observer.disconnect();
		for (const [instrument, callback] of callbacks) instrument.removeCallback(callback);
	};
}
