import protobuf from "protobufjs";
import type { OtlpMetricsRequest, OtlpTraceRequest } from "./normalize-otlp.js";

/**
 * OTLP/HTTP protobuf decode (`content-type: application/x-protobuf`) —
 * the default wire format for most OpenTelemetry SDKs (Go, Rust, Python,
 * Java, .NET, and the JS proto exporters).
 *
 * The schema below is a TRIMMED mirror of opentelemetry-proto: only the
 * fields the normaliser reads, with their exact field numbers. Protobuf
 * skips unknown fields during decode, so payloads produced against the
 * full schema parse correctly. Decoded messages are converted to the same
 * structural shape as OTLP/JSON (hex ids, camelCase, stringified 64-bit
 * ints) and fed through the existing normaliser.
 */

const PROTO = `
syntax = "proto3";
package otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
  }
}
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }

message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message ScopeSpans { repeated Span spans = 2; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  bytes parent_span_id = 4;
  string name = 5;
  int32 kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  repeated Event events = 11;
  Status status = 15;
  message Event {
    fixed64 time_unix_nano = 1;
    string name = 2;
    repeated KeyValue attributes = 3;
  }
}
message Status { string message = 2; int32 code = 3; }

message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message ScopeMetrics { repeated Metric metrics = 2; }
message Metric {
  string name = 1;
  string unit = 3;
  Sum sum = 7;
  Histogram histogram = 9;
}
message Sum { repeated NumberDataPoint data_points = 1; }
message NumberDataPoint {
  fixed64 time_unix_nano = 3;
  double as_double = 4;
  sfixed64 as_int = 6;
  repeated KeyValue attributes = 7;
}
message Histogram { repeated HistogramDataPoint data_points = 1; }
message HistogramDataPoint {
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  optional double sum = 5;
  repeated KeyValue attributes = 9;
}
`;

const root = protobuf.parse(PROTO).root;
const TraceRequest = root.lookupType("otlp.ExportTraceServiceRequest");
const MetricsRequest = root.lookupType("otlp.ExportMetricsServiceRequest");

const TO_OBJECT_OPTIONS: protobuf.IConversionOptions = {
	longs: String, // 64-bit ints → strings (matches OTLP/JSON)
	defaults: false,
};

function hexifyIds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(hexifyIds);
	if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (
				(k === "traceId" || k === "spanId" || k === "parentSpanId") &&
				v instanceof Uint8Array
			) {
				out[k] = Buffer.from(v).toString("hex");
			} else {
				out[k] = hexifyIds(v);
			}
		}
		return out;
	}
	return value;
}

export function decodeTraceRequest(body: Buffer): OtlpTraceRequest {
	const message = TraceRequest.decode(body);
	return hexifyIds(
		TraceRequest.toObject(message, TO_OBJECT_OPTIONS),
	) as OtlpTraceRequest;
}

export function decodeMetricsRequest(body: Buffer): OtlpMetricsRequest {
	const message = MetricsRequest.decode(body);
	return hexifyIds(
		MetricsRequest.toObject(message, TO_OBJECT_OPTIONS),
	) as OtlpMetricsRequest;
}
