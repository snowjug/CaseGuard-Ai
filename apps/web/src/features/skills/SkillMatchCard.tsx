'use client';

import type { SkillMatch } from '@caseguard/schemas';
import {
  Notice,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatDateTimeUtc,
  formatProbability,
  type BadgeStatus,
} from '@caseguard/ui';
import { Button } from '@fluentui/react-components';
import { FlashRegular } from '@fluentui/react-icons';
import { useApiMutation } from '../../lib/api/hooks';
import { evidenceLinkHref } from '../../lib/deep-links';
import { SKILL_APPLICABILITY } from '../../lib/labels';
import { useToast } from '../../lib/toast';
import { useActorLabel } from '../quality/actors';
import { ClampedText } from '../quality/ClampedText';
import { explainFailure, failureText, needsReload } from '../quality/failure';
import { GatedConfirm } from '../quality/GatedConfirm';
import { useInsightStyles } from '../quality/styles';
import { useRefreshSkills } from './hooks';
import { LIFECYCLE_BADGES, isWithdrawn } from './labels';

const STEP_STATUS: Record<
  SkillMatch['recommendedSteps'][number]['status'],
  { label: string; status: BadgeStatus }
> = {
  recommended_next: { label: 'Recommended next', status: 'productive' },
  done: { label: 'Done', status: 'neutral' },
  skipped: { label: 'Skipped', status: 'missing' },
  pending: { label: 'Not reached yet', status: 'missing' },
};

/** The API marks a trigger it learned from the source case with knowledge of that case's cause. */
const HINDSIGHT_MARK = /\(hindsight-informed\)/i;

/** Routes whose cached data is stale once a skill has been applied to a case. */
export const APPLY_INVALIDATES = [
  'skillMatches.list',
  'skills.get',
  'skills.list',
  'analytics.overview',
  'compare.cases',
  'dashboard.commandCenter',
] as const;

export interface SkillMatchCardProps {
  match: SkillMatch;
  caseId: string;
  /** The time cursor of the page. A match read at a cursor is read-only: applying is a present-time decision. */
  requestedAsOf: string | null;
}

/**
 * One SkillDNA match for a case: how well it fits using only the evidence available at the time shown, why (matched,
 * unmatched and excluded conditions with their evidence), the steps it recommends and, once applied, how closely they
 * were followed. The score is a model estimate. Applying is audited and needs the `skill:apply` permission.
 */
export function SkillMatchCard({ match, caseId, requestedAsOf }: SkillMatchCardProps) {
  const styles = useInsightStyles();
  const toast = useToast();
  const actor = useActorLabel();
  const apply = useApiMutation('skillMatches.apply', { invalidate: APPLY_INVALIDATES });
  const refresh = useRefreshSkills();
  const lifecycle = LIFECYCLE_BADGES[match.lifecycle];
  const applicability = SKILL_APPLICABILITY[match.applicability];
  const withdrawn = isWithdrawn(match.lifecycle);
  const blockedReason = requestedAsOf
    ? 'You are looking at an earlier moment. Applying a skill is recorded at the current time, so clear the time cursor first.'
    : withdrawn
      ? `This skill has been ${match.lifecycle}, so it can no longer be applied.`
      : null;
  const anyHindsight =
    match.matchedTriggers.some((trigger) => HINDSIGHT_MARK.test(trigger.description)) ||
    match.unmatchedTriggers.some((trigger) => HINDSIGHT_MARK.test(trigger.description));

  return (
    <li className={styles.item}>
      <div className={styles.itemHead}>
        <FlashRegular aria-hidden="true" />
        <h3 className={styles.itemTitle}>
          <UiLink href={`/skills/${encodeURIComponent(match.skillId)}`} className={styles.link}>
            {match.skillName}
          </UiLink>
        </h3>
        <span className={styles.meta}>version {match.skillVersion}</span>
      </div>
      <div className={styles.itemHead}>
        <StatusBadge status={lifecycle.status} label={lifecycle.label} size="small" />
        <StatusBadge status={applicability.status} label={applicability.label} size="small" />
        <ProvenanceBadge kind="estimated" label="Estimated match" size="small" />
      </div>
      <p className={styles.text}>
        <span className={styles.strong}>Match score {formatProbability(match.score, 0)}</span>{' '}
        (model estimate). Matched using only the evidence on record up to{' '}
        {formatDateTimeUtc(match.asOf, { seconds: true })}
        {requestedAsOf && requestedAsOf !== match.asOf
          ? ', the last event at or before the time cursor.'
          : '.'}
      </p>
      <ClampedText text={match.rationale} lines={3} label="match rationale" />

      <details className={styles.details}>
        <summary className={styles.summary}>
          Conditions: {match.matchedTriggers.length} met, {match.unmatchedTriggers.length} not met
          {match.exclusionsHit.length > 0 ? `, ${match.exclusionsHit.length} exclusion hit` : ''}
        </summary>
        <div className={styles.detailsBody}>
          {match.matchedTriggers.length > 0 ? (
            <ul className={styles.list} aria-label="Conditions that hold">
              {match.matchedTriggers.map((trigger) => (
                <li key={trigger.id} className={styles.detailsBody}>
                  <div className={styles.itemHead}>
                    <StatusBadge status="productive" label="Met" size="small" />
                    {HINDSIGHT_MARK.test(trigger.description) ? (
                      <StatusBadge status="uncertain" label="Learned with hindsight" size="small" />
                    ) : null}
                  </div>
                  <p className={styles.text}>
                    {trigger.description}{' '}
                    <span className={styles.meta}>
                      (weight {formatProbability(trigger.weight, 0)})
                    </span>
                  </p>
                  {trigger.evidenceIds.length > 0 ? (
                    <ul className={styles.chips} aria-label={`Evidence for ${trigger.description}`}>
                      {trigger.evidenceIds.map((id) => (
                        <li key={id}>
                          <UiLink
                            href={evidenceLinkHref(caseId, { type: 'evidence', id })}
                            className={styles.chip}
                          >
                            Evidence {id.slice(0, 12)}
                          </UiLink>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {match.unmatchedTriggers.length > 0 ? (
            <ul className={styles.list} aria-label="Conditions not met yet">
              {match.unmatchedTriggers.map((trigger) => (
                <li key={trigger.id} className={styles.detailsBody}>
                  <div className={styles.itemHead}>
                    <StatusBadge status="missing" label="Not met" size="small" />
                    {HINDSIGHT_MARK.test(trigger.description) ? (
                      <StatusBadge status="uncertain" label="Learned with hindsight" size="small" />
                    ) : null}
                  </div>
                  <p className={styles.text}>
                    {trigger.description}{' '}
                    <span className={styles.meta}>
                      (weight {formatProbability(trigger.weight, 0)})
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {match.exclusionsHit.length > 0 ? (
            <ul className={styles.list} aria-label="Exclusions that apply">
              {match.exclusionsHit.map((exclusion) => (
                <li key={exclusion.id} className={styles.detailsBody}>
                  <StatusBadge status="unsupported" label="Exclusion hit" size="small" />
                  <p className={styles.text}>{exclusion.description}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {anyHindsight ? (
            <Notice variant="info" compact title="Learned with hindsight">
              Conditions marked this way were derived from the source case with knowledge of its
              recorded cause, and they count towards the match score. The match is still checked
              only against the evidence on this case up to the time shown.
            </Notice>
          ) : null}
        </div>
      </details>

      <details className={styles.details} open={match.applied || undefined}>
        <summary className={styles.summary}>
          Recommended steps ({match.recommendedSteps.length})
        </summary>
        <ol className={styles.list} aria-label="Recommended steps">
          {match.recommendedSteps.map((step) => {
            const status = STEP_STATUS[step.status];
            return (
              <li key={step.stepId} className={styles.detailsBody}>
                <div className={styles.itemHead}>
                  <StatusBadge status={status.status} label={status.label} size="small" />
                  <p className={styles.itemTitle}>{step.title}</p>
                </div>
                <p className={styles.text}>{step.instruction}</p>
                <p className={styles.meta}>{step.rationale}</p>
              </li>
            );
          })}
        </ol>
      </details>

      {match.conformance ? (
        <p className={styles.text}>
          <span className={styles.strong}>
            Plan followed: {match.conformance.stepsFollowed} of {match.conformance.stepsTotal} steps
            ({formatProbability(match.conformance.score, 0)})
          </span>
          . Conformance describes the process, not the person.
        </p>
      ) : null}

      {match.applied ? (
        <p className={styles.meta}>
          Applied {match.appliedAt ? formatDateTimeUtc(match.appliedAt) : ''} by{' '}
          {actor(match.appliedBy)}.
          {withdrawn
            ? ` The skill has since been ${match.lifecycle}; the application is kept.`
            : ''}
        </p>
      ) : (
        <div className={styles.actions}>
          <GatedConfirm
            permission="skill:apply"
            blockedReason={blockedReason}
            trigger={
              <Button appearance="primary" aria-label={`Apply to this case: ${match.skillName}`}>
                Apply to this case
              </Button>
            }
            title="Apply this skill to the case?"
            confirmLabel="Apply skill"
            onConfirm={async () => {
              try {
                await apply.mutateAsync({ params: { caseId, matchId: match.id } });
                toast.success('Skill applied', {
                  body: 'The adoption is recorded in the audit log with how closely the plan was followed.',
                });
              } catch (error) {
                const failure = explainFailure(error);
                if (needsReload(failure)) refresh();
                throw new Error(failureText(failure), { cause: error });
              }
            }}
          >
            <p>
              Applying records that the guided plan of “{match.skillName}” was adopted for this
              case, with its conformance and an estimate of its effect. It does not change the case
              or run anything. The record is audited and applying again does nothing new.
            </p>
          </GatedConfirm>
          {blockedReason ? <span className={styles.meta}>{blockedReason}</span> : null}
        </div>
      )}
    </li>
  );
}
