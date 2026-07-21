# @autter/runtime-next

One-command Autter Runtime for Next.js: server OTel, browser tracker,
same-origin relay route, and a React error boundary.

## Install

```bash
npm install @autter/runtime-next
```

Set `AUTTER_RUNTIME_KEY` in your environment. Then three small files:

**1. `instrumentation.ts`** — server tracing/errors:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerAutter } = await import("@autter/runtime-next");
    registerAutter({
      apiKey: process.env.AUTTER_RUNTIME_KEY!,
      service: "web-app",
      environment: process.env.NODE_ENV,
      release: process.env.GIT_SHA,
    });
  }
}
```

**2. `app/api/autter-runtime/route.ts`** — browser relay (key stays server-side):

```ts
import { createAutterRelayRoute } from "@autter/runtime-next";

export const { POST } = createAutterRelayRoute({
  apiKey: process.env.AUTTER_RUNTIME_KEY!,
});
```

**3. A client component** — browser tracker + render-error boundary:

```tsx
"use client";
import { initAutterBrowser, AutterErrorBoundary } from "@autter/runtime-next";

initAutterBrowser({
  endpoint: "/api/autter-runtime",
  service: "web-app",
  release: process.env.NEXT_PUBLIC_GIT_SHA,
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AutterErrorBoundary fallback={<p>Something went wrong.</p>}>
      {children}
    </AutterErrorBoundary>
  );
}
```

React render errors don't reach `window.onerror` — the boundary reports
them via `captureException` and then renders your fallback.

Also re-exported for convenience: `captureException`, `captureMessage`,
`trackEvent`, `setUser`, `setContext`, `flush` (browser) and
`captureServerException`, `captureServerMessage` (server).
