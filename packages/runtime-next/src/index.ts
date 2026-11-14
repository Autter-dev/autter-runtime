/**
 * @autter/runtime-next — one-command Autter Runtime for Next.js.
 *
 * This is the root's Node.js build: the server API (`instrumentation.ts`,
 * route handlers, server components). Bundlers pick `index.browser.ts` for
 * the `browser` condition and `index.edge.ts` for `edge-light` / `worker`:
 * the same names, with the coded-error helpers for real and stand-ins for
 * the server-only functions, so a module shared with client or edge code
 * can import the root without pulling the Node OpenTelemetry SDK in.
 * Browser reporting and the error boundary live in
 * `@autter/runtime-next/client`.
 */

export * from "./server.js";
