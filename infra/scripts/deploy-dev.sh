#!/usr/bin/env bash
# Deploys the CaseGuard AI DEV environment to Azure in two stages, runs the migration job and smoke-tests the result.
#
# THIS COMMAND CREATES BILLABLE AZURE RESOURCES. It is a helper for a human operator and has never been run against Azure
# from this repository. Run what-if.sh first and read docs/DEPLOYMENT.md.
#
# Usage:
#   infra/scripts/deploy-dev.sh --subscription-id <guid> --location <region> [options]
#
# Flow (every az call is pinned to the explicit subscription; the az current subscription is never used or changed):
#   1. validate the target and the parameter file (no placeholders); print the TARGET; require the resource group name
#   2. stage 1: az deployment sub create with the Container Apps and the job switched off (registry still empty)
#   3. az acr build for the API and web images with an immutable tag
#   4. stage 2: az deployment sub create with deployContainerApps=true and the image tag
#   5. start the migrate job and wait for it
#   6. smoke test through the public web URL (the API has internal ingress only)
#
# Options:
#   --subscription-id <guid>        Target subscription (or CASEGUARD_SUBSCRIPTION_ID). Required.
#   --location <region>             Azure region, for example westeurope. Required.
#   --parameter-file <path>         Default: infra/bicep/main.dev.local.bicepparam if present, else main.dev.bicepparam
#                                   (which still holds placeholders and is therefore refused).
#   --workload <name>               Must equal the workloadName deployment parameter (default caseguard).
#   --image-tag <tag>               Immutable tag for both images (default: short git commit, + timestamp when dirty).
#   --api-dockerfile <path>         Relative to the repository root (default apps/api/Dockerfile).
#   --web-dockerfile <path>         Relative to the repository root (default apps/web/Dockerfile).
#   --skip-image-build              Reuse images that already exist under --image-tag.
#   --skip-migration                Do not start the migration job.
#   --skip-smoke-test               Skip the HTTP smoke test.
#   --generate-postgres-password    Generate a random PostgreSQL admin password for this run (stored only in Key Vault,
#                                   never printed; it REPLACES the stored password on every run). Otherwise the password
#                                   comes from CASEGUARD_POSTGRES_ADMIN_PASSWORD or a hidden prompt.
#   --confirm-resource-group <name> Pre-supplied confirmation for automation; must equal the resource group name exactly.
#   --rbac-wait <seconds>           Pause before stage 2 so stage 1 role assignments propagate (default 60).
#   -h, --help                      Show this help.
#
# Requires bash 4+, the Azure CLI (with the containerapp extension), and curl for the smoke test.

set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

environment="dev"
subscription_id="${CASEGUARD_SUBSCRIPTION_ID:-}"
location=""
parameter_file=""
workload="caseguard"
image_tag=""
api_dockerfile="apps/api/Dockerfile"
web_dockerfile="apps/web/Dockerfile"
api_repository="caseguard-api"
web_repository="caseguard-web"
skip_build="false"
skip_migration="false"
skip_smoke="false"
generate_password="false"
confirm_group=""
rbac_wait="60"

usage() {
  sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription-id) subscription_id="${2:?--subscription-id needs a value}"; shift 2 ;;
    --location) location="${2:?--location needs a value}"; shift 2 ;;
    --parameter-file) parameter_file="${2:?--parameter-file needs a value}"; shift 2 ;;
    --workload) workload="${2:?--workload needs a value}"; shift 2 ;;
    --image-tag) image_tag="${2:?--image-tag needs a value}"; shift 2 ;;
    --api-dockerfile) api_dockerfile="${2:?--api-dockerfile needs a value}"; shift 2 ;;
    --web-dockerfile) web_dockerfile="${2:?--web-dockerfile needs a value}"; shift 2 ;;
    --skip-image-build) skip_build="true"; shift ;;
    --skip-migration) skip_migration="true"; shift ;;
    --skip-smoke-test) skip_smoke="true"; shift ;;
    --generate-postgres-password) generate_password="true"; shift ;;
    --confirm-resource-group) confirm_group="${2:?--confirm-resource-group needs a value}"; shift 2 ;;
    --rbac-wait) rbac_wait="${2:?--rbac-wait needs a value}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) cg_die "Unknown option: $1 (see --help)" ;;
  esac
done

[[ -n "$location" ]] || cg_die "--location is required."
[[ "$rbac_wait" =~ ^[0-9]+$ ]] || cg_die "--rbac-wait must be a whole number of seconds."

cg_assert_subscription_id "$subscription_id"

param_file="$(cg_resolve_param_file "$environment" "$parameter_file")"
cg_assert_no_placeholders "$param_file"

cg_assert_az
cg_assert_containerapp_cli

cg_resolve_subscription "$subscription_id"
resource_group="$(cg_rg_name "$workload" "$environment")"
if [[ -z "$image_tag" ]]; then image_tag="$(cg_default_image_tag)"; fi

needs_password="true"
if cg_param_file_has "$param_file" postgresAuthMode entra; then needs_password="false"; fi

cg_show_target "DEPLOY (creates and updates Azure resources)" "$resource_group" "$environment" "$location" \
  "Parameter file  : $param_file" \
  "Image tag       : $image_tag" \
  "This creates billable resources. The dev database firewall opens to Azure-hosted clients unless you changed it."
cg_confirm "Type the resource group name ($resource_group) to deploy" "$resource_group" "$confirm_group"

if [[ "$needs_password" == "true" ]]; then
  if [[ -n "${CASEGUARD_POSTGRES_ADMIN_PASSWORD:-}" ]]; then
    cg_info "Using the PostgreSQL password from CASEGUARD_POSTGRES_ADMIN_PASSWORD."
  elif [[ "$generate_password" == "true" ]]; then
    CASEGUARD_POSTGRES_ADMIN_PASSWORD="$(cg_random_password)"
    cg_info "Generated a random PostgreSQL password. It is stored in Key Vault only and is not displayed."
  else
    [[ -t 0 ]] || cg_die "No PostgreSQL password: set CASEGUARD_POSTGRES_ADMIN_PASSWORD or pass --generate-postgres-password."
    read -r -s -p "PostgreSQL administrator password (16+ characters): " CASEGUARD_POSTGRES_ADMIN_PASSWORD
    printf '\n'
  fi
  [[ ${#CASEGUARD_POSTGRES_ADMIN_PASSWORD} -ge 16 ]] || cg_die "The PostgreSQL administrator password must be at least 16 characters."
  export CASEGUARD_POSTGRES_ADMIN_PASSWORD
fi

# Usage: run_deployment <name> <true|false for apps>; the deployment name doubles as the outputs lookup key.
run_deployment() {
  local name="$1" with_apps="$2"
  export CASEGUARD_DEPLOY_APPS="$with_apps"
  export CASEGUARD_IMAGE_TAG="$image_tag"
  cg_info "Deploying '$name' (apps: $with_apps) ..."
  az deployment sub create \
    --subscription "$CG_SUB_ID" \
    --location "$location" \
    --name "$name" \
    --parameters "$param_file" \
    --only-show-errors \
    --output none ||
    cg_die "Deployment '$name' failed. Inspect it with: az deployment sub show --subscription $CG_SUB_ID --name $name (see docs/runbooks/failed-deployment.md)"
}

# Usage: deployment_output <deployment name> <output name>
deployment_output() {
  az deployment sub show --subscription "$CG_SUB_ID" --name "$1" --query "properties.outputs.$2.value" --output tsv
}

stamp="$(date -u +%Y%m%d%H%M%S)"
infra_deployment="caseguard-dev-infra-$stamp"
apps_deployment="caseguard-dev-apps-$stamp"

# Stage 1: everything except the apps and the job, because the registry is still empty.
run_deployment "$infra_deployment" "false"
registry="$(deployment_output "$infra_deployment" containerRegistryName)"

if [[ "$skip_build" == "true" ]]; then
  cg_info "Skipping the image build; the registry must already contain tag $image_tag."
else
  # Next.js bakes the /api rewrite target and NEXT_PUBLIC_* into the web image, so the web build needs values from this
  # environment. They are non-secret and come from the stage-1 deployment outputs.
  mapfile -t web_build_args < <(az deployment sub show --subscription "$CG_SUB_ID" --name "$infra_deployment" \
    --query 'properties.outputs.webBuildArguments.value[]' --output tsv)
  for pair in "api|$api_repository|$api_dockerfile" "web|$web_repository|$web_dockerfile"; do
    IFS='|' read -r key repository dockerfile <<<"$pair"
    [[ -f "$CG_REPO_ROOT/$dockerfile" ]] || cg_die "Dockerfile not found: $CG_REPO_ROOT/$dockerfile. Pass --api-dockerfile/--web-dockerfile (paths relative to the repository root)."
    build_args=(--build-arg "GIT_COMMIT=$image_tag")
    if [[ "$key" == "web" ]]; then
      for arg in "${web_build_args[@]}"; do build_args+=(--build-arg "$arg"); done
    fi
    cg_info "Building $repository:$image_tag in registry $registry (az acr build) ..."
    az acr build \
      --subscription "$CG_SUB_ID" \
      --registry "$registry" \
      --image "$repository:$image_tag" \
      --file "$dockerfile" \
      "${build_args[@]}" \
      "$CG_REPO_ROOT" ||
      cg_die "az acr build failed for $repository. If ACR Tasks is unavailable in your subscription, build locally with docker and push to $registry.azurecr.io, then re-run with --skip-image-build --image-tag $image_tag."
  done
fi

# Stage 2: the apps and the job. Role assignments from stage 1 need a moment to propagate.
if ((rbac_wait > 0)); then
  cg_info "Waiting ${rbac_wait}s for role assignments to propagate ..."
  sleep "$rbac_wait"
fi
run_deployment "$apps_deployment" "true"
job_name="$(deployment_output "$apps_deployment" migrateJobName)"
web_url="$(deployment_output "$apps_deployment" webUrl)"
api_app="$(deployment_output "$apps_deployment" apiAppName)"

if [[ "$skip_migration" != "true" ]]; then
  cg_info "Starting the migration job $job_name ..."
  execution="$(az containerapp job start --subscription "$CG_SUB_ID" --resource-group "$resource_group" --name "$job_name" --query name --output tsv)"
  deadline=$((SECONDS + 1200))
  status=""
  while ((SECONDS < deadline)); do
    sleep 15
    status="$(az containerapp job execution show --subscription "$CG_SUB_ID" --resource-group "$resource_group" --name "$job_name" --job-execution-name "$execution" --query properties.status --output tsv)"
    cg_info "  migration execution $execution: $status"
    case "$status" in Succeeded | Failed | Stopped | Degraded) break ;; esac
  done
  [[ "$status" == "Succeeded" ]] || cg_die "The migration job ended with status '${status:-unknown}'. The API will not become ready. See docs/runbooks/broken-migration.md. Do not retry blindly."
fi

if [[ "$skip_smoke" != "true" ]]; then
  printf '\nSmoke test (through the public web URL; the API is internal-only):\n'
  root_status="$(cg_http_status "$web_url")"
  me_status="$(cg_http_status "${web_url%/}/api/v1/me")"
  printf '  GET /              -> %s (expect 200-399)\n' "$root_status"
  printf '  GET /api/v1/me     -> %s (expect 401: the API answered through the web proxy and rejected the missing token)\n' "$me_status"
  az containerapp revision list --subscription "$CG_SUB_ID" --resource-group "$resource_group" --name "$api_app" \
    --query "[].{revision:name,active:properties.active,health:properties.healthState,running:properties.runningState}" --output table
  if ((root_status < 200 || root_status >= 400)) || [[ "$me_status" != "401" ]]; then
    cg_die "Smoke test FAILED. Do not treat this deployment as working. See docs/DEPLOYMENT.md (post-deploy smoke tests) and docs/runbooks."
  fi
  cg_info "Smoke test passed."
fi

printf '\nDeployment finished.\n'
printf 'Web URL         : %s\n' "$web_url"
printf 'Resource group  : %s\n' "$resource_group"
printf 'Image tag       : %s\n' "$image_tag"
printf 'Next: add the web URL as a SPA redirect URI in the Entra app registration (docs/ENTRA_ID_SETUP.md) before signing in.\n'
