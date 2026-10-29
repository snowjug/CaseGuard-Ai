#!/usr/bin/env bash
# Shared helpers for the CaseGuard AI infrastructure scripts. Source it: . "$(dirname "$0")/common.sh"
#
# These helpers make every script behave the same way before it touches Azure (see common.ps1 for the PowerShell twin):
#   * strict mode,
#   * the TARGET (subscription id and name, tenant, resource group, environment, region) is printed first,
#   * nothing runs without explicit confirmation,
#   * a placeholder subscription id, or a parameter file that still holds placeholders, is refused,
#   * the subscription is always passed explicitly (--subscription); the az "current subscription" is never relied
#     upon and never changed.
#
# The scripts are HELPERS FOR A HUMAN OPERATOR. Nothing in this repository has run them against Azure. Read the
# script and docs/DEPLOYMENT.md before the first use. Requires bash 4+, the Azure CLI and, for smoke tests, curl.
# shellcheck shell=bash

set -euo pipefail

CG_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CG_INFRA_DIR="$(dirname "$CG_SCRIPT_DIR")"
CG_REPO_ROOT="$(dirname "$CG_INFRA_DIR")"
CG_BICEP_DIR="$CG_INFRA_DIR/bicep"

cg_die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cg_info() {
  printf '%s\n' "$*"
}

cg_require() {
  command -v "$1" >/dev/null 2>&1 || cg_die "'$1' was not found on PATH. $2"
}

cg_assert_az() {
  cg_require az "Install the Azure CLI (https://learn.microsoft.com/cli/azure/install-azure-cli) and run az login."
}

cg_assert_containerapp_cli() {
  az containerapp --help >/dev/null 2>&1 || cg_die "The az containerapp commands are not available. Run: az extension add --name containerapp --upgrade"
}

# Returns 0 (true) when the value is not a plausible real GUID: malformed, all zeros, one repeated digit or a known sample.
cg_is_placeholder_guid() {
  local id="${1:-}" digits first
  [[ -n "$id" ]] || return 0
  [[ "$id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || return 0
  digits="${id//-/}"
  digits="${digits,,}"
  first="${digits:0:1}"
  [[ -n "${digits//"$first"/}" ]] || return 0
  [[ "$digits" != "12345678123412341234123456789012" ]] || return 0
  return 1
}

cg_assert_subscription_id() {
  if cg_is_placeholder_guid "${1:-}"; then
    cg_die "Refusing to continue: '${1:-}' is missing or looks like a placeholder. Pass the real target subscription id with --subscription-id (or set CASEGUARD_SUBSCRIPTION_ID)."
  fi
}

# Looks up the explicitly requested subscription. Sets CG_SUB_ID, CG_SUB_NAME, CG_SUB_TENANT, CG_SUB_STATE.
cg_resolve_subscription() {
  local id="$1" out
  cg_assert_subscription_id "$id"
  out="$(az account show --subscription "$id" --query '[id,name,tenantId,state]' --output tsv 2>/dev/null)" ||
    cg_die "Subscription '$id' is not available to the signed-in az account. Run az login with an account that can see it. Nothing was changed."
  IFS=$'\t' read -r CG_SUB_ID CG_SUB_NAME CG_SUB_TENANT CG_SUB_STATE <<<"$out"
  [[ "$CG_SUB_ID" == "$id" ]] || cg_die "az returned subscription '$CG_SUB_ID' for the requested '$id'. Refusing to continue."
  [[ "$CG_SUB_STATE" == "Enabled" ]] || cg_die "Subscription '$CG_SUB_NAME' is in state '$CG_SUB_STATE', not Enabled. Refusing to continue."
}

# Usage: cg_show_target <action> <resource group> <environment> <region or empty> [detail lines...]
cg_show_target() {
  local action="$1" group="$2" environment="$3" region="$4"
  shift 4
  printf '\n==================== TARGET ====================\n'
  printf 'Action          : %s\n' "$action"
  printf 'Subscription    : %s\n' "$CG_SUB_NAME"
  printf 'Subscription id : %s\n' "$CG_SUB_ID"
  printf 'Tenant id       : %s\n' "$CG_SUB_TENANT"
  printf 'Resource group  : %s\n' "$group"
  printf 'Environment     : %s\n' "$environment"
  if [[ -n "$region" ]]; then printf 'Region          : %s\n' "$region"; fi
  local line
  for line in "$@"; do printf '%s\n' "$line"; done
  printf '================================================\n\n'
}

# Usage: cg_confirm <prompt> <expected text> [pre-supplied answer]. Exits unless the answer matches exactly.
cg_confirm() {
  local prompt="$1" expected="$2" answer="${3:-}"
  if [[ -z "$answer" ]]; then
    [[ -t 0 ]] || cg_die "Confirmation is required but stdin is not a terminal. Supply the confirmation text through the matching option."
    read -r -p "$prompt: " answer
  fi
  [[ "$answer" == "$expected" ]] || cg_die "Confirmation text did not match. Nothing was changed."
}

# Prints "<line number>:<line>" for every non-comment line of a parameter file that still contains a placeholder.
cg_placeholder_lines() {
  local file="$1"
  [[ -f "$file" ]] || cg_die "Parameter file not found: $file"
  sed -e 's@^[[:space:]]*//.*$@@' -e 's@[[:space:]]//[[:space:]].*$@@' "$file" |
    grep -nE '00000000-0000-0000-0000-000000000000|@example\.com|CHANGE-ME|<[A-Za-z][A-Za-z0-9 _-]*>' || true
}

cg_assert_no_placeholders() {
  local found
  found="$(cg_placeholder_lines "$1")"
  if [[ -n "$found" ]]; then
    printf 'The parameter file still contains placeholder values:\n%s\n' "$found" >&2
    cg_die "Copy it to a *.local.bicepparam file (git-ignored), put real values there and pass it with --parameter-file."
  fi
}

# Usage: cg_resolve_param_file <environment> [explicit file]. Prints the path.
cg_resolve_param_file() {
  local environment="$1" explicit="${2:-}"
  if [[ -n "$explicit" ]]; then
    [[ -f "$explicit" ]] || cg_die "Parameter file not found: $explicit"
    printf '%s\n' "$explicit"
    return
  fi
  if [[ -f "$CG_BICEP_DIR/main.${environment}.local.bicepparam" ]]; then
    printf '%s\n' "$CG_BICEP_DIR/main.${environment}.local.bicepparam"
  elif [[ -f "$CG_BICEP_DIR/main.${environment}.bicepparam" ]]; then
    printf '%s\n' "$CG_BICEP_DIR/main.${environment}.bicepparam"
  else
    cg_die "No parameter file found for environment '$environment'. Copy the matching *.bicepparam.template to main.${environment}.local.bicepparam and fill it in."
  fi
}

# Returns 0 when the parameter file assigns the given literal value to the given parameter (comments ignored).
cg_param_file_has() {
  local file="$1" name="$2" value="$3"
  sed -e 's@^[[:space:]]*//.*$@@' -e 's@[[:space:]]//[[:space:]].*$@@' "$file" |
    grep -qE "^param[[:space:]]+${name}[[:space:]]*=[[:space:]]*'${value}'[[:space:]]*$"
}

# Usage: cg_rg_name <workload> <dev|staging|prod>
cg_rg_name() {
  local workload="$1" environment="$2" short
  case "$environment" in
    dev) short="dev" ;;
    staging) short="stg" ;;
    prod) short="prd" ;;
    *) cg_die "Unknown environment '$environment'." ;;
  esac
  printf 'rg-%s-%s\n' "$workload" "$short"
}

# 32 random characters from an unambiguous alphabet plus three fixed characters that guarantee upper, lower and digit.
cg_random_password() {
  local body
  body="$(LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9_-' </dev/urandom | head -c 29 || true)"
  [[ ${#body} -eq 29 ]] || cg_die "Could not read random bytes to generate a password."
  printf '%sAb7\n' "$body"
}

# Short git commit, plus a timestamp when the working tree is dirty; timestamp outside git.
cg_default_image_tag() {
  local stamp sha dirty
  stamp="$(date -u +%Y%m%d%H%M%S)"
  if ! command -v git >/dev/null 2>&1; then
    printf '%s\n' "$stamp"
    return
  fi
  sha="$(git -C "$CG_REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)"
  if [[ -z "$sha" ]]; then
    printf '%s\n' "$stamp"
    return
  fi
  dirty="$(git -C "$CG_REPO_ROOT" status --porcelain 2>/dev/null || true)"
  if [[ -n "$dirty" ]]; then
    printf '%s-dirty%s\n' "$sha" "$stamp"
  else
    printf '%s\n' "$sha"
  fi
}

# Usage: cg_http_status <url> [attempts] [delay seconds]. Prints the final HTTP status, retrying cold starts and 5xx.
cg_http_status() {
  local url="$1" attempts="${2:-6}" delay="${3:-10}" i code
  cg_require curl "Install curl to run the smoke test or pass --skip-smoke-test."
  for ((i = 1; i <= attempts; i++)); do
    code="$(curl -sS -o /dev/null -L --max-time 60 -w '%{http_code}' "$url" 2>/dev/null || true)"
    [[ -n "$code" ]] || code="000"
    if [[ "$code" != "000" && "$code" -lt 500 ]]; then
      printf '%s\n' "$code"
      return
    fi
    if ((i < attempts)); then
      printf '  no usable answer yet (attempt %s/%s); waiting %ss for a cold start ...\n' "$i" "$attempts" "$delay" >&2
      sleep "$delay"
    fi
  done
  printf '%s\n' "$code"
}
