import {
	SpanKind,
	SpanStatusCode,
	type Attributes,
	type Span,
} from "@opentelemetry/api";
import { autterLlmTracer } from "./server.js";

/**
 * One-line LLM client auto-instrumentation:
 *
 *   const openai = instrumentLlmClient(new OpenAI());
 *
 * Wraps a provider SDK instance (OpenAI, Anthropic, Google GenAI, or any
 * client with the same call shapes) in a deep proxy. Every model invocation —
 * a method like `create`/`stream`/`generateContent` called with an object
 * argument carrying a `model` — is recorded as a gen_ai span on the
 * always-recorded pipe: model, tokens, latency, errors, and (ingester-side)
 * USD cost. Streaming responses are supported: the span stays open until the
 * stream is consumed, picking up usage from the final chunks.
 *
 * Nothing about the client's behaviour changes; methods run with the
 * original `this` (SDK private fields keep working) and results pass
 * through untouched apart from the stream wrapper.
 */

export interface InstrumentLlmOptions {
	/** Provider id ("openai", "anthropic", …). Default: detected from the client. */
	provider?: string;
	/** Opaque end-user id (never an email) — static or resolved per call. */
	userId?: string | (() => string | undefined);
	/** Extra attributes for every span from this client. */
	attributes?: Attributes;
}

// Method names that perform a model invocation across the major SDKs.
// Gated together with an object argument carrying `model`, so a lookalike
// method elsewhere on the client doesn't produce junk spans.
const CALL_METHODS = new Set([
	"create", // openai chat/completions/embeddings/responses, anthropic messages
	"stream", // anthropic messages.stream
	"generateContent",
	"generateContentStream", // google genai
	"embedContent",
	"batchEmbedContents",
	"parse", // openai beta structured outputs
]);

function detectProvider(client: object): string {
	const name = client.constructor?.name?.toLowerCase() ?? "";
	for (const known of ["openai", "anthropic", "mistral", "groq", "cohere"]) {
		if (name.includes(known)) return known;
	}
	if (name.includes("google") || name.includes("genai")) return "google";
	const baseUrl = String(
		(client as { baseURL?: unknown; baseUrl?: unknown }).baseURL ??
			(client as { baseUrl?: unknown }).baseUrl ??
			"",
	);
	const host = baseUrl.match(/https?:\/\/([^/]+)/)?.[1] ?? "";
	if (host.includes("openai")) return "openai";
	if (host.includes("anthropic")) return "anthropic";
	if (host.includes("googleapis")) return "google";
	if (host.includes("mistral")) return "mistral";
	if (host.includes("groq")) return "groq";
	return "unknown";
}

interface UsageShape {
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	responseModel: string | undefined;
}

/** Probe the known usage shapes: OpenAI chat + responses, Anthropic, Google. */
function extractUsage(result: unknown): UsageShape {
	const r = result as {
		usage?: Record<string, number>;
		usageMetadata?: Record<string, number>;
		message?: { usage?: Record<string, number> };
		model?: unknown;
		modelVersion?: unknown;
	} | null;
	const usage = r?.usage ?? r?.message?.usage;
	const meta = r?.usageMetadata;
	const input =
		usage?.prompt_tokens ??
		usage?.input_tokens ??
		meta?.promptTokenCount ??
		undefined;
	const output =
		usage?.completion_tokens ??
		usage?.output_tokens ??
		meta?.candidatesTokenCount ??
		undefined;
	const responseModel = r?.model ?? r?.modelVersion;
	return {
		inputTokens: typeof input === "number" ? input : undefined,
		outputTokens: typeof output === "number" ? output : undefined,
		responseModel:
			typeof responseModel === "string" ? responseModel : undefined,
	};
}

function applyUsage(span: Span, usage: UsageShape): void {
	if (usage.inputTokens !== undefined) {
		span.setAttribute("gen_ai.usage.input_tokens", usage.inputTokens);
	}
	if (usage.outputTokens !== undefined) {
		span.setAttribute("gen_ai.usage.output_tokens", usage.outputTokens);
	}
	if (usage.responseModel) {
		span.setAttribute("gen_ai.response.model", usage.responseModel);
	}
}

function endWithError(span: Span, err: unknown): void {
	if (err instanceof Error) span.recordException(err);
	span.setStatus({
		code: SpanStatusCode.ERROR,
		message: err instanceof Error ? err.message : String(err),
	});
	span.end();
}

/**
 * Wrap a streaming result so the span ends when the stream finishes (or
 * errors), accumulating usage from the chunks that carry it: OpenAI's final
 * chunk (with `stream_options: { include_usage: true }`), Anthropic's
 * message_start/message_delta events, Google's per-chunk usageMetadata.
 */
function wrapStream<T extends object>(stream: T, span: Span): T {
	let ended = false;
	const seen: UsageShape = {
		inputTokens: undefined,
		outputTokens: undefined,
		responseModel: undefined,
	};
	const finish = (err?: unknown) => {
		if (ended) return;
		ended = true;
		applyUsage(span, seen);
		span.setAttribute("autter.llm.streamed", true);
		if (err !== undefined) {
			endWithError(span, err);
		} else {
			span.setStatus({ code: SpanStatusCode.OK });
			span.end();
		}
	};
	return new Proxy(stream, {
		get(target, prop, receiver) {
			if (prop === Symbol.asyncIterator) {
				return () => {
					const inner = (
						target as unknown as AsyncIterable<unknown>
					)[Symbol.asyncIterator]();
					return {
						async next(): Promise<IteratorResult<unknown>> {
							try {
								const step = await inner.next();
								if (!step.done) {
									const usage = extractUsage(step.value);
									if (usage.inputTokens !== undefined) seen.inputTokens = usage.inputTokens;
									if (usage.outputTokens !== undefined) seen.outputTokens = usage.outputTokens;
									if (usage.responseModel) seen.responseModel = usage.responseModel;
								} else {
									finish();
								}
								return step;
							} catch (err) {
								finish(err);
								throw err;
							}
						},
						async return(value?: unknown): Promise<IteratorResult<unknown>> {
							finish();
							return inner.return
								? inner.return(value)
								: { done: true, value: undefined };
						},
						async throw(err?: unknown): Promise<IteratorResult<unknown>> {
							finish(err);
							if (inner.throw) return inner.throw(err);
							throw err;
						},
					};
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export function instrumentLlmClient<T extends object>(
	client: T,
	options?: InstrumentLlmOptions,
): T {
	const provider = (options?.provider ?? detectProvider(client)).toLowerCase();
	const proxied = new WeakMap<object, object>();

	function resolveUserId(): string | undefined {
		return typeof options?.userId === "function"
			? options.userId()
			: options?.userId;
	}

	function traceCall(
		fn: (...args: unknown[]) => unknown,
		self: object,
		callPath: string,
		args: unknown[],
	): unknown {
		const request = args[0] as { model: string; stream?: unknown };
		const operation = /embed/i.test(callPath) ? "embeddings" : "chat";
		const userId = resolveUserId();
		const span = autterLlmTracer().startSpan(`${operation} ${request.model}`, {
			kind: SpanKind.CLIENT,
			attributes: {
				"gen_ai.operation.name": operation,
				"gen_ai.provider.name": provider,
				"gen_ai.system": provider,
				"gen_ai.request.model": request.model,
				...(userId ? { "autter.user_id": userId } : {}),
				...options?.attributes,
			},
		});
		let result: unknown;
		try {
			result = fn.apply(self, args);
		} catch (err) {
			endWithError(span, err);
			throw err;
		}
		if (!(result instanceof Promise)) {
			// Anthropic's .stream() returns a MessageStream synchronously.
			if (result && typeof result === "object" && Symbol.asyncIterator in result) {
				return wrapStream(result, span);
			}
			applyUsage(span, extractUsage(result));
			span.setStatus({ code: SpanStatusCode.OK });
			span.end();
			return result;
		}
		return result.then(
			(resolved) => {
				if (
					resolved &&
					typeof resolved === "object" &&
					Symbol.asyncIterator in resolved
				) {
					return wrapStream(resolved, span);
				}
				applyUsage(span, extractUsage(resolved));
				span.setStatus({ code: SpanStatusCode.OK });
				span.end();
				return resolved;
			},
			(err) => {
				endWithError(span, err);
				throw err;
			},
		);
	}

	function deepProxy<O extends object>(target: O, path = ""): O {
		const cached = proxied.get(target);
		if (cached) return cached as O;
		const proxy = new Proxy(target, {
			get(t, prop, receiver) {
				const value = Reflect.get(t, prop, receiver);
				if (typeof prop === "symbol") return value;
				const propPath = path ? `${path}.${prop}` : prop;
				if (typeof value === "function") {
					if (CALL_METHODS.has(prop)) {
						return (...args: unknown[]) => {
							const first = args[0] as { model?: unknown } | undefined;
							if (first && typeof first === "object" && typeof first.model === "string") {
								// Invoke with the RAW object as `this` — SDK classes use
								// private fields, which break under a proxied receiver.
								return traceCall(
									value as (...a: unknown[]) => unknown,
									t,
									propPath,
									args,
								);
							}
							return (value as (...a: unknown[]) => unknown).apply(t, args);
						};
					}
					return (value as (...a: unknown[]) => unknown).bind(t);
				}
				if (
					value !== null &&
					typeof value === "object" &&
					!(value instanceof Promise)
				) {
					return deepProxy(value as object, propPath);
				}
				return value;
			},
		});
		proxied.set(target, proxy);
		return proxy as O;
	}

	return deepProxy(client);
}
