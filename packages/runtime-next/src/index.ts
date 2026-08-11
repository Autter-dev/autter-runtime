/**
 * @autter/runtime-next — one-command Autter Runtime for Next.js.
 *
 * The root entry is SERVER-ONLY (`instrumentation.ts`, route handlers).
 * Client components must import from `@autter/runtime-next/client` —
 * importing the root from client code would pull the Node OpenTelemetry
 * SDK into the browser bundle and break the build.
 */

export * from "./server.js";
