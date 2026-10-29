import type { SkillErrorCode, SkillAuditPayload, SkillResult } from './types';
import { skillFail } from './types';

/** Audit payload for one skill operation (the API adds sequence, role, correlation id and hash). */
export function auditPayload(args: {
  action: string;
  targetType: SkillAuditPayload['targetType'];
  targetId: string;
  actorId: string;
  now: string;
  outcome: SkillAuditPayload['outcome'];
  caseId?: string | null;
  details?: Record<string, unknown>;
}): SkillAuditPayload {
  return {
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    caseId: args.caseId ?? null,
    outcome: args.outcome,
    actorId: args.actorId,
    occurredAt: args.now,
    details: args.details ?? {},
  };
}

/**
 * A governance refusal. Every refusal carries its own audit payload so blocked attempts (for example
 * an unsafe publication attempt) are recorded exactly like successful ones.
 */
export function refusal<T = never>(args: {
  code: SkillErrorCode;
  message: string;
  action: string;
  targetType: SkillAuditPayload['targetType'];
  targetId: string;
  actorId: string;
  now: string;
  caseId?: string | null;
  details?: Record<string, unknown>;
}): SkillResult<T> {
  const outcome =
    args.code === 'version_conflict' || args.code === 'not_found' ? 'failure' : 'denied';
  const details = { ...(args.details ?? {}), code: args.code, reason: args.message };
  return skillFail<T>(
    args.code,
    args.message,
    details,
    auditPayload({
      action: `${args.action}_denied`,
      targetType: args.targetType,
      targetId: args.targetId,
      actorId: args.actorId,
      now: args.now,
      outcome,
      caseId: args.caseId ?? null,
      details,
    }),
  );
}
