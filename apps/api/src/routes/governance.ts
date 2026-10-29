import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';
import {
  assignRoles,
  createPromptCatalog,
  exportData,
  getGovernanceSettings,
  listAuditEvents,
  listPrompts,
  listReviewDecisions,
  listUsers,
  updateGovernanceSection,
  verifyAuditChain,
} from '../services/governance';

/**
 * governance.get, governance.update, governance.prompts, governance.users, governance.assignRoles,
 * governance.audit, governance.auditVerify, governance.reviews, governance.export.
 * Owner: API platform workstream. Handlers only map HTTP to `services/governance`; permissions
 * (`governance:*`, `roles:manage`, `audit:read`, `export:data`) and validation come from the binder.
 */
export function governanceRoutes(infra: Infrastructure): HandlerMap {
  const prompts = createPromptCatalog(infra.now().toISOString());

  return {
    'governance.get': async ({ ctx }) => getGovernanceSettings(ctx),

    'governance.update': async ({ params, body, ctx }) =>
      updateGovernanceSection(ctx, params.section, body),

    'governance.prompts': async ({ ctx }) => ({ items: await listPrompts(ctx, prompts) }),

    'governance.users': async ({ ctx }) => ({ items: await listUsers(ctx) }),

    'governance.assignRoles': async ({ params, body, ctx }) =>
      assignRoles(ctx, params.userId, body),

    'governance.audit': async ({ query, ctx }) => listAuditEvents(ctx, query),

    'governance.auditVerify': async ({ ctx }) => verifyAuditChain(ctx),

    'governance.reviews': async ({ query, ctx }) => listReviewDecisions(ctx, query),

    'governance.export': async ({ body, ctx }) => exportData(ctx, body),
  };
}
