import {
	SpanKind,
	SpanStatusCode,
	type Attributes,
	type Span,
} from "@opentelemetry/api";
import { autterLlmTracer, recordError, redactWithActive } from "./server.js";
import { recordOperationAiUsage } from "./logger.js";
import { noteCompatFeature } from "./compat.js";
import {
	extractRawUsage,
	finalizeUsage,
	LLM_CACHE_TOKENS_FEATURE,
	mergeRawUsage,
	USAGE_CONVENTION,
	USAGE_CONVENTION_ATTR,
	usageContractAttributes,
	type NormalizedUsage,
	type RawUsage,
} from "./llm-usage.js";

/**
 * One-line LLM client auto-instrumentation:
 *
 *   const openai = instrumentLlmClient(new OpenAI());
 *
 * Wraps a provider SDK instance (OpenAI, Anthropic, Google GenAI, Bedrock
 * Runtime, OpenRouter through the OpenAI SDK, or any client with the same
 * call shapes) in a deep proxy. Every model invocation — a method like
 * `create`/`stream`/`generateContent` called with an object argument
 * carrying a `model`, or `send(new ConverseCommand({ modelId }))` — is
 * recorded as a gen_ai span on the always-recorded pipe: model, tokens
 * (cache reads, cache writes and reasoning included, normalised to the
 * "total" convention in llm-usage.ts), latency, errors, and (ingester-side)
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
	"stream", // anthropic messages.stream, openai chat.completions.stream / responses.stream
	"generateContent",
	"generateContentStream", // google genai
	"embedContent",
	"batchEmbedContents",
	"parse", // openai beta structured outputs
]);

// AWS SDK v3 Bedrock Runtime: `client.send(new ConverseCommand({ modelId }))`.
const BEDROCK_COMMANDS = /^Converse(Stream)?Command$/;

// Base-URL hosts win over the constructor name: an OpenAI SDK client pointed
// at OpenRouter (or Groq, Mistral, …) is that provider, not "openai".
const HOST_PROVIDERS: [RegExp, string][] = [
	[/(^|\.)openrouter\.ai$/, "openrouter"],
	[/(^|\.)groq\.com$/, "groq"],
	[/(^|\.)mistral\.ai$/, "mistral"],
	[/(^|\.)deepseek\.com$/, "deepseek"],
	[/(^|\.)anthropic\.com$/, "anthropic"],
	[/googleapis\.com$/, "google"],
	[/openai/, "openai"],
];

function detectProvider(client: object): string {
	const baseUrl = String(
		(client as { baseURL?: unknown; baseUrl?: unknown }).baseURL ??
			(client as { baseUrl?: unknown }).baseUrl ??
			"",
	);
	const host = baseUrl.match(/https?:\/\/([^/:]+)/)?.[1]?.toLowerCase() ?? "";
	if (host) {
		for (const [pattern, provider] of HOST_PROVIDERS) {
			if (pattern.test(host)) return provider;
		}
	}
	const name = client.constructor?.name?.toLowerCase() ?? "";
	if (name.includes("bedrockruntime")) return "aws.bedrock";
	for (const known of ["openai", "anthropic", "mistral", "groq", "cohere"]) {
		if (name.includes(known)) return known;
	}
	if (name.includes("google") || name.includes("genai")) return "google";
	return "unknown";
}

/** Set the usage contract (see llm-usage.ts) and the served model on the span. */
function applyUsage(span: Span, raw: RawUsage): NormalizedUsage {
	const usage = finalizeUsage(raw);
	const attributes = usageContractAttributes(usage);
	if (Object.keys(attributes).length) {
		span.setAttributes(attributes);
		noteCompatFeature(LLM_CACHE_TOKENS_FEATURE);
	}
	if (raw.responseModel) {
		span.setAttribute("gen_ai.response.model", raw.responseModel);
	}
	return usage;
}

/** Fold one finished call into the current operation's `autter.operation.ai`. */
function rollUp(model: string, raw: RawUsage, usage: NormalizedUsage): void {
	recordOperationAiUsage({
		model: raw.responseModel ?? model,
		...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
		...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
		...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
		...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
		...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
	});
}

function endWithError(span: Span, err: unknown): void {
	// Provider errors echo request details (API key fragments, prompt
	// snippets, account emails) — recorded with message/stack scrubbed.
	recordError(span, err);
	span.end();
}

/** One-shot finisher shared by the stream wrappers. */
function streamFinisher(span: Span, model: string, seen: RawUsage) {
	let ended = false;
	return (outcome?: { error: unknown } | { failed: true }) => {
		if (ended) return;
		ended = true;
		const usage = applyUsage(span, seen);
		rollUp(model, seen, usage);
		span.setAttribute("autter.llm.streamed", true);
		if (outcome && "error" in outcome) {
			endWithError(span, outcome.error);
		} else if (outcome) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: "LLM stream failed" });
			span.end();
		} else {
			span.setStatus({ code: SpanStatusCode.OK });
			span.end();
		}
	};
}

/**
 * Wrap a streaming result so the span ends when the stream finishes (or
 * errors), accumulating usage from the chunks that carry it: OpenAI's final
 * chunk (with `stream_options: { include_usage: true }`), OpenAI Responses'
 * `response.completed`, Anthropic's message_start/message_delta events,
 * Google's per-chunk usageMetadata, Bedrock's ConverseStream `metadata`.
 */
function wrapStream<T extends object>(
	stream: T,
	span: Span,
	model: string,
	provider: string,
): T {
	const seen: RawUsage = {};
	const finish = streamFinisher(span, model, seen);
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
									mergeRawUsage(seen, extractRawUsage(step.value, provider));
								} else {
									finish();
								}
								return step;
							} catch (err) {
								finish({ error: err });
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
							finish({ error: err });
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

interface EventStreamHelper {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	done(): Promise<void>;
	errored?: boolean;
	finalMessage?: unknown;
	finalChatCompletion?: unknown;
	finalResponse?: unknown;
}

/**
 * The SDKs' stream helpers (Anthropic `messages.stream()` → MessageStream,
 * OpenAI `chat.completions.stream()` → ChatCompletionStream,
 * `responses.stream()` → ResponseStream) read the HTTP stream eagerly from
 * the moment they are created, and are often consumed only through
 * `await stream.finalMessage()` / `.finalResponse()` / `.on("text", …)`,
 * never iterated, so an iterator wrapper would never end the span.
 */
function isEventStreamHelper(value: unknown): value is EventStreamHelper {
	const v = value as Partial<Record<string, unknown>> | null;
	return (
		!!v &&
		typeof v.on === "function" &&
		typeof v.done === "function" &&
		(typeof v.finalMessage === "function" ||
			typeof v.finalChatCompletion === "function" ||
			typeof v.finalResponse === "function")
	);
}

/**
 * Follow a stream helper through its own events and end the span on its
 * `end` event, which both SDKs emit after success, error and abort. No
 * `error`/`abort` listener is added: either would change the SDK's
 * behaviour (an unhandled stream error stops surfacing as an unhandled
 * rejection), so a failure is read from `stream.errored` instead. The
 * stream is returned untouched.
 */
function followEventStream<T extends EventStreamHelper>(
	stream: T,
	span: Span,
	model: string,
	provider: string,
): T {
	const seen: RawUsage = {};
	const finish = streamFinisher(span, model, seen);
	const absorb = (event: unknown) => {
		try {
			mergeRawUsage(seen, extractRawUsage(event, provider));
		} catch {
			/* never break the caller's stream */
		}
	};
	const events: string[] = [];
	if (typeof stream.finalMessage === "function") events.push("streamEvent", "finalMessage");
	if (typeof stream.finalChatCompletion === "function") events.push("chunk", "finalChatCompletion");
	if (typeof stream.finalResponse === "function") events.push("event");
	try {
		for (const event of events) stream.on(event, absorb);
		stream.on("end", () => {
			try {
				finish(stream.errored ? { failed: true } : undefined);
			} catch {
				/* never break the caller's stream */
			}
		});
	} catch {
		// An `on` we don't understand: fall back to the iterator wrapper.
		return wrapStream(stream, span, model, provider);
	}
	return stream;
}

function isAsyncIterable(value: unknown): value is object {
	return !!value && typeof value === "object" && Symbol.asyncIterator in value;
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

	/** Record a non-stream result (or route a stream to its wrapper). */
	function settle(result: unknown, span: Span, model: string, bedrock: boolean): unknown {
		if (isEventStreamHelper(result)) {
			return followEventStream(result, span, model, provider);
		}
		if (isAsyncIterable(result)) {
			return wrapStream(result, span, model, provider);
		}
		// Bedrock ConverseStream: `{ stream: AsyncIterable<event>, $metadata }`.
		const bedrockStream = (result as { stream?: unknown } | null)?.stream;
		if (bedrock && isAsyncIterable(bedrockStream)) {
			return {
				...(result as object),
				stream: wrapStream(bedrockStream, span, model, provider),
			};
		}
		const raw = extractRawUsage(result, provider);
		const usage = applyUsage(span, raw);
		rollUp(model, raw, usage);
		span.setStatus({ code: SpanStatusCode.OK });
		span.end();
		return result;
	}

	function traceCall(
		fn: (...args: unknown[]) => unknown,
		self: object,
		callPath: string,
		args: unknown[],
		model: string,
	): unknown {
		// Only `send` with a Converse command gets here (see callModel).
		const bedrock = callPath === "send" || callPath.endsWith(".send");
		const operation = /embed/i.test(callPath) ? "embeddings" : "chat";
		const userId = resolveUserId();
		const span = autterLlmTracer().startSpan(`${operation} ${model}`, {
			kind: SpanKind.CLIENT,
			attributes: {
				"gen_ai.operation.name": operation,
				"gen_ai.provider.name": provider,
				"gen_ai.system": provider,
				"gen_ai.request.model": model,
				[USAGE_CONVENTION_ATTR]: USAGE_CONVENTION,
				...(userId ? { "autter.user_id": userId } : {}),
				...redactWithActive(options?.attributes),
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
			// Anthropic's .stream() and OpenAI's .stream() helpers return
			// synchronously.
			return settle(result, span, model, bedrock);
		}
		return result.then(
			(resolved) => settle(resolved, span, model, bedrock),
			(err) => {
				endWithError(span, err);
				throw err;
			},
		);
	}

	/** The model a call is for, or undefined when it isn't a model call. */
	function callModel(prop: string, args: unknown[]): string | undefined {
		const first = args[0] as
			| { model?: unknown; input?: { modelId?: unknown } }
			| undefined;
		if (!first || typeof first !== "object") return undefined;
		if (CALL_METHODS.has(prop)) {
			return typeof first.model === "string" ? first.model : undefined;
		}
		if (
			prop === "send" &&
			BEDROCK_COMMANDS.test(first.constructor?.name ?? "") &&
			typeof first.input?.modelId === "string"
		) {
			return first.input.modelId;
		}
		return undefined;
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
					if (CALL_METHODS.has(prop) || prop === "send") {
						return (...args: unknown[]) => {
							const model = callModel(prop, args);
							if (model !== undefined) {
								// Invoke with the RAW object as `this` — SDK classes use
								// private fields, which break under a proxied receiver.
								return traceCall(
									value as (...a: unknown[]) => unknown,
									t,
									propPath,
									args,
									model,
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
