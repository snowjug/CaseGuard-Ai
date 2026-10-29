#!/usr/bin/env bash
# Shows what a CaseGuard AI deployment WOULD change (az deployment sub what-if). Read-only, but it still talks to Azure.
#
# Usage:
#   infra/scripts/what-if.sh --subscription-id <guid> --location <region> [options]
#
# Options:
#   --subscription-id <guid>   Target subscription (or CASEGUARD_SUBSCRIPTION_ID). Never defaults to the az current one.
#   --location <region>        Deployment location, for example westeurope. Required.
#   --environment <env>        dev (default), staging or prod. Selects main.<env>.local.bicepparam, else main.dev.bicepparam.
#   --parameter-file <path>    Explicit parameter file.
#   --workload <name>          Must equal the workloadName deployment parameter (default caseguard).
#   --deploy-apps              Preview stage 2 (apps and migration job); needs --image-tag.
#   --image-tag <tag>          Immutable image tag for --deploy-apps.
#   --yes                      Skip the typed confirmation of this read-only command (CI). Not available in deploy/destroy.
#   -h, --help                 Show this help.
#
# The PostgreSQL admin password is read from CASEGUARD_POSTGRES_ADMIN_PASSWORD. For a What-If only, a throw-away random
# value is generated when it is not set; it is never stored or sent anywhere that persists.
#
# Helper for a human operator; never run against Azure from this repository. Requires bash 4+ and the Azure CLI.

set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

subscription_id="${CASEGUARD_SUBSCRIPTION_ID:-}"
location=""
environment="dev"
parameter_file=""
workload="caseguard"
deploy_apps="false"
image_tag=""
assume_yes="false"

usage() {
  sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription-id) subscription_id="${2:?--subscription-id needs a value}"; shift 2 ;;
    --location) location="${2:?--location needs a value}"; shift 2 ;;
    --environment) environment="${2:?--environment needs a value}"; shift 2 ;;
    --parameter-file) parameter_file="${2:?--parameter-file needs a value}"; shift 2 ;;
    --workload) workload="${2:?--workload needs a value}"; shift 2 ;;
    --deploy-apps) deploy_apps="true"; shift ;;
    --image-tag) image_tag="${2:?--image-tag needs a value}"; shift 2 ;;
    --yes) assume_yes="true"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) cg_die "Unknown option: $1 (see --help)" ;;
  esac
done

case "$environment" in dev | staging | prod) ;; *) cg_die "--environment must be dev, staging or prod." ;; esac
[[ -n "$location" ]] || cg_die "--location is required."
if [[ "$deploy_apps" == "true" && -z "$image_tag" ]]; then cg_die "--deploy-apps requires --image-tag."; fi

cg_assert_az
cg_assert_subscription_id "$subscription_id"

param_file="$(cg_resolve_param_file "$environment" "$parameter_file")"
cg_assert_no_placeholders "$param_file"

cg_resolve_subscription "$subscription_id"
resource_group="$(cg_rg_name "$workload" "$environment")"
stage="stage 1 (infrastructure only)"
if [[ "$deploy_apps" == "true" ]]; then stage="stage 2 (apps + migration job)"; fi

cg_show_target "WHAT-IF (read-only) of $stage" "$resource_group" "$environment" "$location" "Parameter file  : $param_file"
if [[ "$environment" == "prod" ]]; then
  printf 'PRODUCTION target. What-If changes nothing, but review the result with your change approver.\n\n'
fi

if [[ "$assume_yes" != "true" ]]; then
  cg_confirm "Type yes to run the What-If" "yes"
fi

export CASEGUARD_DEPLOY_APPS="$deploy_apps"
export CASEGUARD_IMAGE_TAG="$image_tag"
if [[ -z "${CASEGUARD_POSTGRES_ADMIN_PASSWORD:-}" ]]; then
  CASEGUARD_POSTGRES_ADMIN_PASSWORD="$(cg_random_password)"
  export CASEGUARD_POSTGRES_ADMIN_PASSWORD
fi

deployment_name="caseguard-${environment}-whatif-$(date -u +%Y%m%d%H%M%S)"
cg_info "Running what-if '$deployment_name' ..."
az deployment sub what-if \
  --subscription "$CG_SUB_ID" \
  --location "$location" \
  --name "$deployment_name" \
  --parameters "$param_file"
cg_info "What-If finished. Nothing was changed."
