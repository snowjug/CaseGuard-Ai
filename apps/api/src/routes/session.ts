import type { AppConfig } from '@caseguard/config';
import type { Session } from '@caseguard/schemas';
import type { AuthContext } from '@caseguard/security';
import { DEV_PERSONAS } from '../db';
import type { HandlerMap } from '../http/route-binder';
import type { Infrastructure } from '../infrastructure';

/**
 * Persistent honesty notices shown by the UI. They describe what this environment actually is, so a
 * viewer is never left to assume that a stand-in is the real thing.
 */
export function buildNotices(
  config: AppConfig,
  tenantSynthetic: boolean,
  auth: AuthContext,
): string[] {
  const notices: string[] = [];
  if (tenantSynthetic || auth.synthetic) {
    notices.push('All data in this environment is synthetic. No real customer data is processed.');
  }
  if (auth.authMode === 'dev') {
    notices.push(
      'Development sign-in is active: personas are not real identities. It is disabled in staging and production.',
    );
  }
  if (config.ai.provider === 'deterministic') {
    notices.push(
      'Reasoning runs on the deterministic evidence engine. No cloud language model is connected in this environment.',
    );
  } else {
    notices.push(
      'Azure OpenAI is configured, but the integration has only been validated against mocks in this build.',
    );
  }
  if (config.storage.provider === 'local' && config.runtime.deployed) {
    notices.push('Case files are stored on local disk, which is not durable in a container.');
  }
  return notices;
}

export function sessionRoutes(_infra: Infrastructure): HandlerMap {
  return {
    'session.me': async ({ ctx }): Promise<Session> => {
      const tenant = await ctx.repos.governance.getTenant();
      return {
        user: {
          id: ctx.auth.userId,
          displayName: ctx.auth.displayName,
          email: ctx.auth.email ?? '',
          roles: [...ctx.auth.roles],
          synthetic: ctx.auth.synthetic,
        },
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          synthetic: tenant.synthetic,
        },
        permissions: [...ctx.auth.permissions],
        authMode: ctx.auth.authMode,
        environment: ctx.config.runtime.env,
        features: ctx.config.features,
        notices: buildNotices(ctx.config, tenant.synthetic, ctx.auth),
      };
    },

    'dev.personas': async ({ ctx }) => {
      const enabled = ctx.config.auth.mode === 'dev' && ctx.config.auth.devAuthEnabled;
      return {
        items: enabled ? [...DEV_PERSONAS] : [],
        enabled,
        notice: enabled
          ? 'Development personas are synthetic. Any client can claim one by sending a header, so this mode must never run outside a developer machine or a throw-away demo.'
          : 'Development identity is disabled in this environment. Sign in with Microsoft Entra ID.',
      };
    },
  };
}
