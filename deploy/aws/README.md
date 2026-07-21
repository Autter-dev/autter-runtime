# Deploying the ingester to AWS (ECS Fargate)

Runbook for hosting the otlp-ingester on an existing ECS + ALB stack (the
Autter production setup: cluster `autter-prod`, region `ap-south-1`,
domain `otlp.autter.dev`). Everything is parameterised — nothing
account-specific lives in the scripts.

Just want the simplest self-hosted option, no existing ECS/ALB/VPC to
attach to? See [`../single-server`](../single-server) instead — one EC2 or
Lightsail box running the ingester + ClickHouse via Docker Compose.

The service is stateless and tiny: 0.25 vCPU / 512 MB is plenty to start.

## Architecture

```
otlp.autter.dev (CNAME → ALB) → HTTPS listener host rule → target group :4318
  → ECS Fargate service "autter-otlp-ingester" (existing cluster)
      env from Secrets Manager: CLICKHOUSE_URL/PASSWORD, validator/sink tokens
      → ClickHouse Cloud
      → api.autter.dev/runtime/validate-key  (key lookup)
      → api.autter.dev/runtime/sink          (fingerprinted occurrences)
```

## 0. Prerequisites (one-time, console/CLI)

1. **ClickHouse** — a ClickHouse Cloud service (dev tier is fine to start).
2. **Secrets Manager** entries (same `autter/` convention as the backend):

   ```bash
   aws secretsmanager create-secret --name autter/CLICKHOUSE_URL \
     --secret-string "https://xxx.clickhouse.cloud:8443" --region ap-south-1
   aws secretsmanager create-secret --name autter/CLICKHOUSE_PASSWORD \
     --secret-string "…" --region ap-south-1
   # once the backend validator/sink endpoints exist (same shared secret in both):
   aws secretsmanager create-secret --name autter/RUNTIME_INGESTER_SECRET \
     --secret-string "$(openssl rand -hex 24)" --region ap-south-1
   # until then, static keys keep the ingester usable standalone:
   aws secretsmanager create-secret --name autter/AUTTER_INGEST_KEYS \
     --secret-string '[{"key":"autter_rt_…","orgId":"…","repositoryId":"…"}]' \
     --region ap-south-1
   ```

3. **Execution role**: reuse the backend's ECS execution role and extend its
   `secretsmanager:GetSecretValue` inline policy with the new ARNs (the
   backend Terraform manages this via `secret_arns`; the ingester's ARNs can
   be added there or as a separate inline policy).
4. **ACM**: the ALB certificate must cover `otlp.autter.dev`
   (wildcard `*.autter.dev` already does).
5. **Security group**: the tasks SG must allow inbound 4318 from the ALB SG.

## 1. First deploy

```bash
export AWS_REGION=ap-south-1
export AWS_ACCOUNT_ID=<account id>
export EXECUTION_ROLE_ARN=arn:aws:iam::<account>:role/<ecs-execution-role>
export CLICKHOUSE_URL_SECRET_ARN=arn:aws:secretsmanager:…:secret:autter/CLICKHOUSE_URL-…
export CLICKHOUSE_PASSWORD_SECRET_ARN=arn:aws:secretsmanager:…:secret:autter/CLICKHOUSE_PASSWORD-…
export AUTTER_INGEST_KEYS_SECRET_ARN=arn:aws:secretsmanager:…:secret:autter/AUTTER_INGEST_KEYS-…
# later, when the backend endpoints exist:
# export KEY_VALIDATOR_URL=https://api.autter.dev/runtime/validate-key
# export AUTTER_KEY_VALIDATOR_TOKEN_SECRET_ARN=…RUNTIME_INGESTER_SECRET-…
# export SINK_URL=https://api.autter.dev/runtime/sink
# export AUTTER_SINK_TOKEN_SECRET_ARN=…RUNTIME_INGESTER_SECRET-…

bash deploy/aws/deploy.sh          # builds, pushes, registers the task def
                                   # (fails at the service step — expected on first run)

export VPC_ID=vpc-…
export ALB_HTTPS_LISTENER_ARN=arn:aws:elasticloadbalancing:…:listener/app/…/…/…
export SUBNET_IDS=subnet-…,subnet-…
export SECURITY_GROUP_ID=sg-…       # the backend tasks SG (or a clone)
export DOMAIN=otlp.autter.dev
bash deploy/aws/setup.sh            # target group + listener rule + service
```

Then create the DNS CNAME the script prints, and verify:

```bash
curl https://otlp.autter.dev/healthz   # {"ok":true,…}
```

## 2. Every subsequent deploy

Push to `main` (with `AWS_AUTODEPLOY_ENABLED=true`) or run the
**Deploy ingester (AWS)** workflow from the Actions tab — it assumes the
OIDC role, builds, pushes, registers a new task-definition revision, rolls
the service, and health-checks. Configure once:

```bash
gh variable set AWS_DEPLOY_ROLE_ARN -R Autter-dev/autter-runtime -b "arn:aws:iam::<account>:role/<deploy-role>"
gh variable set AWS_REGION -R Autter-dev/autter-runtime -b "ap-south-1"
gh variable set AWS_ACCOUNT_ID -R Autter-dev/autter-runtime -b "<account id>"
gh variable set ECS_CLUSTER -R Autter-dev/autter-runtime -b "autter-prod"
gh variable set ECS_SERVICE -R Autter-dev/autter-runtime -b "autter-otlp-ingester"
gh variable set EXECUTION_ROLE_ARN -R Autter-dev/autter-runtime -b "arn:aws:iam::…"
gh variable set INGESTER_HEALTH_URL -R Autter-dev/autter-runtime -b "https://otlp.autter.dev/healthz"
gh secret set CLICKHOUSE_URL_SECRET_ARN -R Autter-dev/autter-runtime -b "arn:aws:secretsmanager:…"
gh secret set CLICKHOUSE_PASSWORD_SECRET_ARN -R Autter-dev/autter-runtime -b "arn:aws:secretsmanager:…"
gh secret set AUTTER_INGEST_KEYS_SECRET_ARN -R Autter-dev/autter-runtime -b "arn:aws:secretsmanager:…"
```

The OIDC deploy role additionally needs: `ecr:*` on the
`autter-otlp-ingester` repo, `ecs:RegisterTaskDefinition`,
`ecs:Describe*`/`ecs:UpdateService` on the service,
`logs:CreateLogGroup`/`PutRetentionPolicy`, and `iam:PassRole` on the
execution role. (Same shape as the backend's deploy role — extending that
role's policy is the path of least resistance.)

## Self-hosting (everyone else)

No AWS required — a prebuilt multi-arch image is published to GHCR:

```bash
docker run -p 4318:4318 \
  -e CLICKHOUSE_URL=… -e CLICKHOUSE_PASSWORD=… \
  -e AUTTER_INGEST_KEYS='[{"key":"…","orgId":"o","repositoryId":"r"}]' \
  ghcr.io/autter-dev/otlp-ingester:latest
```

or `docker compose up` from the repo root for a bundled local ClickHouse.
