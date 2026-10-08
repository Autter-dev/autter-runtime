# Connect external logs to Runtime

The Autter platform can ingest repository-scoped logs from Sentry, PostHog, Grafana/Loki, Datadog and generic webhooks. Configure them under **Repository → Settings → Runtime → Data sources** when this feature is enabled on your deployment.

## Relationship to this repository

This repository contains the SDKs, OTLP ingester and telemetry contracts. External provider polling and webhook collection run in the Autter platform's separate collector and analysis workers. Provider-only collection requires no application SDK upgrade, OTLP ingest key or ClickHouse schema migration. Keep your current SDK/OTel instrumentation if you also need application spans, source maps, usage or LLM telemetry.

SDK telemetry continues through the OTLP ingester and ClickHouse. External occurrences are normalized and stored in the platform's organization database, associated with the selected repository. Both feed Runtime issue investigation and the existing draft-fix executor. Deduplication handles provider event retries and polling/webhook overlap within a source. Uncoded SDK and provider events are not guaranteed to merge into one group; **coded** errors are (see [Error codes](#error-codes)).

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
  "traceId": "trace-id",
  "errorCode": "billing.declined"
}
```

`errorCode` is optional. When it is a valid code (see below) the record is grouped by code rather than by `fingerprint`; `fingerprint` is still required and kept for provider links and dedupe.

Use `{"records":[...]}` for batches of up to 100. Alerts use `kind: "alert"`, `action: "fired"`; recovery uses the same fingerprint/service/environment with a new event ID, later timestamp and `action: "resolved"`. If configured, generic/Datadog webhooks also require the `x-autter-signature` shared-secret header; Sentry uses its integration HMAC.

## Error codes

An error code is a namespaced, stable, low-cardinality identifier such as `billing.declined` or `auth.session_expired`. It must match `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$` and be at most 80 characters. Codes never contain ids or user data. A value that doesn't match (`ECONNRESET`, `E_FAIL`, a UUID) is ignored and the record groups as before.

A record with a valid code gets the source-independent `code-v1` fingerprint, `sha256("code-v1\0" + service + "\0" + code)[:32]` — the same one the OTLP ingester computes for SDK errors with `autter.error.code`. So one code in one service is **one issue** whether it came from the Node/browser/edge SDKs, Sentry, PostHog, Datadog, Loki or a generic webhook; the issue lists every source that reported it and keeps each provider's own issue id for links. Records without a valid code keep the provider fingerprint.

The platform reads the code from the first field that holds one:

| Provider | Where the code is read from (first match wins) |
| --- | --- |
| Sentry | `tags.error_code`, `tags.code`, `contexts.autter.error_code`, `exception.values[-1].mechanism.data.code`, `extra.code` |
| PostHog | `properties.error_code`, `properties.$exception_list[-1].code`, `properties.autter_error_code` |
| Datadog | `@error.code`, `attributes.error.code`, tag `error_code:<value>` |
| Grafana/Loki | Stream label `error_code`, or `code` / `error.code` in a JSON log line |
| Generic webhook | `errorCode` |

To use this, set the code where your provider SDK already lets you attach data — for example a Sentry tag `error_code`, or a structured log field `error.code` for Loki and Datadog. Above 500 distinct codes per service per day, new codes fall back to message grouping and Runtime shows a "code cardinality too high" notice; this guards against ids leaking into codes.

Do not forward secrets, cookies, request bodies or personal data unnecessarily. The platform bounds and redacts stored diagnostic fields; upstream scrubbing is still recommended. Provider credentials, private webhook URLs, Runtime server/client ingest keys and CLI personal tokens serve different purposes.

Self-hosted platform operators must deploy the API, collector, analysis worker and existing PR executor with their database/GitHub/AI configuration. API and collectors need the same persistent connector encryption key. These workers are not included in the standalone OTLP ingester image.

See the [public external-source guide](https://github.com/Autter-dev/docs/blob/main/runtime/external-sources.mdx) and [setup skill](https://github.com/Autter-dev/autter-skills/tree/main/autter-runtime-setup).
