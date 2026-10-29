#!/usr/bin/env bash
# DESTRUCTIVE: deletes the CaseGuard AI DEV resource group and everything in it.
#
# Deletes by resource group only (az group delete); no individual resource is deleted by this script.
#
# Safety rules, all checked before anything is deleted:
#   * the subscription is explicit (--subscription-id or CASEGUARD_SUBSCRIPTION_ID); a placeholder id is refused;
#   * the resource group name must start with rg-<workload>- and END WITH -dev;
#   * the resource group must carry the tags application=caseguard and environment=dev (created by main.bicep);
#   * the group must not have management locks (remove locks deliberately, outside this script);
#   * the target and the resources about to be deleted are listed, and you must type the EXACT resource group name.
# Use --dry-run for a rehearsal that performs only the read-only checks and prints what would be deleted.
#
# Key Vault, Azure OpenAI and Log Analytics use soft delete: after the group is gone their names stay reserved until the
# retention period ends. --purge-soft-deleted purges the soft-deleted Key Vault (only if purge protection is off) and
# Azure OpenAI account that belonged to this group; it never purges anything else. Alternatively change nameSalt on the
# next deployment to get fresh names.
#
# Usage:
#   infra/scripts/destroy-dev.sh --subscription-id <guid> [--resource-group rg-caseguard-dev] [options]
#
# Options:
#   --subscription-id <guid>        Target subscription (or CASEGUARD_SUBSCRIPTION_ID). Required.
#   --resource-group <name>         Default rg-caseguard-dev.
#   --workload <name>               Workload name used in the resource group prefix (default caseguard).
#   --confirm-resource-group <name> Pre-supplied confirmation for automation; must equal the resource group name exactly.
#   --purge-soft-deleted            After deletion, purge soft-deleted Key Vault / Azure OpenAI remnants of this group.
#   --no-wait                       Do not wait for the deletion (this also skips the purge step).
#   --dry-run                       Only run the read-only checks and print what would be deleted.
#   -h, --help                      Show this help.
#
# Requires bash 4+ and the Azure CLI.

set -euo pipefail
# shellcheck source=common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

subscription_id="${CASEGUARD_SUBSCRIPTION_ID:-}"
resource_group="rg-caseguard-dev"
workload="caseguard"
confirm_group=""
purge="false"
no_wait="false"
dry_run="false"

usage() {
  sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --subscription-id) subscription_id="${2:?--subscription-id needs a value}"; shift 2 ;;
    --resource-group) resource_group="${2:?--resource-group needs a value}"; shift 2 ;;
    --workload) workload="${2:?--workload needs a value}"; shift 2 ;;
    --confirm-resource-group) confirm_group="${2:?--confirm-resource-group needs a value}"; shift 2 ;;
    --purge-soft-deleted) purge="true"; shift ;;
    --no-wait) no_wait="true"; shift ;;
    --dry-run) dry_run="true"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) cg_die "Unknown option: $1 (see --help)" ;;
  esac
done

cg_assert_az
cg_assert_subscription_id "$subscription_id"

# Name rules first: they need no Azure call at all.
[[ "$resource_group" =~ ^[a-z0-9][a-z0-9-]*$ ]] || cg_die "Refusing: '$resource_group' is not a plain resource group name."
[[ "$resource_group" == *-dev ]] || cg_die "Refusing: '$resource_group' does not end with -dev. This script only deletes DEV environments."
required_prefix="rg-${workload}-"
[[ "$resource_group" == "$required_prefix"* ]] || cg_die "Refusing: '$resource_group' does not start with '$required_prefix', the CaseGuard naming convention."

cg_resolve_subscription "$subscription_id"

if ! az group show --subscription "$CG_SUB_ID" --name "$resource_group" --output none 2>/dev/null; then
  cg_info "Resource group '$resource_group' does not exist in '$CG_SUB_NAME' (or is not visible). Nothing to delete."
  exit 0
fi

application_tag="$(az group show --subscription "$CG_SUB_ID" --name "$resource_group" --query 'tags.application' --output tsv)"
environment_tag="$(az group show --subscription "$CG_SUB_ID" --name "$resource_group" --query 'tags.environment' --output tsv)"
group_location="$(az group show --subscription "$CG_SUB_ID" --name "$resource_group" --query location --output tsv)"
[[ "$application_tag" == "caseguard" ]] || cg_die "Refusing: '$resource_group' lacks the tag application=caseguard, so it was not created by this repository's templates."
[[ "$environment_tag" == "dev" ]] || cg_die "Refusing: '$resource_group' lacks the tag environment=dev."

lock_count="$(az lock list --subscription "$CG_SUB_ID" --resource-group "$resource_group" --query 'length(@)' --output tsv)"
[[ "$lock_count" == "0" ]] || cg_die "Refusing: the resource group (or resources in it) has $lock_count management lock(s). Remove them deliberately, then run this script again."

resource_lines="$(az resource list --subscription "$CG_SUB_ID" --resource-group "$resource_group" --query '[].[name,type]' --output tsv)"
resource_count=0
if [[ -n "$resource_lines" ]]; then resource_count="$(printf '%s\n' "$resource_lines" | wc -l | tr -d ' ')"; fi

cg_show_target "DELETE THE ENTIRE RESOURCE GROUP (irreversible)" "$resource_group" "dev" "$group_location" "Resources in the group: $resource_count"
if [[ -n "$resource_lines" ]]; then
  while IFS=$'\t' read -r name type; do printf '  - %s  [%s]\n' "$name" "$type"; done <<<"$resource_lines"
fi
printf '\n'

if [[ "$dry_run" == "true" ]]; then
  cg_info "DRY RUN: all safety checks passed. The resource group and the resources listed above would be deleted. Nothing was changed."
  exit 0
fi

cg_confirm "Type the resource group name ($resource_group) to DELETE it" "$resource_group" "$confirm_group"

delete_args=(group delete --subscription "$CG_SUB_ID" --name "$resource_group" --yes)
if [[ "$no_wait" == "true" ]]; then delete_args+=(--no-wait); fi
cg_info "Deleting the resource group ..."
az "${delete_args[@]}"
cg_info "Resource group deletion requested."

if [[ "$no_wait" == "true" ]]; then
  cg_info "Not waiting (--no-wait): soft-deleted remnants were not checked."
  exit 0
fi

group_marker="/resourcegroups/${resource_group,,}/"

vault_lines="$(az keyvault list-deleted --subscription "$CG_SUB_ID" --resource-type vault \
  --query '[].[name,properties.vaultId,properties.location,properties.purgeProtectionEnabled,properties.scheduledPurgeDate]' --output tsv 2>/dev/null || true)"
if [[ -n "$vault_lines" ]]; then
  while IFS=$'\t' read -r vault_name vault_id vault_location purge_protection purge_date; do
    [[ "${vault_id,,}" == *"$group_marker"* ]] || continue
    if [[ "$purge" == "true" && "${purge_protection,,}" != "true" ]]; then
      cg_info "Purging soft-deleted Key Vault $vault_name ..."
      az keyvault purge --subscription "$CG_SUB_ID" --name "$vault_name" --location "$vault_location"
    else
      cg_info "Key Vault $vault_name is soft-deleted (purge protection: ${purge_protection:-unknown}); its name stays reserved until ${purge_date:-the retention period ends}. Use a new nameSalt to redeploy sooner."
    fi
  done <<<"$vault_lines"
fi

account_lines="$(az cognitiveservices account list-deleted --subscription "$CG_SUB_ID" --query '[].[name,id,location]' --output tsv 2>/dev/null || true)"
if [[ -n "$account_lines" ]]; then
  while IFS=$'\t' read -r account_name account_id account_location; do
    [[ "${account_id,,}" == *"$group_marker"* ]] || continue
    if [[ "$purge" == "true" ]]; then
      cg_info "Purging soft-deleted Azure OpenAI/Cognitive Services account $account_name ..."
      az cognitiveservices account purge --subscription "$CG_SUB_ID" --name "$account_name" --resource-group "$resource_group" --location "$account_location"
    else
      cg_info "Account $account_name is soft-deleted; its name and custom subdomain stay reserved until it is purged (re-run with --purge-soft-deleted or purge it manually)."
    fi
  done <<<"$account_lines"
fi

cg_info "Log Analytics workspaces are soft-deleted for 14 days: redeploying with the same names within that window needs a different nameSalt (or recover/force-delete the workspace manually)."
