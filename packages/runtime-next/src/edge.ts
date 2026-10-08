/**
 * Edge half of @autter/runtime-next — for `middleware.ts` and
 * `export const runtime = "edge"` route handlers. Re-exports
 * @autter/runtime-edge (zero dependencies, no Node APIs):
 *
 *   import { withAutter } from "@autter/runtime-next/edge";
 *   export default withAutter(
 *     { apiKey: process.env.AUTTER_RUNTIME_KEY, service: "web-middleware" },
 *     async (request, event, _ctx, rt) => NextResponse.next(),
 *   );
 *
 * `event.waitUntil` (NextFetchEvent) is used for delivery automatically.
 */
export * from "@autter/runtime-edge";
