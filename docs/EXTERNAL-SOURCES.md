# Connect external logs to Runtime

The Autter platform can ingest repository-scoped logs from Sentry, PostHog, Grafana/Loki, Datadog and generic webhooks. Configure them under **Repository → Settings → Runtime → Data sources** when this feature is enabled on your deployment.

## Relationship to this repository

This repository contains the SDKs, OTLP ingester and telemetry contracts. External provider polling and webhook collection run in the Autter platform's separate collector and analysis workers. Provider-only collection requires no application SDK upgrade, OTLP ingest key or ClickHouse schema migration. Keep your current SDK/OTel instrumentation if you also need application spans, source maps, usage or LLM telemetry.

SDK telemetry continues through the OTLP ingester and ClickHouse. External occurrences are normalized and stored in the platform's organization database, associated with the selected repository. Both feed Runtime issue investigation and the existing draft-fix executor. Deduplication handles provider event retries and polling/webhook overlap within a source; SDK/provider events are not guaranteed to merge into one group.

## Setup

1. Select the connected repository and open Runtime settings. Owners/admins can configure sources.
2. Choose a provider, enter its project/service and environments, and supply read credentials through the settings form. Sentry uses organization/project slugs; PostHog uses a project ID and personal read key; Grafana uses a Loki URL/query and optional Tempo credentials; Datadog uses an API key plus an application key with logs-read access.
3. Test access and inspect matching samples. Save the connection. Store the returned private webhook URL securely if using push delivery.
4. Choose collection-only, investigation, or investigation plus draft fixes. Warning analysis is separately opt-in; high/critical is the default automatic-draft threshold. The repository's automatic-draft switch also applies.
5. Inspect Runtime errors for stored messages, severity, stacks/trace context and RCA. Check the actual draft PR URL when a fix completes; a queued job is not a created PR.

Polling is periodic, with a default 60-second interval plus provider delay. The new webhook route returns `202` after committing records and work. Analysis and fixes complete asynchronously. Backfilled historical records do not initiate automatic fixes. Missing stacks/source maps or insufficient code evidence produce a needs-evidence result.

Recovery comes from a resolved webhook; monitor-state polling is not implemented. Project selection uses manually entered IDs/slugs. Datadog stores supplied trace context without a separate APM trace fetch; Grafana can fetch a linked Tempo trace. Disconnecting removes credentials and stops new collection while preserving retained evidence.

## Generic webhook record

Send this shape to the private URL provided by your repository connection. Do not send it to `/v1/browser` or authenticate it with a Runtime ingest key. Replace event ID, timestamp, service/environment and diagnostics with real values.

```json
{
  "eventId": "stable-event-id",
  "fingerprint": "checkout-missing-customer",
  "title": "Checkout could not load customer",
  "message": "Cannot read properties of undefined",
  "severity": "error",
  "service": "checkout",
  "environment": "production",
  "occurredAt": "2026-09-28T12:00:00Z",
  "stack": "TypeError: Cannot read properties of undefined\n    at checkout (src/checkout.ts:42:3)",
  "release": "deployed-commit-sha",
  "traceId": "trace-id"
}
```

Use `{"records":[...]}` for batches of up to 100. Alerts use `kind: "alert"`, `action: "fired"`; recovery uses the same fingerprint/service/environment with a new event ID, later timestamp and `action: "resolved"`. If configured, generic/Datadog webhooks also require the `x-autter-signature` shared-secret header; Sentry uses its integration HMAC.

Do not forward secrets, cookies, request bodies or personal data unnecessarily. The platform bounds and redacts stored diagnostic fields; upstream scrubbing is still recommended. Provider credentials, private webhook URLs, Runtime server/client ingest keys and CLI personal tokens serve different purposes.

Self-hosted platform operators must deploy the API, collector, analysis worker and existing PR executor with their database/GitHub/AI configuration. API and collectors need the same persistent connector encryption key. These workers are not included in the standalone OTLP ingester image.

See the [public external-source guide](https://docs.autter.dev/runtime/external-sources) and [setup skill](https://github.com/Autter-dev/autter-skills/tree/main/autter-runtime-setup).
