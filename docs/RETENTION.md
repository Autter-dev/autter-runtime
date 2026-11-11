# Retention: hot in ClickHouse, then Parquet in object storage

By default the ingester keeps error occurrences for 14 days, spans for 7,
logs for 14 and LLM calls for 90, and ClickHouse's TTL deletes them after
that. An error that comes back once a month then has no stored occurrences,
traces or logs from its earlier appearances.

With an archive bucket configured, those days are written to Parquet files
in object storage before they leave ClickHouse. The Autter dashboard reads
them back when a page asks for something older than the hot window, for
example an issue last seen three weeks ago or the trace behind it. Without
a bucket nothing changes: the TTLs delete as they always did.

| Tier | Where | How long | Reads |
| --- | --- | --- | --- |
| Hot | ClickHouse tables (`runtime_error_occurrences`, `runtime_spans`, `runtime_logs`, `runtime_llm_calls`) | `OCCURRENCE_TTL_DAYS` (14), `SPAN_TTL_DAYS` (7), `LOG_TTL_DAYS` (14), `LLM_CALL_TTL_DAYS` (90) | Every query |
| Cold | Parquet in S3, GCS, MinIO, R2 or any S3-compatible bucket | `ARCHIVE_RETENTION_DAYS` (365) of event age, enforced by the bucket's lifecycle rule | Through ClickHouse's `s3()` table function, one org's files for the days asked for |

Metrics rollups (`runtime_metrics_1m` and friends) are not archived. They
are small and already kept for 90 days.

## Turning it on

ClickHouse reads and writes the bucket, not the ingester, so the
credentials must work from the ClickHouse server.

```bash
# S3
ARCHIVE_S3_URL=https://my-bucket.s3.us-east-1.amazonaws.com/autter-runtime
ARCHIVE_S3_ACCESS_KEY_ID=AKIA…
ARCHIVE_S3_SECRET_ACCESS_KEY=…

# GCS: the S3-compatible XML API with an HMAC key of a service account
ARCHIVE_S3_URL=https://storage.googleapis.com/my-bucket/autter-runtime
ARCHIVE_S3_ACCESS_KEY_ID=GOOG1E…
ARCHIVE_S3_SECRET_ACCESS_KEY=…

# MinIO (the repo's docker compose: docker compose --profile archive up)
ARCHIVE_S3_URL=http://minio:9000/autter-archive/runtime
ARCHIVE_S3_ACCESS_KEY_ID=minioadmin
ARCHIVE_S3_SECRET_ACCESS_KEY=minioadmin
```

You can keep the keys out of every query by using a
[named collection](https://clickhouse.com/docs/en/operations/named-collections)
on the ClickHouse server instead:

```xml
<clickhouse>
  <named_collections>
    <autter_archive>
      <url>https://my-bucket.s3.us-east-1.amazonaws.com/autter-runtime/</url>
      <access_key_id>AKIA…</access_key_id>
      <secret_access_key>…</secret_access_key>
    </autter_archive>
  </named_collections>
</clickhouse>
```

```bash
ARCHIVE_S3_NAMED_COLLECTION=autter_archive
```

The URL in the collection must end with `/`: object paths are appended to it
as `filename`.

| Variable | Default | |
| --- | --- | --- |
| `ARCHIVE_S3_URL` | unset (off) | Bucket endpoint plus an optional prefix. No credentials, query string or glob characters in it. |
| `ARCHIVE_S3_NAMED_COLLECTION` | unset | A ClickHouse named collection with the URL and credentials, used instead of `ARCHIVE_S3_URL` and the keys. |
| `ARCHIVE_S3_ACCESS_KEY_ID` / `ARCHIVE_S3_SECRET_ACCESS_KEY` | unset | Keys passed in the `s3()` calls. Without them and without a named collection, ClickHouse uses its own credentials (environment, instance role). |
| `ARCHIVE_TABLES` | all four | Comma-separated subset of `runtime_error_occurrences,runtime_spans,runtime_llm_calls,runtime_logs`. |
| `ARCHIVE_RETENTION_DAYS` | `365` (30–3650) | Event age after which a day is gone from the archive too. A day already this old when its hot window ends is dropped without export, as its TTL would have done. |
| `ARCHIVE_BACKSTOP_DAYS` | `auto` (hot window + 7 days) | Delete TTL kept on archived tables as a disk guard: traces 14 days, errors and logs 21, LLM calls 97 with the default hot windows. A number sets it (at least the hot window + 7); `0` removes it. It deletes rows whether or not they were archived, so a day the job could not archive for a week is lost, but a stopped job never fills the disk. |
| `ARCHIVE_OVERDUE_WARN_DAYS` | `2` | Each pass warns (`runtime archive: <table> is behind`) when a table's oldest unarchived day has waited this many days past the one that just left the hot window. |
| `ARCHIVE_INTERVAL_MINUTES` | `60` (5–1440) | How often the job runs. The first pass is a minute after start. |
| `ARCHIVE_MAX_DAYS_PER_PASS` | `4` (1–31) | Day partitions handled per table per pass. A backlog takes a few passes. |
| `ARCHIVE_SCHEDULER` | `auto` | `auto`: the holder of a Redis lease (`AUTTER_REDIS_URL`), or the only replica (`AUTTER_INGESTER_REPLICAS=1`). `on`: this process runs it without a lease. `off`: this process never runs it. |

Set the bucket's lifecycle rule to expire objects under the prefix after
`ARCHIVE_RETENTION_DAYS` days. Objects are written when a day leaves the hot
window, so they are kept a little longer than the event age says. That is
harmless, because the dashboard only reads days within the retention.

## What happens to a day

Every archived table is partitioned by day. Once a day is older than the
table's hot window, the job (`packages/otlp-ingester/src/archive.ts`):

1. writes an `exporting` row to `runtime_archive_log`;
2. moves the day's partition, in one atomic step, from the table into
   `<table>_archive_stage` (`ALTER TABLE … MOVE PARTITION … TO TABLE`), so
   rows that arrive late for that day start a fresh partition instead of
   being lost with the moved ones;
3. writes each org's rows to
   `<base>/<table>/org=<org>/date=<YYYY-MM-DD>/g<generation>.parquet`
   (zstd), then reads each object back and checks its row count;
4. marks the log row `archived`, and only then drops the staged partition.

If the job stops anywhere (a crash, a deploy, a bucket error, a short read
back), the rows are still in either the table or the stage table, and the
next pass resumes from the log and writes the same objects again. A day is
never dropped before its rows were read back from the bucket. Rows that
arrive late for an archived day are archived as a second generation, in a
second file next to the first.

While an archive is configured, the archived tables' delete TTL moves out
to the backstop, a week past the hot window (`ARCHIVE_BACKSTOP_DAYS`), so
the job is what normally removes rows. If it does not run (no Redis with
several replicas, the bucket unreachable for days), each pass that does run
warns once a table is `ARCHIVE_OVERDUE_WARN_DAYS` behind, Autter's
ClickHouse health monitor publishes `ArchiveOverdueDays` (its alarm fires
at 2), and after a week the backstop deletes the oldest unarchived days
rather than let the disk fill and stop ingest. `ARCHIVE_BACKSTOP_DAYS=0`
removes the TTL entirely: nothing is lost unarchived, but a stopped job
then grows the tables until the disk is full.

The ingester never adds a delete TTL to a table that has none unless an
archive is configured for it. Adding one deletes every row older than it,
so a table whose TTL you removed (or that `ARCHIVE_BACKSTOP_DAYS=0` removed
before you turned the archive off) stays without one. Each boot logs a
warning for such a table with the statement that adds the TTL:

```sql
ALTER TABLE autter_runtime.runtime_spans MODIFY TTL toDateTime(started_at) + INTERVAL 7 DAY;
```

Run it once every day you want to keep is archived or expendable.
(`otlp-ingester` 1.14.0 added the TTL by itself at boot; 1.14.1 does not.)

Org keys in paths are the org id when it consists of `[A-Za-z0-9_-]` (every
Autter org id). Any other id becomes a readable form plus a 12-character
hash (`orgArchiveKey`), so two ids never share a folder. Readers always
filter by `org_id` inside the file as well.

## Reading the archive

The Autter backend reads `runtime_archive_log` to find which days are
archived, then reads only the requesting org's files for those days, with
the hot table's current column list as the structure (files written before
a migration read the new columns as defaults). Each read covers at most 31
days by default. Pages say when rows came from the archive, and when what
was asked for is older than the retention. See the backend's
`runtime-archive.ts`.

By hand:

```sql
SELECT occurred_at, error_type, message
FROM s3('https://my-bucket.s3.us-east-1.amazonaws.com/autter-runtime/runtime_error_occurrences/org=org_123/date={2026-10-01,2026-10-02}/g*.parquet',
        'AKIA…', '…', 'Parquet')
WHERE fingerprint = '…'
ORDER BY occurred_at DESC
LIMIT 50;
```

Restore a day into ClickHouse (for example to run heavy queries on it):

```sql
INSERT INTO autter_runtime.runtime_spans
SELECT * FROM s3('…/runtime_spans/org=*/date=2026-10-01/g*.parquet', 'AKIA…', '…', 'Parquet');
```

With no TTL on the table, a restored day stays until the next archive pass
moves it out again (as a new generation). Delete the older generation's
objects first if you do not want two copies.

## Status

```sql
SELECT table_name, day, generation, argMax(status, updated_at) AS status, argMax(rows, updated_at) AS rows
FROM autter_runtime.runtime_archive_log
GROUP BY table_name, day, generation
ORDER BY day DESC
LIMIT 50;
```

A row stuck at `exporting` is a day the job could not finish. The
ingester's log has the reason (`runtime archive: <table> pass stopped …`).
