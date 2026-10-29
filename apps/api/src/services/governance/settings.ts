import type {
  GovernanceSection,
  GovernanceSettings,
  UpdateGovernanceBody,
} from '@caseguard/schemas';
import { ValidationFailedError, VersionConflictError } from '../../errors';
import type { RequestContext } from '../../http/request-context';
import { changedKeys } from './changed-keys';
import { validateSectionValue } from './section-schemas';

export type SettingsContext = Pick<RequestContext, 'repos' | 'auth' | 'audit'>;

const MIN_CHANGE_NOTE_LENGTH = 5;

/**
 * Updates one governed section: validates the value (422 with field paths), refuses a stale
 * `expectedVersion` (409), and commits the new version together with its audit event in ONE
 * transaction, so a setting can never change without a record (or the other way round).
 *
 * The audit event carries `{ section, fromVersion, toVersion, changedKeys }`: paths of the changed
 * settings, never their values. The reviewer-facing justification (`changeNote`) is stored with the
 * setting itself.
 */
export async function updateGovernanceSection(
  ctx: SettingsContext,
  section: GovernanceSection,
  body: UpdateGovernanceBody,
): Promise<GovernanceSettings> {
  const value = validateSectionValue(section, body.value);
  const changeNote = body.changeNote.trim();
  if (changeNote.length < MIN_CHANGE_NOTE_LENGTH) {
    throw new ValidationFailedError('A change note is required', [
      {
        path: 'body.changeNote',
        message: `Describe the change in at least ${MIN_CHANGE_NOTE_LENGTH} characters.`,
      },
    ]);
  }

  return ctx.repos.transaction(async (tx) => {
    const current = (await tx.governance.getSettings())[section];
    if (current.version !== body.expectedVersion) {
      throw new VersionConflictError(
        `Governance section ${section}`,
        body.expectedVersion,
        current.version,
      );
    }
    const updated = await tx.governance.updateSection(section, value, {
      expectedVersion: body.expectedVersion,
      changeNote,
      by: ctx.auth.userId,
    });
    const next = updated[section];
    await ctx.audit(
      {
        action: 'governance.settings.updated',
        targetType: 'governance_section',
        targetId: section,
        caseId: null,
        outcome: 'success',
        details: {
          section,
          fromVersion: current.version,
          toVersion: next.version,
          changedKeys: changedKeys(current.value, next.value),
        },
      },
      tx,
    );
    return updated;
  });
}
