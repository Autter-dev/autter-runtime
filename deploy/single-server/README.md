# Self-hosting on a single server (EC2 / Lightsail)

The cheapest way to run Autter Runtime yourself: one small VM running the
ingester **and** ClickHouse together via Docker Compose, with Caddy handling
HTTPS automatically. No ECS, no ClickHouse Cloud, no VPC configuration.

Good for: solo devs, small teams, self-hosters who don't need to scale past
one box. For higher-traffic or HA setups, see `../aws/` instead (ECS Fargate
+ ClickHouse Cloud).

```
Internet → Caddy (:443, auto Let's Encrypt) → otlp-ingester (:4318, internal)
                                                     ↓
                                             ClickHouse (internal only)
```

Everything except Caddy's `:80`/`:443` stays on the Docker-internal network —
ClickHouse and the ingester are never exposed to the internet directly.

## 1. Provision the box

**Lightsail** (simplest):
1. https://lightsail.aws.amazon.com → Create instance → Linux/Unix → **OS
   Only: Ubuntu 24.04**.
2. Plan: the $10/mo (2 GB RAM) tier is enough to start; go up if traffic is
   heavy.
3. Under **Networking** → firewall, allow **HTTP (80)** and **HTTPS (443)**
   from anywhere (SSH 22 is usually pre-added, restrict it to your IP if you
   can).
4. Attach a static IP (Lightsail → Networking → Create static IP) so the DNS
   record doesn't break on reboot.

**EC2** (more control, same AWS account as the rest of your infra):
1. Launch an instance — Ubuntu 24.04, `t3.small` (2 GB) is enough to start.
2. Security group: inbound 80/tcp and 443/tcp from `0.0.0.0/0`; 22/tcp
   restricted to your IP.
3. Allocate an Elastic IP and associate it.

## 2. Point DNS at the box

Create an **A record** (or AAAA for IPv6) for the domain you'll use (e.g.
`otlp.yourdomain.com`) → the static/Elastic IP from step 1. Caddy needs this
to resolve **before** it starts, so it can complete the Let's Encrypt HTTP-01
challenge.

## 3. Install Docker

SSH into the box, then:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# log out and back in for the group change to apply
```

## 4. Get the compose files onto the box

```bash
mkdir -p ~/autter-runtime && cd ~/autter-runtime
curl -fsSLO https://raw.githubusercontent.com/Autter-dev/autter-runtime/main/deploy/single-server/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/Autter-dev/autter-runtime/main/deploy/single-server/Caddyfile
curl -fsSLO https://raw.githubusercontent.com/Autter-dev/autter-runtime/main/deploy/single-server/.env.example
cp .env.example .env
nano .env   # fill in DOMAIN, CLICKHOUSE_PASSWORD, and your auth mode
```

Generate a ClickHouse password and, if self-hosting keys (Mode A in
`.env.example`), an ingest key:

```bash
openssl rand -hex 24                      # → CLICKHOUSE_PASSWORD
echo "autter_rt_$(openssl rand -hex 24)"  # → a server ingest key for AUTTER_INGEST_KEYS
```

## 5. If the GHCR image is private

`ghcr.io/autter-dev/otlp-ingester` should be public — if `docker compose
pull` fails with `unauthorized`, either flip the package to public
(github.com/orgs/Autter-dev/packages → otlp-ingester → Package settings →
Danger Zone → Change visibility), or authenticate the box with a PAT that
has `read:packages`:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin
```

## 6. Start it

```bash
docker compose up -d
docker compose logs -f caddy   # watch for the ACME cert to issue
```

First boot: the ingester creates its ClickHouse schema automatically
(idempotent, runs on every startup — this is also how it applies new-version
schema migrations later). Give it a few seconds after `clickhouse` reports
healthy.

Verify:

```bash
curl https://otlp.yourdomain.com/healthz   # {"ok":true,"status":"ready","clickhouse":"up",…}
```

## 7. Point your apps at it

Use your domain instead of `otlp.autter.dev` everywhere — SDK `endpoint`
options, `OTEL_EXPORTER_OTLP_ENDPOINT`, etc. See `../../docs/INTEGRATIONS.md`.

## Upgrading

```bash
cd ~/autter-runtime
docker compose pull otlp-ingester
docker compose up -d otlp-ingester
```

New ClickHouse schema migrations (new columns/tables) apply automatically on
that restart — see `packages/otlp-ingester/src/migrations.ts` if you want to
read what a given release changed.

The deploy workflow (`.github/workflows/deploy-single-server.yml`) refreshes
`docker-compose.yml` and runs `docker compose up -d --no-deps otlp-ingester`:
it never restarts ClickHouse, even when the new compose file changes the
`clickhouse` service. Apply such a change yourself when a short ClickHouse
restart suits you:

```bash
docker compose up -d --wait clickhouse
```

## Archive bucket (tiered retention)

Optional; off unless set (`../../docs/RETENTION.md`). Days older than the hot
window go to Parquet in an S3-compatible bucket that ClickHouse reads and
writes. Keep the bucket's keys in a ClickHouse
[named collection](https://clickhouse.com/docs/en/operations/named-collections)
so they are in no query: the `clickhouse` service defines it from `.env` when
it starts. Add to `.env`:

```bash
ARCHIVE_S3_NAMED_COLLECTION=autter_archive
ARCHIVE_S3_URL=https://my-bucket.s3.us-east-1.amazonaws.com/autter-runtime
ARCHIVE_S3_COLLECTION_ACCESS_KEY_ID=AKIA...
ARCHIVE_S3_COLLECTION_SECRET_ACCESS_KEY=...
ARCHIVE_RETENTION_DAYS=365
```

`ARCHIVE_S3_COLLECTION_*` go to ClickHouse only. Do not also set
`ARCHIVE_S3_ACCESS_KEY_ID` / `ARCHIVE_S3_SECRET_ACCESS_KEY` (those are for
passing the keys in each query instead): the ingester refuses keys next to a
named collection and does not start. No `<` or `&` in the URL or keys.

Then restart ClickHouse, and the ingester once ClickHouse is healthy:

```bash
docker compose up -d --wait clickhouse      # ClickHouse is down ~10-30 s
docker compose up -d --wait otlp-ingester
docker compose logs clickhouse | grep 'autter: archive'
#   autter: archive named collection autter_archive defined for user default
docker compose exec clickhouse clickhouse-client --password "$CLICKHOUSE_PASSWORD" \
  --query "SELECT name, collection FROM system.named_collections"
#   autter_archive  {'access_key_id':'[HIDDEN]','secret_access_key':'[HIDDEN]','url':'[HIDDEN]'}
docker compose logs otlp-ingester | grep 'runtime archive'
#   runtime archive: started (...) → named_collection:autter_archive, ...
```

During the ClickHouse restart the ingester answers `/healthz` with 503 and
cannot store events; OTLP exporters retry. The first archive pass runs a
minute after the ingester starts, then hourly.

How it works: the `clickhouse` service's entrypoint writes
`config.d/zz-autter-archive-collection.xml`, whose values are `from_env`
references (the keys are read from the container's environment at start,
never written to a file, and kept out of `preprocessed_configs/`), and
`users.d/zz-autter-archive-collection.xml`, which gives `CLICKHOUSE_USER`
`named_collection_control` (ClickHouse requires it to use a collection; it
does not include seeing the secrets). Values show as `[HIDDEN]` in
`system.named_collections`. A missing or malformed variable is reported in
`docker compose logs clickhouse` and the collection is skipped; ClickHouse
starts either way. Without `ARCHIVE_S3_NAMED_COLLECTION` and `ARCHIVE_S3_URL`
it writes nothing and ClickHouse starts exactly as the plain image. To turn
the archive off, remove the lines and run the two commands again (see
RETENTION.md "Turning it off" first). Everything is in `docker-compose.yml`
itself, so the deploy workflow's copy of that one file is enough.

## Backups

The only stateful data lives in the `clickhouse_data` Docker volume. Back it
up with whatever snapshot mechanism your provider offers (Lightsail/EC2 both
support volume/instance snapshots), or periodically:

```bash
docker compose exec clickhouse clickhouse-client --password "$CLICKHOUSE_PASSWORD" \
  --query "BACKUP DATABASE autter_runtime TO Disk('backups', 'backup-$(date +%F).zip')"
```

(requires a `backups` disk configured in ClickHouse — see the [ClickHouse
BACKUP docs](https://clickhouse.com/docs/en/operations/backup) if you want
this properly automated; a volume snapshot is enough for most self-hosters).

## Scaling past one box

If this single server becomes the bottleneck: move ClickHouse to ClickHouse
Cloud (just change `CLICKHOUSE_URL`/`CLICKHOUSE_USER`/`CLICKHOUSE_PASSWORD`
in `.env` — no other changes needed, the ingester doesn't care where
ClickHouse lives) and/or move to the ECS Fargate path in `../aws/` for
multi-instance ingester deployment behind a load balancer.
