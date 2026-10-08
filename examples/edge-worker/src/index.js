/**
 * Example: Cloudflare Worker instrumented with @autter/runtime-edge.
 *
 * One request summary per request (method, route, status, outcome,
 * duration, request id, context, inline messages), coded errors as
 * occurrences, delivery through ctx.waitUntil. No AsyncLocalStorage: the
 * request context is the `rt` argument.
 */
import { withAutter, defineRuntimeErrors } from "@autter/runtime-edge";

const quotaErrors = defineRuntimeErrors("quota", {
	exceeded: ({ plan }) => ({
		status: 429,
		message: `Plan ${plan} request quota exceeded`,
		expected: true,
		fix: "Upgrade the plan or retry after the window resets",
	}),
});

export default withAutter(
	// Bindings only exist per request, so options can be a function of env.
	(env) => ({
		apiKey: env.AUTTER_RUNTIME_KEY,
		endpoint: env.AUTTER_ENDPOINT,
		service: "edge-example",
		environment: env.ENVIRONMENT,
		ignore: ["/healthz"],
		// Thrown errors become `{ error: { message, code, fix, requestId } }`.
		errorResponse: true,
	}),
	async (request, env, _ctx, rt) => {
		const url = new URL(request.url);
		if (url.pathname === "/healthz") return new Response("ok");
		const plan = url.searchParams.get("plan") ?? "free";
		rt.set({ plan, colo: request.cf?.colo });
		rt.info("Checking quota");
		if (url.searchParams.has("over")) throw quotaErrors.exceeded({ plan });
		return Response.json({ ok: true, requestId: rt.requestId });
	},
);
