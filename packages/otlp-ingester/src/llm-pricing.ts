import { readFileSync } from "node:fs";
import { z } from "zod";
import { BUILTIN_LLM_PRICES, LLM_PRICES_AS_OF, type LlmPriceEntry } from "./llm-prices.js";

/**
 * Cache-aware USD cost estimates for LLM calls.
 *
 * Estimation happens once at ingest so cost queries never re-price history
 * (a price change should not rewrite last month's spend), and each estimated
 * row records the table that priced it (`pricing_version`). SDKs can always
 * report the exact figure (`autter.llm.cost_usd`, …), which takes
 * precedence over any estimate (llm.ts).
 *
 * The price table lives in llm-prices.ts. Self-hosted deployments can merge
 * their own prices over it from a JSON file (AUTTER_LLM_PRICES_FILE): an
 * override entry replaces every built-in entry with the same `match`, and
 * new models are added. The file is validated at startup (loadConfig), so a
 * typo stops the ingester with the offending field instead of silently
 * mispricing.
 */

export interface LlmUsageForPricing {
	/** Total prompt tokens, cache reads and cache writes included. */
	inputTokens: number;
	/** Total output tokens, reasoning included. */
	outputTokens: number;
	/** Subset of input read from the provider's prompt cache. */
	cacheReadTokens?: number;
	/** Subset of input written to the prompt cache (every TTL). */
	cacheWriteTokens?: number;
	/** Subset of cache writes at the long TTL (Anthropic 1 h, OpenAI 12 h). */
	cacheWriteLongTokens?: number;
}

export interface LlmCostEstimate {
	costUsd: number;
	/** The price table's `asOf` (built-in), or `override:<asOf>` for a price from the override file. */
	pricingVersion: string;
}

interface ActivePrice extends LlmPriceEntry {
	pricingVersion: string;
}

let activePrices: ActivePrice[] = withVersion(BUILTIN_LLM_PRICES, LLM_PRICES_AS_OF);

function withVersion(entries: LlmPriceEntry[], pricingVersion: string): ActivePrice[] {
	return entries.map((entry) => ({ ...entry, pricingVersion }));
}

/** The built-in table's as-of day (what the dashboard shows as "prices as of"). */
export function llmPricesAsOf(): string {
	return LLM_PRICES_AS_OF;
}

// Router/provider prefixes seen in the wild ahead of the bare model id:
// gateway ids ("openai/gpt-5"), Azure deployments ("azure/gpt-4o"), Bedrock
// inference profiles ("us.anthropic.claude-sonnet-4-...-v1:0",
// "global.anthropic.…"), Vertex ("models/gemini-2.5-pro").
const STRIP_PREFIXES = [
	"openai/",
	"azure/",
	"anthropic/",
	"google/",
	"gemini/",
	"vertex_ai/",
	"vertex/",
	"bedrock/",
	"groq/",
	"xai/",
	"mistral/",
	"meta/",
	"meta-llama/",
	"deepseek/",
	"models/",
	"global.",
	"us.",
	"eu.",
	"apac.",
	"jp.",
	"au.",
	"us-gov.",
	"anthropic.",
	"amazon.",
];

export function normalizeModelId(model: string): string {
	let id = model.trim().toLowerCase();
	let stripped = true;
	while (stripped) {
		stripped = false;
		for (const prefix of STRIP_PREFIXES) {
			if (id.length > prefix.length && id.startsWith(prefix)) {
				id = id.slice(prefix.length);
				stripped = true;
			}
		}
	}
	// Gateways spell Claude versions with a dot ("claude-sonnet-4.5");
	// Anthropic's own ids use a dash.
	if (id.startsWith("claude-")) id = id.replace(/(\d)\.(\d)/g, "$1-$2");
	return id;
}

/**
 * What may follow a price entry's `match` and still be the same model: a
 * dated snapshot (`-20250929`, `-2025-08-07`, Vertex `@20251101`), a
 * Bedrock version (`-v1:0`, `:0`), a Vertex model version (`-001`) or
 * `-latest`, in any combination. Anything else (`.5`, `-pro`, `-mini`,
 * `-codex`, `-preview`) is a different model.
 */
const SNAPSHOT_SUFFIX = /^(?:-\d{8}|-\d{4}-\d{2}-\d{2}|@\d{8}|@\d{3}|-\d{3}|-v\d+(?::\d+)?|:\d+|-latest|@latest)*$/;

function matches(id: string, match: string): boolean {
	return id === match || (id.startsWith(match) && SNAPSHOT_SUFFIX.test(id.slice(match.length)));
}

function utcDay(at: Date): string {
	return Number.isFinite(at.getTime()) ? at.toISOString().slice(0, 10) : "9999-12-31";
}

/**
 * The price that applies to `model` at `at`, or null when no entry
 * matches. Among the entries for the matching id, the latest
 * `effectiveFrom` on or before the call's UTC day wins.
 */
export function lookupLlmPrice(model: string, at: Date = new Date()): ActivePrice | null {
	if (!model) return null;
	const id = normalizeModelId(model);
	const day = utcDay(at);
	let best: ActivePrice | null = null;
	for (const entry of activePrices) {
		if (!matches(id, entry.match)) continue;
		const from = entry.effectiveFrom ?? "";
		if (from > day) continue;
		if (
			!best ||
			entry.match.length > best.match.length ||
			(entry.match.length === best.match.length && from > (best.effectiveFrom ?? ""))
		) {
			best = entry;
		}
	}
	return best;
}

function count(value: number | undefined): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Estimate one call's USD cost, cache-aware, or null when the model is not
 * in the table (unknown models stay unpriced; they are never priced from a
 * sibling or a family).
 *
 *   uncached = max(0, input − cacheRead − cacheWrite)
 *   cost = uncached × input + cacheRead × cacheRead rate
 *        + (cacheWrite − long) × cacheWrite rate + long × cacheWriteLong rate
 *        + output × output rate
 *
 * A missing cache-read or cache-write rate is the full input rate; a missing
 * long-TTL write rate is the short write rate. Token counts of 0 price to 0.
 */
export function estimateLlmCost(
	model: string,
	usage: LlmUsageForPricing,
	at: Date = new Date(),
): LlmCostEstimate | null {
	const price = lookupLlmPrice(model, at);
	if (!price) return null;
	const input = count(usage.inputTokens);
	const output = count(usage.outputTokens);
	const read = count(usage.cacheReadTokens);
	const write = count(usage.cacheWriteTokens);
	const writeLong = Math.min(count(usage.cacheWriteLongTokens), write);
	const uncached = Math.max(0, input - read - write);
	const readRate = price.cacheReadPerMTok ?? price.inputPerMTok;
	const writeRate = price.cacheWritePerMTok ?? price.inputPerMTok;
	const writeLongRate = price.cacheWriteLongPerMTok ?? writeRate;
	const perMillion =
		uncached * price.inputPerMTok +
		read * readRate +
		(write - writeLong) * writeRate +
		writeLong * writeLongRate +
		output * price.outputPerMTok;
	// Nano-dollar rounding: keeps float noise out without losing the cost of
	// a cheap call (a Haiku 5.5 cache read is $0.00000001 a token).
	return { costUsd: Math.round((perMillion / 1e6) * 1e9) / 1e9, pricingVersion: price.pricingVersion };
}

// ── Self-hosted price override (AUTTER_LLM_PRICES_FILE) ────────────────────

const rate = z.number({ error: "must be a number (USD per 1M tokens)" }).finite().nonnegative("must be 0 or more");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be a YYYY-MM-DD date");

const overrideEntrySchema = z
	.object({
		match: z.string().trim().min(1, "must be a model id"),
		inputPerMTok: rate,
		outputPerMTok: rate,
		cacheReadPerMTok: rate.optional(),
		cacheWritePerMTok: rate.optional(),
		cacheWriteLongPerMTok: rate.optional(),
		effectiveFrom: day.optional(),
		source: z.string().optional(),
	})
	.strict();

const overrideFileSchema = z
	.object({
		asOf: day,
		models: z.array(overrideEntrySchema).min(1, "must list at least one model"),
	})
	.strict();

export interface LlmPriceOverrides {
	/** Recorded on rows priced from the file as `override:<asOf>`. */
	asOf: string;
	models: LlmPriceEntry[];
}

/**
 * Parse and validate an override file's text. Throws one Error listing
 * every problem as `<path>: <message>`.
 */
export function parseLlmPriceOverrides(text: string, origin = "AUTTER_LLM_PRICES_FILE"): LlmPriceOverrides {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (err) {
		throw new Error(`${origin}: not valid JSON (${(err as Error).message})`);
	}
	const parsed = overrideFileSchema.safeParse(json);
	if (!parsed.success) {
		const problems = parsed.error.issues.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join(".") : "(file)";
			return `  ${path}: ${issue.message}`;
		});
		throw new Error(`${origin}: invalid price file\n${problems.join("\n")}`);
	}
	const seen = new Set<string>();
	const models: LlmPriceEntry[] = [];
	for (const [index, entry] of parsed.data.models.entries()) {
		const match = normalizeModelId(entry.match);
		const key = `${match}@${entry.effectiveFrom ?? ""}`;
		if (seen.has(key)) {
			throw new Error(
				`${origin}: invalid price file\n  models.${index}.match: "${entry.match}"${entry.effectiveFrom ? ` (effectiveFrom ${entry.effectiveFrom})` : ""} is listed twice`,
			);
		}
		seen.add(key);
		models.push({ ...entry, match });
	}
	return { asOf: parsed.data.asOf, models };
}

/** Read and validate the file at `path` (loadConfig, at startup). */
export function loadLlmPriceOverrides(path: string): LlmPriceOverrides {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(
			`AUTTER_LLM_PRICES_FILE: cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`,
		);
	}
	return parseLlmPriceOverrides(text, `AUTTER_LLM_PRICES_FILE (${path})`);
}

/**
 * Install the overrides (createIngesterApp). An override entry replaces
 * every built-in entry with the same `match`, dated ones included; models
 * the table lacks are added. Null or absent restores the built-in table.
 */
export function configureLlmPricing(options: { llmPriceOverrides?: LlmPriceOverrides | null }): void {
	const overrides = options.llmPriceOverrides;
	if (!overrides) {
		activePrices = withVersion(BUILTIN_LLM_PRICES, LLM_PRICES_AS_OF);
		return;
	}
	const replaced = new Set(overrides.models.map((entry) => entry.match));
	activePrices = [
		...withVersion(
			BUILTIN_LLM_PRICES.filter((entry) => !replaced.has(entry.match)),
			LLM_PRICES_AS_OF,
		),
		...withVersion(overrides.models, `override:${overrides.asOf}`),
	];
}
