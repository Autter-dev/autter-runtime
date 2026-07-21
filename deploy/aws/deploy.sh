#!/usr/bin/env bash
# Build, push, and roll out the otlp-ingester to ECS Fargate.
#
# Idempotent: registers a new task-definition revision pointing at the
# freshly pushed image and updates the service. Run deploy/aws/setup.sh
# once first to create the target group / listener rule / service.
#
# Required env:
#   AWS_ACCOUNT_ID        e.g. 852794024838
#   AWS_REGION            e.g. ap-south-1
#   EXECUTION_ROLE_ARN    ECS task execution role (with secretsmanager:GetSecretValue
#                         on the CLICKHOUSE_/AUTTER_ secrets below)
# Required env (secrets — Secrets Manager ARNs, injected into the task):
#   CLICKHOUSE_URL_SECRET_ARN
#   CLICKHOUSE_PASSWORD_SECRET_ARN
# Optional secret ARNs:
#   AUTTER_KEY_VALIDATOR_TOKEN_SECRET_ARN   (with KEY_VALIDATOR_URL set)
#   AUTTER_SINK_TOKEN_SECRET_ARN            (with SINK_URL set)
#   AUTTER_INGEST_KEYS_SECRET_ARN           (static keys JSON, if no validator)
# Optional env:
#   CLUSTER               default autter-prod
#   SERVICE               default autter-otlp-ingester
#   ECR_REPO              default autter-otlp-ingester
#   TASK_FAMILY           default autter-otlp-ingester
#   TASK_CPU / TASK_MEM   default 256 / 512
#   KEY_VALIDATOR_URL     e.g. https://api.autter.dev/runtime/validate-key
#   SINK_URL              e.g. https://api.autter.dev/runtime/sink
#   CLICKHOUSE_USER       default "default"
#   CLICKHOUSE_DATABASE   default autter_runtime
#   IMAGE_TAG             default <git sha>
#   SKIP_BUILD=1          reuse an already-pushed IMAGE_TAG
set -euo pipefail

: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID}"
: "${AWS_REGION:?set AWS_REGION}"
: "${EXECUTION_ROLE_ARN:?set EXECUTION_ROLE_ARN}"
: "${CLICKHOUSE_URL_SECRET_ARN:?set CLICKHOUSE_URL_SECRET_ARN}"
: "${CLICKHOUSE_PASSWORD_SECRET_ARN:?set CLICKHOUSE_PASSWORD_SECRET_ARN}"

CLUSTER="${CLUSTER:-autter-prod}"
SERVICE="${SERVICE:-autter-otlp-ingester}"
ECR_REPO="${ECR_REPO:-autter-otlp-ingester}"
TASK_FAMILY="${TASK_FAMILY:-autter-otlp-ingester}"
TASK_CPU="${TASK_CPU:-256}"
TASK_MEM="${TASK_MEM:-512}"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD)}"
IMAGE="${REGISTRY}/${ECR_REPO}:${IMAGE_TAG}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "==> image: ${IMAGE}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 \
    || aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION" >/dev/null
  aws ecr get-login-password --region "$AWS_REGION" \
    | docker login --username AWS --password-stdin "$REGISTRY"
  docker build --platform linux/amd64 \
    -f "$REPO_ROOT/packages/otlp-ingester/Dockerfile" \
    -t "$IMAGE" -t "${REGISTRY}/${ECR_REPO}:latest" \
    "$REPO_ROOT"
  docker push "$IMAGE"
  docker push "${REGISTRY}/${ECR_REPO}:latest"
fi

# --- task definition ---------------------------------------------------------
secrets_json="[
  {\"name\":\"CLICKHOUSE_URL\",\"valueFrom\":\"${CLICKHOUSE_URL_SECRET_ARN}\"},
  {\"name\":\"CLICKHOUSE_PASSWORD\",\"valueFrom\":\"${CLICKHOUSE_PASSWORD_SECRET_ARN}\"}"
[[ -n "${AUTTER_KEY_VALIDATOR_TOKEN_SECRET_ARN:-}" ]] && secrets_json+=",
  {\"name\":\"AUTTER_KEY_VALIDATOR_TOKEN\",\"valueFrom\":\"${AUTTER_KEY_VALIDATOR_TOKEN_SECRET_ARN}\"}"
[[ -n "${AUTTER_SINK_TOKEN_SECRET_ARN:-}" ]] && secrets_json+=",
  {\"name\":\"AUTTER_SINK_TOKEN\",\"valueFrom\":\"${AUTTER_SINK_TOKEN_SECRET_ARN}\"}"
[[ -n "${AUTTER_INGEST_KEYS_SECRET_ARN:-}" ]] && secrets_json+=",
  {\"name\":\"AUTTER_INGEST_KEYS\",\"valueFrom\":\"${AUTTER_INGEST_KEYS_SECRET_ARN}\"}"
secrets_json+="]"

env_json="[
  {\"name\":\"PORT\",\"value\":\"4318\"},
  {\"name\":\"NODE_ENV\",\"value\":\"production\"},
  {\"name\":\"CLICKHOUSE_USER\",\"value\":\"${CLICKHOUSE_USER:-default}\"},
  {\"name\":\"CLICKHOUSE_DATABASE\",\"value\":\"${CLICKHOUSE_DATABASE:-autter_runtime}\"}"
[[ -n "${KEY_VALIDATOR_URL:-}" ]] && env_json+=",
  {\"name\":\"AUTTER_KEY_VALIDATOR_URL\",\"value\":\"${KEY_VALIDATOR_URL}\"}"
[[ -n "${SINK_URL:-}" ]] && env_json+=",
  {\"name\":\"AUTTER_SINK_URL\",\"value\":\"${SINK_URL}\"}"
env_json+="]"

log_group="/ecs/${TASK_FAMILY}"
aws logs create-log-group --log-group-name "$log_group" --region "$AWS_REGION" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "$log_group" --retention-in-days 30 --region "$AWS_REGION" 2>/dev/null || true

task_def=$(cat <<JSON
{
  "family": "${TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "${TASK_CPU}",
  "memory": "${TASK_MEM}",
  "executionRoleArn": "${EXECUTION_ROLE_ARN}",
  "runtimePlatform": { "cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX" },
  "containerDefinitions": [{
    "name": "otlp-ingester",
    "image": "${IMAGE}",
    "essential": true,
    "portMappings": [{ "containerPort": 4318, "protocol": "tcp" }],
    "environment": ${env_json},
    "secrets": ${secrets_json},
    "healthCheck": {
      "command": ["CMD-SHELL", "node -e \\"fetch('http://localhost:4318/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\\""],
      "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 15
    },
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "${log_group}",
        "awslogs-region": "${AWS_REGION}",
        "awslogs-stream-prefix": "ingester"
      }
    }
  }]
}
JSON
)

task_def_arn=$(aws ecs register-task-definition --region "$AWS_REGION" \
  --cli-input-json "$task_def" \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "==> registered ${task_def_arn}"

# --- roll the service (setup.sh must have created it) ------------------------
if ! aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$AWS_REGION" \
     --query 'services[?status==`ACTIVE`]' --output text | grep -q .; then
  echo "!! service ${SERVICE} does not exist in cluster ${CLUSTER}."
  echo "   Run deploy/aws/setup.sh once to create the target group, listener rule, and service."
  exit 1
fi

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$task_def_arn" --force-new-deployment \
  --region "$AWS_REGION" >/dev/null
echo "==> waiting for service to stabilise…"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE" --region "$AWS_REGION"

if [[ -n "${HEALTH_URL:-}" ]]; then
  echo "==> health check ${HEALTH_URL}"
  curl -fsS --max-time 10 "$HEALTH_URL" && echo " OK"
fi
echo "==> deployed ${IMAGE}"
