/**
 * Structured, coded errors shared by every Autter Runtime server SDK.
 *
 *   export const billingErrors = defineRuntimeErrors("billing", {
 *     declined: { status: 402, message: "Payment declined", expected: true,
 *                 why: "The card issuer rejected the charge",
 *                 fix: "Ask the customer for another card" },
 *     limit: ({ plan }: { plan: string }) => ({ status: 429, message: `Plan ${plan} limit reached` }),
 *   });
 *   throw billingErrors.limit({ plan: "free" });   // code "billing.limit"
 *
 * A code groups every occurrence into one issue (scheme "code-v1"), so codes
 * must be stable, namespaced and low-cardinality: never ids, user data or
 * secrets. Anything not matching CODE_PATTERN is dropped and the error
 * groups by message exactly as before.
 */

/** `namespace.key` with up to four segments, lower-case, max 80 characters. */
export const CODE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/;
export const CODE_MAX_LENGTH = 80;
const WHY_MAX = 1000;
const FIX_MAX = 1000;
const LINK_MAX = 500;
const CAUSE_DEPTH = 5;

export function isValidErrorCode(code: unknown): code is string {
	return (
		typeof code === "string" &&
		code.length <= CODE_MAX_LENGTH &&
		CODE_PATTERN.test(code)
	);
}

const warned = new Set<string>();
/** One console warning per distinct invalid code (capped, never throws). */
function warnInvalidCode(code: unknown): void {
	const key = String(code).slice(0, 120);
	if (warned.has(key) || warned.size >= 50) return;
	warned.add(key);
	try {
		console.warn(
			`[autter-runtime] error code ${JSON.stringify(key)} does not match ${CODE_PATTERN} (max ${CODE_MAX_LENGTH} chars); it is dropped and the error groups by message`,
		);
	} catch {
		/* console unavailable */
	}
}

export interface RuntimeErrorDefinition {
	/** Human-readable message. Safe to show to clients. */
	message: string;
	/** HTTP-ish status. Default 500 when the error reaches a response. */
	status?: number;
	/** Expected business failure (decline, validation): recorded, never an incident. */
	expected?: boolean;
	/** Declared cause, ≤ 1000 chars. Treated as a hypothesis by Autter's RCA. */
	why?: string;
	/** Declared remedy, ≤ 1000 chars. */
	fix?: string;
	/** Docs link, ≤ 500 chars. */
	link?: string;
}

export interface RuntimeErrorExtras {
	/** Underlying error; becomes `exception.cause.N.*` (max 5 levels). */
	cause?: unknown;
	/** Debug-only details: redacted and attached to the span only, never to logs or client responses. */
	internal?: Record<string, unknown>;
	/** Override the catalog message for this throw. */
	message?: string;
}

export interface RuntimeErrorOptions extends RuntimeErrorDefinition {
	/** Stable namespaced code, e.g. "inventory.reservation_timeout". */
	code?: string;
	/** Underlying error; becomes `exception.cause.N.*` (max 5 levels). */
	cause?: unknown;
	/** Debug-only details: redacted and attached to the span only, never to logs or client responses. */
	internal?: Record<string, unknown>;
}

/** The fields Autter reads from any error (duck-typed). */
export interface RuntimeErrorLike {
	message?: string;
	code?: string;
	why?: string;
	fix?: string;
	link?: string;
	status?: number;
	expected?: boolean;
}

export class RuntimeError extends Error implements RuntimeErrorLike {
	readonly code?: string;
	readonly why?: string;
	readonly fix?: string;
	readonly link?: string;
	readonly status?: number;
	readonly expected?: boolean;
	/** Non-enumerable so JSON.stringify / loggers never serialise it. */
	declare readonly internal?: Record<string, unknown>;

	constructor(options: RuntimeErrorOptions | string) {
		const opts: RuntimeErrorOptions =
			typeof options === "string" ? { message: options } : options;
		super(
			opts.message,
			opts.cause !== undefined ? { cause: opts.cause } : undefined,
		);
		this.name = "RuntimeError";
		if (opts.code !== undefined) {
			if (isValidErrorCode(opts.code)) this.code = opts.code;
			else warnInvalidCode(opts.code);
		}
		if (typeof opts.why === "string") this.why = opts.why.slice(0, WHY_MAX);
		if (typeof opts.fix === "string") this.fix = opts.fix.slice(0, FIX_MAX);
		if (typeof opts.link === "string") this.link = opts.link.slice(0, LINK_MAX);
		if (typeof opts.status === "number" && Number.isFinite(opts.status))
			this.status = Math.trunc(opts.status);
		if (typeof opts.expected === "boolean") this.expected = opts.expected;
		if (opts.internal !== undefined)
			Object.defineProperty(this, "internal", {
				value: opts.internal,
				enumerable: false,
				writable: false,
				configurable: true,
			});
	}

	/** Client-safe JSON (what `toClientError` returns, minus the wrapper). */
	toJSON(): Record<string, unknown> {
		return toClientError(this).error;
	}
}

type CatalogEntry =
	| RuntimeErrorDefinition
	// biome-ignore lint/suspicious/noExplicitAny: catalog factories take arbitrary argument shapes
	| ((args: any) => RuntimeErrorDefinition);

/** A typed factory for one catalog entry; `.code` is the namespaced code. */
export type RuntimeErrorFactory<E> = E extends (
	args: infer A,
) => RuntimeErrorDefinition
	? ((args: A, extras?: RuntimeErrorExtras) => RuntimeError) & {
			readonly code: string;
		}
	: ((extras?: RuntimeErrorExtras) => RuntimeError) & {
			readonly code: string;
		};

export type RuntimeErrorCatalog<C extends Record<string, CatalogEntry>> = {
	readonly [K in keyof C]: RuntimeErrorFactory<C[K]>;
};

/**
 * Build typed error factories from a catalog. Each key becomes the code
 * `${namespace}.${key}`; an invalid resulting code is dropped with a
 * one-time warning (the factory still produces a normal RuntimeError).
 */
export function defineRuntimeErrors<const C extends Record<string, CatalogEntry>>(
	namespace: string,
	catalog: C,
): RuntimeErrorCatalog<C> {
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(catalog)) {
		const code = `${namespace}.${key}`;
		const valid = isValidErrorCode(code);
		if (!valid) warnInvalidCode(code);
		const build = (definition: RuntimeErrorDefinition, extras?: RuntimeErrorExtras) => {
			const error = new RuntimeError({
				...definition,
				...(extras?.message !== undefined ? { message: extras.message } : {}),
				...(valid ? { code } : {}),
				...(extras?.cause !== undefined ? { cause: extras.cause } : {}),
				...(extras?.internal !== undefined ? { internal: extras.internal } : {}),
			});
			// Point the stack at the throw site, not this factory.
			const captureStackTrace = (
				Error as unknown as {
					captureStackTrace?: (target: object, ctor?: unknown) => void;
				}
			).captureStackTrace;
			captureStackTrace?.(error, factory);
			return error;
		};
		const factory =
			typeof entry === "function"
				? (args: unknown, extras?: RuntimeErrorExtras) =>
						build((entry as (a: unknown) => RuntimeErrorDefinition)(args), extras)
				: (extras?: RuntimeErrorExtras) =>
						build(entry as RuntimeErrorDefinition, extras);
		Object.defineProperty(factory, "code", { value: code, enumerable: true });
		out[key] = factory;
	}
	return out as RuntimeErrorCatalog<C>;
}

/**
 * True for any error carrying Autter's structured fields — a RuntimeError,
 * or ANY object with a string `code`/`why`/`fix`/`link`, a numeric `status`
 * (or `statusCode`) or a boolean `expected`. Existing error classes benefit
 * without being rewritten.
 */
export function isRuntimeErrorLike(err: unknown): err is RuntimeErrorLike {
	if (err instanceof RuntimeError) return true;
	if (!err || typeof err !== "object") return false;
	const e = err as Record<string, unknown>;
	return (
		typeof e.code === "string" ||
		typeof e.why === "string" ||
		typeof e.fix === "string" ||
		typeof e.link === "string" ||
		typeof e.status === "number" ||
		typeof e.statusCode === "number" ||
		typeof e.expected === "boolean"
	);
}

function field(err: unknown, key: string): unknown {
	if (!err || typeof err !== "object") return undefined;
	try {
		return (err as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
}

/** The valid code of an error, or undefined. Foreign codes (ECONNREFUSED,
 * 42P01, …) are silently ignored; RuntimeErrors already warned at construction. */
export function errorCodeOf(err: unknown): string | undefined {
	const code = field(err, "code");
	return isValidErrorCode(code) ? code : undefined;
}

/** HTTP-ish status of an error (`status`, then `statusCode`), or undefined. */
export function errorStatusOf(err: unknown): number | undefined {
	for (const key of ["status", "statusCode"]) {
		const status = field(err, key);
		if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
			return status;
	}
	return undefined;
}

export function isExpectedError(err: unknown): boolean {
	return field(err, "expected") === true;
}

export interface ErrorAttributeOptions {
	/** Also emit `exception.cause.N.*` for the cause chain (default true). */
	causes?: boolean;
}

/**
 * Wire attributes for an error: `autter.error.code|why|fix|link|status|expected`
 * and `exception.cause.N.type|message|code` (N = 1..5). Never includes
 * `internal` — see `errorInternal`.
 */
export function errorAttributes(
	err: unknown,
	options: ErrorAttributeOptions = {},
): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	if (!err || typeof err !== "object") return out;
	const code = errorCodeOf(err);
	if (code) out["autter.error.code"] = code;
	const why = field(err, "why");
	if (typeof why === "string" && why) out["autter.error.why"] = why.slice(0, WHY_MAX);
	const fix = field(err, "fix");
	if (typeof fix === "string" && fix) out["autter.error.fix"] = fix.slice(0, FIX_MAX);
	const link = field(err, "link");
	if (typeof link === "string" && link) out["autter.error.link"] = link.slice(0, LINK_MAX);
	const status = errorStatusOf(err);
	if (status !== undefined && isRuntimeErrorLike(err)) out["autter.error.status"] = status;
	const expected = field(err, "expected");
	if (typeof expected === "boolean") out["autter.error.expected"] = expected;
	if (options.causes !== false) {
		let cause = field(err, "cause");
		const seen = new Set<unknown>([err]);
		for (let n = 1; n <= CAUSE_DEPTH && cause !== undefined && cause !== null; n++) {
			if (seen.has(cause)) break;
			seen.add(cause);
			const isError = typeof cause === "object";
			const type = isError
				? String(field(cause, "name") ?? (cause as object).constructor?.name ?? "Error")
				: typeof cause;
			const message = isError ? field(cause, "message") : cause;
			out[`exception.cause.${n}.type`] = type.slice(0, 200);
			out[`exception.cause.${n}.message`] = String(message ?? "").slice(0, 1000);
			const causeCode = field(cause, "code");
			if (typeof causeCode === "string" && causeCode)
				out[`exception.cause.${n}.code`] = causeCode.slice(0, CODE_MAX_LENGTH);
			cause = isError ? field(cause, "cause") : undefined;
		}
	}
	return out;
}

/** The `internal` debug payload of an error (span-only), if any. */
export function errorInternal(err: unknown): Record<string, unknown> | undefined {
	const internal = field(err, "internal");
	return internal && typeof internal === "object" && !Array.isArray(internal)
		? (internal as Record<string, unknown>)
		: undefined;
}

export interface ClientErrorBody {
	error: {
		message: string;
		code?: string;
		why?: string;
		fix?: string;
		link?: string;
		requestId?: string;
	};
}

const GENERIC_MESSAGE = "Internal Server Error";

/**
 * Client-safe JSON body for an error:
 * `{ error: { message, code?, why?, fix?, link?, requestId? } }`.
 * Never includes `internal`, stacks or causes. The message of an
 * unstructured 5xx error (a plain `throw new Error(...)`) is replaced with a
 * generic one, because it was never written for clients.
 */
export function toClientError(err: unknown, requestId?: string): ClientErrorBody {
	const code = errorCodeOf(err);
	const status = errorStatusOf(err);
	const declared =
		err instanceof RuntimeError ||
		code !== undefined ||
		(status !== undefined && status < 500 && isRuntimeErrorLike(err));
	const rawMessage = field(err, "message");
	const message =
		declared && typeof rawMessage === "string" && rawMessage
			? rawMessage.slice(0, 1000)
			: GENERIC_MESSAGE;
	const body: ClientErrorBody["error"] = { message };
	if (code) body.code = code;
	if (declared) {
		const why = field(err, "why");
		if (typeof why === "string" && why) body.why = why.slice(0, WHY_MAX);
		const fix = field(err, "fix");
		if (typeof fix === "string" && fix) body.fix = fix.slice(0, FIX_MAX);
		const link = field(err, "link");
		if (typeof link === "string" && link) body.link = link.slice(0, LINK_MAX);
	}
	if (typeof requestId === "string" && requestId) body.requestId = requestId;
	return { error: body };
}

/** Status to answer with: the error's own 4xx/5xx status, else 500. */
export function responseStatusOf(err: unknown): number {
	const status = errorStatusOf(err);
	return status !== undefined && status >= 400 ? status : 500;
}
