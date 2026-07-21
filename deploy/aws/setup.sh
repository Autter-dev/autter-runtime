#!/usr/bin/env bash
# ONE-TIME provisioning for the otlp-ingester on an existing ECS/ALB stack.
#
# Creates (idempotently): a target group on port 4318 (health /healthz), a
# host-header listener rule on your HTTPS listener, and the Fargate service
# wired to both. Run deploy.sh FIRST once with SKIP_SERVICE_CHECK unset? No —
# run THIS first; it registers the initial task definition by calling
# deploy.sh's registration path via IMAGE_TAG=latest after you push an image,
# or simply run:  1) this script  2) deploy.sh
#
# Required env (in addition to everything deploy.sh needs):
#   VPC_ID                 VPC of the ALB/cluster
#   ALB_HTTPS_LISTENER_ARN the :443 listener to attach the host rule to
#   SUBNET_IDS             comma-separated private subnets for tasks
#   SECURITY_GROUP_ID      SG for tasks (must allow 4318 from the ALB SG)
#   DOMAIN                 e.g. otlp.autter.dev
# Optional:
#   TG_NAME                default autter-otlp-ingester
#   DESIRED_COUNT          default 1
#   RULE_PRIORITY          default 40
set -euo pipefail

: "${VPC_ID:?set VPC_ID}"
: "${ALB_HTTPS_LISTENER_ARN:?set ALB_HTTPS_LISTENER_ARN}"
: "${SUBNET_IDS:?set SUBNET_IDS (comma-separated)}"
: "${SECURITY_GROUP_ID:?set SECURITY_GROUP_ID}"
: "${DOMAIN:?set DOMAIN (e.g. otlp.autter.dev)}"
: "${AWS_REGION:?set AWS_REGION}"

CLUSTER="${CLUSTER:-autter-prod}"
SERVICE="${SERVICE:-autter-otlp-ingester}"
TASK_FAMILY="${TASK_FAMILY:-autter-otlp-ingester}"
TG_NAME="${TG_NAME:-autter-otlp-ingester}"
DESIRED_COUNT="${DESIRED_COUNT:-1}"
RULE_PRIORITY="${RULE_PRIORITY:-40}"

# --- target group -------------------------------------------------------------
tg_arn=$(aws elbv2 describe-target-groups --names "$TG_NAME" --region "$AWS_REGION" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [[ -z "$tg_arn" || "$tg_arn" == "None" ]]; then
  tg_arn=$(aws elbv2 create-target-group --region "$AWS_REGION" \
    --name "$TG_NAME" --protocol HTTP --port 4318 --vpc-id "$VPC_ID" \
    --target-type ip \
    --health-check-path /healthz --health-check-interval-seconds 30 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  echo "==> created target group ${tg_arn}"
else
  echo "==> target group exists: ${tg_arn}"
fi

# --- listener rule (host-header → target group) --------------------------------
existing_rule=$(aws elbv2 describe-rules --listener-arn "$ALB_HTTPS_LISTENER_ARN" --region "$AWS_REGION" \
  --query "Rules[?Conditions[?Field=='host-header' && contains(Values, '${DOMAIN}')]].RuleArn" --output text)
if [[ -z "$existing_rule" ]]; then
  aws elbv2 create-rule --region "$AWS_REGION" \
    --listener-arn "$ALB_HTTPS_LISTENER_ARN" --priority "$RULE_PRIORITY" \
    --conditions "Field=host-header,Values=${DOMAIN}" \
    --actions "Type=forward,TargetGroupArn=${tg_arn}" >/dev/null
  echo "==> created listener rule for ${DOMAIN}"
else
  echo "==> listener rule exists: ${existing_rule}"
fi

# --- initial task definition (via deploy.sh, without rolling a service) --------
latest_task=$(aws ecs describe-task-definition --task-definition "$TASK_FAMILY" --region "$AWS_REGION" \
  --query 'taskDefinition.taskDefinitionArn' --output text 2>/dev/null || true)
if [[ -z "$latest_task" || "$latest_task" == "None" ]]; then
  echo "!! no task definition '${TASK_FAMILY}' yet."
  echo "   Run deploy/aws/deploy.sh once (it will fail at the service step — expected),"
  echo "   then re-run this script to create the service."
  exit 1
fi

# --- service --------------------------------------------------------------------
svc_status=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$AWS_REGION" \
  --query 'services[0].status' --output text 2>/dev/null || true)
if [[ "$svc_status" == "ACTIVE" ]]; then
  echo "==> service already exists"
else
  aws ecs create-service --region "$AWS_REGION" \
    --cluster "$CLUSTER" --service-name "$SERVICE" \
    --task-definition "$latest_task" \
    --desired-count "$DESIRED_COUNT" --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${SUBNET_IDS}],securityGroups=[${SECURITY_GROUP_ID}],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=${tg_arn},containerName=otlp-ingester,containerPort=4318" \
    --health-check-grace-period-seconds 30 >/dev/null
  echo "==> created service ${SERVICE}"
fi

alb_dns=$(aws elbv2 describe-listeners --listener-arns "$ALB_HTTPS_LISTENER_ARN" --region "$AWS_REGION" \
  --query 'Listeners[0].LoadBalancerArn' --output text | xargs -I{} \
  aws elbv2 describe-load-balancers --load-balancer-arns {} --region "$AWS_REGION" \
  --query 'LoadBalancers[0].DNSName' --output text)

cat <<EOF

Done. Final manual steps:
  1. DNS: CNAME ${DOMAIN} -> ${alb_dns}
  2. Ensure the ALB's ACM certificate covers ${DOMAIN} (add a SAN or use a wildcard).
  3. Ensure ${SECURITY_GROUP_ID} allows inbound 4318 from the ALB security group.
  4. Run deploy/aws/deploy.sh to roll the service whenever the ingester changes.
EOF
