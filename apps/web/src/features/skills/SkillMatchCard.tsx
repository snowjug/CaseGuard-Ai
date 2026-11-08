'use client';

import type { SkillMatch } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  Button,
  ProvenanceBadge,
  RelativeTime,
  UiLink,
  cg,
  formatDateTimeUtc,
  formatProbability,
  type BadgeStatus,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { ZapIcon } from 'lucide-react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { useApiMutation } from '../../lib/api/hooks';
import { evidenceLinkHref } from '../../lib/deep-links';
import { SKILL_APPLICABILITY } from '../../lib/labels';
import { useToast } from '../../lib/toast';
import { useActorLabel } from '../quality/actors';
import { explainFailure, failureText, needsReload } from '../quality/failure';
import { GatedConfirm } from '../quality/GatedConfirm';
import { LifecycleBadge, StatusPill } from './Hints';
import { useRefreshSkills } from './hooks';
import { HINDSIGHT_LABEL, isWithdrawn } from './labels';
import { useSkillStyles } from './styles';

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

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceSunken,
    listStyle: 'none',
  },
  head: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[3] },
  tile: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '32px',
    height: '32px',
    flexShrink: 0,
    borderRadius: cg.radius.sm,
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    fontSize: tokens.fontSizeBase400,
  },
  headText: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    minWidth: 0,
    flex: '1 1 220px',
  },
  name: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  meter: {
    height: '6px',
    borderRadius: cg.radius.pill,
    backgroundColor: `color-mix(in srgb, ${cg.text} 10%, transparent)`,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: cg.radius.pill,
    backgroundImage: cg.gradientAccent,
  },
  rationale: { color: cg.textSecondary },
  conditions: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  condition: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  step: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
});

export interface SkillMatchCardProps {
  match: SkillMatch;
  caseId: string;
  /** The time cursor of the page. A match read at a cursor is read-only: applying is a present-time decision. */
  requestedAsOf: string | null;
}

/**
 * One skill match for a case: how well it fits using only the evidence available at the time shown, why (matched,
 * unmatched and excluded conditions with their evidence), the steps it recommends and, once applied, how closely they
 * were followed. The score is a model estimate. Applying is audited and needs the `skill:apply` permission.
 */
export function SkillMatchCard({ match, caseId, requestedAsOf }: SkillMatchCardProps) {
  const styles = useSkillStyles();
  const own = useStyles();
  const toast = useToast();
  const actor = useActorLabel();
  const apply = useApiMutation('skillMatches.apply', { invalidate: APPLY_INVALIDATES });
  const refresh = useRefreshSkills();
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
    <li className={own.card}>
      <div className={own.head}>
        <span className={own.tile} aria-hidden="true">
          <ZapIcon />
        </span>
        <div className={own.headText}>
          <h3 className={own.name}>
            <UiLink href={`/skills/${encodeURIComponent(match.skillId)}`} className={styles.link}>
              {match.skillName}
            </UiLink>
          </h3>
          <span className={styles.meta}>version {match.skillVersion}</span>
        </div>
        <div className={own.badges}>
          <LifecycleBadge lifecycle={match.lifecycle} size="sm" />
          <StatusPill status={applicability.status} label={applicability.label} />
          <ProvenanceBadge kind="estimated" label="Estimated match" size="small" />
        </div>
      </div>
      <div className={styles.tight}>
        <div className={own.meter} aria-hidden="true">
          <div className={own.fill} style={{ width: formatProbability(match.score, 0) }} />
        </div>
        <p className={styles.text}>
          <span className={styles.strong}>Match score {formatProbability(match.score, 0)}</span>{' '}
          (model estimate). Matched using only the evidence on record up to{' '}
          {formatDateTimeUtc(match.asOf, { seconds: true })}
          {requestedAsOf && requestedAsOf !== match.asOf
            ? ', the last event at or before the time cursor.'
            : '.'}
        </p>
      </div>
      <ExpandableText
        text={match.rationale}
        lines={3}
        label="match rationale"
        className={own.rationale}
      />

      <Accordion>
        <AccordionItem
          headingLevel={4}
          lazy={false}
          title={`Conditions: ${match.matchedTriggers.length} met, ${match.unmatchedTriggers.length} not met${
            match.exclusionsHit.length > 0 ? `, ${match.exclusionsHit.length} exclusion hit` : ''
          }`}
        >
          <div className={styles.stack}>
            {match.matchedTriggers.length > 0 ? (
              <ul className={own.conditions} aria-label="Conditions that hold">
                {match.matchedTriggers.map((trigger) => (
                  <li key={trigger.id} className={own.condition}>
                    <div className={styles.rowHead}>
                      <StatusPill status="productive" label="Met" />
                      {HINDSIGHT_MARK.test(trigger.description) ? (
                        <StatusPill status="uncertain" label={HINDSIGHT_LABEL} />
                      ) : null}
                    </div>
                    <p className={styles.text}>
                      {trigger.description}{' '}
                      <span className={styles.meta}>
                        (weight {formatProbability(trigger.weight, 0)})
                      </span>
                    </p>
                    {trigger.evidenceIds.length > 0 ? (
                      <ul
                        className={styles.chips}
                        aria-label={`Evidence for ${trigger.description}`}
                      >
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
              <ul className={own.conditions} aria-label="Conditions not met yet">
                {match.unmatchedTriggers.map((trigger) => (
                  <li key={trigger.id} className={own.condition}>
                    <div className={styles.rowHead}>
                      <StatusPill status="missing" label="Not met" />
                      {HINDSIGHT_MARK.test(trigger.description) ? (
                        <StatusPill status="uncertain" label={HINDSIGHT_LABEL} />
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
              <ul className={own.conditions} aria-label="Exclusions that apply">
                {match.exclusionsHit.map((exclusion) => (
                  <li key={exclusion.id} className={own.condition}>
                    <StatusPill status="unsupported" label="Exclusion hit" />
                    <p className={styles.text}>{exclusion.description}</p>
                  </li>
                ))}
              </ul>
            ) : null}
            {anyHindsight ? (
              <p className={styles.caption}>
                <span className={styles.strong}>{HINDSIGHT_LABEL}.</span> Conditions marked this way
                were derived from the source case with knowledge of its recorded cause, and they
                count towards the match score. The match is still checked only against the evidence
                on this case up to the time shown.
              </p>
            ) : null}
          </div>
        </AccordionItem>
        <AccordionItem
          headingLevel={4}
          lazy={false}
          defaultOpen={match.applied}
          title={`Recommended steps (${match.recommendedSteps.length})`}
        >
          <ol className={own.conditions} aria-label="Recommended steps">
            {match.recommendedSteps.map((step) => {
              const status = STEP_STATUS[step.status];
              return (
                <li key={step.stepId} className={own.step}>
                  <div className={styles.rowHead}>
                    <StatusPill status={status.status} label={status.label} />
                    <p className={styles.title}>{step.title}</p>
                  </div>
                  <p className={styles.text}>{step.instruction}</p>
                  <p className={styles.meta}>{step.rationale}</p>
                </li>
              );
            })}
          </ol>
        </AccordionItem>
      </Accordion>

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
          Applied {match.appliedAt ? <RelativeTime value={match.appliedAt} /> : ''} by{' '}
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
              <Button
                variant="secondary"
                icon={<ZapIcon />}
                aria-label={`Apply to this case: ${match.skillName}`}
              >
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
