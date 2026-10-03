# Investigate captured Runtime signals

After telemetry is connected to your repository in Autter, use **Dashboard → Ask** to ask plain-language system questions, query captured logs, or search your saved debugging threads.

**Ask anything** combines Runtime events, incident investigations, and repository code to explain root causes or hypotheses, observed impact, and recommended fixes. **Query logs** filters the existing captured error/warning/info dataset by severity, service, time range, message, and custom attributes. Custom keys use `attributes.<exact key>`; for example, `attributes.http.request.method`.

The Autter CLI provides the same surfaces:

```sh
autter login
autter ask "Why did these requests start failing?" --repo my-api
autter logs --repo my-api --severity error --service api --since 1h
autter logs --repo my-api --field attributes.http.request.method=POST --filter status_code:gte:500
autter threads search "connection pool"
autter ask "How do we verify the fix?" --thread <thread-id>
```

Questions and answers share private history between Dashboard and CLI. `--json` returns complete fields, including occurrence IDs, trace IDs and attributes. Results disclose truncation; missing captured events do not establish system health. These interfaces require the updated Autter platform and CLI, and use the existing Runtime storage contract without an SDK upgrade.

Use a CLI login or personal access token for reads. Runtime ingest keys authorize telemetry ingestion and cannot authenticate these commands. Self-hosted ingesters need their existing ClickHouse connection configured in the platform for raw log queries.
