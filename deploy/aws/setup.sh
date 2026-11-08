#!/usr/bin/env bash
# ONE-TIME provisioning for the otlp-ingester on an existing ECS/ALB stack.
#
# Creates (idempotently): a target group on port 4318 (health /healthz), a
# host-header listener rule on your HTTPS listener, an encrypted EFS file
# system for the sink outbox (mount targets in SUBNET_IDS, an NFS security
# group open to SECURITY_GROUP_ID only, and an access point owned by the
# image's `node` user), and the Fargate service wired to the target group.
# deploy.sh finds the EFS volume by its creation token and mounts it. Run deploy.sh FIRST once with SKIP_SERVICE_CHECK unset? No —
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
#   OUTBOX_EFS             default 1; 0 skips the sink outbox EFS (batches the
#                          sink has not delivered are then lost when a task is
#                          replaced, and the platform's reconciler replays them)
#   EFS_CREATION_TOKEN     default ${TASK_FAMILY}-sink-outbox (deploy.sh uses the same)
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

# --- sink outbox EFS ------------------------------------------------------------
# Every task mounts it at /var/lib/autter/sink-outbox, writes its own
# subdirectory and adopts the batches of tasks that are gone
# (SINK_OUTBOX_SHARED), so a deploy, crash or scale-in loses no queued batch.
if [[ "${OUTBOX_EFS:-1}" == "1" ]]; then
  EFS_CREATION_TOKEN="${EFS_CREATION_TOKEN:-${TASK_FAMILY}-sink-outbox}"
  fs_id=$(aws efs describe-file-systems --creation-token "$EFS_CREATION_TOKEN" --region "$AWS_REGION" \
    --query 'FileSystems[0].FileSystemId' --output text 2>/dev/null || true)
  if [[ -z "$fs_id" || "$fs_id" == "None" ]]; then
    fs_id=$(aws efs create-file-system --region "$AWS_REGION" \
      --creation-token "$EFS_CREATION_TOKEN" --encrypted \
      --performance-mode generalPurpose --throughput-mode elastic \
      --tags "Key=Name,Value=${EFS_CREATION_TOKEN}" \
      --query 'FileSystemId' --output text)
    echo "==> created EFS ${fs_id}"
  else
    echo "==> EFS exists: ${fs_id}"
  fi
  for _ in $(seq 1 30); do
    state=$(aws efs describe-file-systems --file-system-id "$fs_id" --region "$AWS_REGION" \
      --query 'FileSystems[0].LifeCycleState' --output text)
    [[ "$state" == "available" ]] && break
    sleep 5
  done
  [[ "$state" == "available" ]] || { echo "!! EFS ${fs_id} is ${state}, not available"; exit 1; }

  # NFS from the tasks' security group only.
  efs_sg_name="${EFS_CREATION_TOKEN}-nfs"
  efs_sg=$(aws ec2 describe-security-groups --region "$AWS_REGION" \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=${efs_sg_name}" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
  if [[ -z "$efs_sg" || "$efs_sg" == "None" ]]; then
    efs_sg=$(aws ec2 create-security-group --region "$AWS_REGION" --vpc-id "$VPC_ID" \
      --group-name "$efs_sg_name" --description "NFS to the otlp-ingester sink outbox EFS from its tasks" \
      --query 'GroupId' --output text)
    echo "==> created security group ${efs_sg}"
  fi
  aws ec2 authorize-security-group-ingress --region "$AWS_REGION" --group-id "$efs_sg" \
    --ip-permissions "IpProtocol=tcp,FromPort=2049,ToPort=2049,UserIdGroupPairs=[{GroupId=${SECURITY_GROUP_ID}}]" \
    >/dev/null 2>&1 || true # already allowed

  # One mount target per task subnet (at most one per availability zone).
  existing_subnets=$(aws efs describe-mount-targets --file-system-id "$fs_id" --region "$AWS_REGION" \
    --query 'MountTargets[].SubnetId' --output text | tr '\t' ' ')
  existing_azs=$(aws efs describe-mount-targets --file-system-id "$fs_id" --region "$AWS_REGION" \
    --query 'MountTargets[].AvailabilityZoneName' --output text | tr '\t' ' ')
  IFS=',' read -r -a subnets <<< "$SUBNET_IDS"
  for subnet in "${subnets[@]}"; do
    subnet="${subnet// /}"
    [[ " ${existing_subnets} " == *" ${subnet} "* ]] && continue
    az=$(aws ec2 describe-subnets --subnet-ids "$subnet" --region "$AWS_REGION" \
      --query 'Subnets[0].AvailabilityZone' --output text)
    [[ " ${existing_azs} " == *" ${az} "* ]] && continue
    aws efs create-mount-target --region "$AWS_REGION" --file-system-id "$fs_id" \
      --subnet-id "$subnet" --security-groups "$efs_sg" >/dev/null
    existing_azs="${existing_azs} ${az}"
    echo "==> created EFS mount target in ${subnet} (${az})"
  done

  # The access point the task mounts: uid/gid 1000 is the image's node user.
  ap_id=$(aws efs describe-access-points --file-system-id "$fs_id" --region "$AWS_REGION" \
    --query "AccessPoints[?Tags[?Key=='Name' && Value=='${EFS_CREATION_TOKEN}']].AccessPointId | [0]" \
    --output text 2>/dev/null || true)
  if [[ -z "$ap_id" || "$ap_id" == "None" ]]; then
    ap_id=$(aws efs create-access-point --region "$AWS_REGION" --file-system-id "$fs_id" \
      --posix-user "Uid=1000,Gid=1000" \
      --root-directory "Path=/sink-outbox,CreationInfo={OwnerUid=1000,OwnerGid=1000,Permissions=750}" \
      --tags "Key=Name,Value=${EFS_CREATION_TOKEN}" \
      --query 'AccessPointId' --output text)
    echo "==> created EFS access point ${ap_id}"
  else
    echo "==> EFS access point exists: ${ap_id}"
  fi
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
     It mounts the sink outbox EFS (found by its creation token); the deploy
     role needs elasticfilesystem:DescribeFileSystems and DescribeAccessPoints.
EOF
