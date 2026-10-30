'use client';

import {
  SYNTHETIC_EFFECTIVENESS_NOTICE,
  type SkillDetail,
  type SkillEffectiveness,
  type SkillMatch,
} from '@caseguard/schemas';
import {
  EmptyState,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  UiLink,
  formatDuration,
  formatProbability,
} from '@caseguard/ui';
import { Button, Field, Select } from '@fluentui/react-components';
import { PeopleCommunityRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useApiMutation } from '../../lib/api/hooks';
import { formatNumber } from '../../lib/format';
import { SKILL_APPLICABILITY } from '../../lib/labels';
import { useToast } from '../../lib/toast';
import { explainFailure, failureText } from '../quality/failure';
import { GatedConfirm } from '../quality/GatedConfirm';
import { useInsightStyles } from '../quality/styles';
import { APPLY_INVALIDATES, SkillMatchCard } from './SkillMatchCard';
import { useAnalysedCases } from './hooks';
import { isWithdrawn } from './labels';
import { PRECEDENT_READING_GUIDE, precedentHeadline, precedentTitle } from './precedent';

/** The skill's time to diagnosis against its baseline, in words (both figures come from the API, estimated). */
export function timeComparison(effectiveness: SkillEffectiveness): string {
  const { avgTimeToDiagnosisMinutes: withSkill, baselineAvgTimeToDiagnosisMinutes: baseline } =
    effectiveness;
  if (withSkill === null || baseline === null) return 'Not enough data';
  const relation =
    withSkill === baseline ? 'the same as' : withSkill < baseline ? 'shorter than' : 'longer than';
  return `${formatDuration(withSkill)} with the skill, ${relation} the ${formatDuration(baseline)} baseline`;
}

/** Estimated token savings in words: a negative saving means more tokens than the baseline, and is never shown as a win. */
export function tokenSavingsText(pct: number | null): string {
  if (pct === null) return 'Not enough data';
  if (pct === 0) return 'No difference from the baseline';
  const size = `${formatNumber(Math.abs(pct), { maximumFractionDigits: 1 })}%`;
  return pct > 0
    ? `${size} fewer tokens than the baseline`
    : `${size} more tokens than the baseline`;
}

const BASELINE_CAVEAT =
  'The simulated baseline has no waiting between steps, so a recorded time reads longer than it by construction. Treat these figures as a rough reference only.';
const SECONDARY_TITLE = 'Secondary: against a simulated baseline';

function Effectiveness({ effectiveness }: { effectiveness: SkillEffectiveness }) {
  const styles = useInsightStyles();
  const precedent =
    effectiveness.precedent && effectiveness.precedent.cases > 0 ? effectiveness.precedent : null;
  const hasBaselineFigure =
    (effectiveness.avgTimeToDiagnosisMinutes !== null &&
      effectiveness.baselineAvgTimeToDiagnosisMinutes !== null) ||
    effectiveness.estimatedTokenSavingsPct !== null;
  const baseline = (
    <>
      <p className={styles.text}>
        <span className={styles.strong}>Time to diagnosis:</span> {timeComparison(effectiveness)}.
      </p>
      <p className={styles.text}>
        <span className={styles.strong}>Estimated token effect:</span>{' '}
        {tokenSavingsText(effectiveness.estimatedTokenSavingsPct)}.
      </p>
      {hasBaselineFigure ? (
        <p className={styles.meta}>
          {BASELINE_CAVEAT}
          {precedent ? ' The comparison above is the like-for-like one.' : ''}
        </p>
      ) : null}
    </>
  );
  return (
    <Panel
      title="Effectiveness"
      description="What happened on the cases this skill was applied to."
      help="Effectiveness is aggregated per skill from the cases where it was applied. Where the skill came from a recorded case, each application is compared with that case’s recorded path: the same kind of figure measured the same way, but a different case and no control group. Every application is also compared with a simulated baseline, which has no waiting between steps, so recorded times read longer than it by construction. With very few applications these are demonstrations of the measurement, not evidence that a skill works. No engineer-level data is used."
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          {effectiveness.synthetic ? <ProvenanceBadge kind="synthetic" /> : null}
        </>
      }
    >
      <ul className={styles.tiles} aria-label="Effectiveness">
        <li className={styles.tile}>
          <p className={styles.tileLabel}>Applications</p>
          <p className={styles.tileValue}>
            {formatNumber(effectiveness.applications, { maximumFractionDigits: 0 })}
          </p>
        </li>
        <li className={styles.tile}>
          <p className={styles.tileLabel}>Cases matched</p>
          <p className={styles.tileValue}>
            {formatNumber(effectiveness.matchedCases, { maximumFractionDigits: 0 })}
          </p>
        </li>
        <li className={styles.tile}>
          <p className={styles.tileLabel}>Plan followed (average)</p>
          <p className={styles.tileValue}>
            {effectiveness.conformanceAvg === null
              ? 'Not applied yet'
              : formatProbability(effectiveness.conformanceAvg, 0)}
          </p>
        </li>
      </ul>
      {precedent ? (
        <>
          <div role="group" aria-label={precedentTitle(precedent)} className={styles.precedent}>
            <div className={styles.itemHead}>
              <p className={styles.itemTitle}>{precedentTitle(precedent)}</p>
              <ProvenanceBadge kind="estimated" size="small" />
            </div>
            <p className={styles.headline}>
              {precedentHeadline(precedent, effectiveness.applications)}
            </p>
            <p className={styles.meta}>{PRECEDENT_READING_GUIDE}</p>
            <p className={styles.meta}>{precedent.basis}</p>
          </div>
          <div role="group" aria-label={SECONDARY_TITLE} className={styles.secondary}>
            <div className={styles.itemHead}>
              <p className={styles.itemTitle}>{SECONDARY_TITLE}</p>
              <ProvenanceBadge kind="simulated" size="small" />
            </div>
            {baseline}
          </div>
        </>
      ) : (
        baseline
      )}
      {effectiveness.notes.length > 0 ? (
        <ul className={styles.bullets} aria-label="Notes on the figures">
          {effectiveness.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {effectiveness.synthetic ? (
        <Notice variant="synthetic" compact>
          {SYNTHETIC_EFFECTIVENESS_NOTICE}
        </Notice>
      ) : null}
    </Panel>
  );
}

function MatchedCases({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Cases this skill matched"
      description="Where it fits, and where it has been applied."
      help="Each row is a case where the skill matched. The score is a model estimate from the evidence on that case. Open a case to see why it matched and the steps the skill recommends."
    >
      {detail.matches.length === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<PeopleCommunityRegular />}
          title="No case has matched this skill"
          description="Matches appear when an analysed case meets the skill's trigger conditions."
        />
      ) : (
        <ul className={styles.list} aria-label="Matched cases">
          {detail.matches.map((match) => {
            const applicability = SKILL_APPLICABILITY[match.applicability];
            return (
              <li key={match.caseId} className={styles.item}>
                <div className={styles.itemHead}>
                  <UiLink
                    href={`/cases/${encodeURIComponent(match.caseId)}/quality?tab=skills`}
                    className={styles.link}
                  >
                    {match.caseReference}
                  </UiLink>
                  <StatusBadge
                    status={applicability.status}
                    label={applicability.label}
                    size="small"
                  />
                  {match.applied ? (
                    <StatusBadge status="productive" label="Applied" size="small" />
                  ) : (
                    <StatusBadge status="missing" label="Not applied" size="small" />
                  )}
                </div>
                <p className={styles.meta}>
                  Match score {formatProbability(match.score, 0)} (estimate)
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function ApplyToCase({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  const toast = useToast();
  const { analysed } = useAnalysedCases();
  const apply = useApiMutation('skills.apply', { invalidate: APPLY_INVALIDATES });
  const [caseId, setCaseId] = useState('');
  const [result, setResult] = useState<SkillMatch | null>(null);
  const { skill } = detail;
  const chosen =
    caseId && analysed.some((item) => item.id === caseId) ? caseId : (analysed[0]?.id ?? '');
  const blocked = isWithdrawn(skill.lifecycle)
    ? `A ${skill.lifecycle} skill can no longer be applied.`
    : analysed.length === 0
      ? 'There is no analysed case to apply it to.'
      : null;
  return (
    <Panel
      title="Apply to a case"
      description="Match the skill against a case and record that its plan was adopted."
      help="Applying matches the skill against the case's evidence and records that the guided plan was adopted, with how closely it was followed. It does not run anything and does not change the case. The record is audited, and applying again does nothing new."
    >
      <div className={styles.toolbar}>
        <Field label="Case" className={styles.field}>
          <Select
            className={styles.select}
            value={chosen}
            disabled={analysed.length === 0}
            onChange={(_event, next) => setCaseId(next.value)}
          >
            {analysed.map((item) => (
              <option key={item.id} value={item.id}>
                {item.reference} · {item.title}
              </option>
            ))}
          </Select>
        </Field>
        <GatedConfirm
          permission="skill:apply"
          blockedReason={blocked}
          trigger={<Button appearance="primary">Apply to this case</Button>}
          title="Apply this skill to the case?"
          confirmLabel="Apply skill"
          onConfirm={async () => {
            try {
              const match = await apply.mutateAsync({
                params: { caseId: chosen },
                body: { skillId: skill.id },
              });
              setResult(match);
              toast.success('Skill applied', {
                body: 'The adoption is recorded in the audit log with how closely the plan was followed.',
              });
            } catch (error) {
              throw new Error(failureText(explainFailure(error)), { cause: error });
            }
          }}
        >
          <p>
            Applying records that the guided plan of “{skill.name}” was adopted for the chosen case.
            It does not run anything or change the case, and the record is audited.
          </p>
        </GatedConfirm>
      </div>
      {blocked ? <p className={styles.meta}>{blocked}</p> : null}
      {result ? (
        <ul className={styles.list} aria-label="The match that was recorded">
          <SkillMatchCard match={result} caseId={result.caseId} requestedAsOf={null} />
        </ul>
      ) : null}
    </Panel>
  );
}

/** The "Cases" tab: effectiveness (estimated, synthetic where it is), the cases the skill matched, and applying it. */
export function UsageTab({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  return (
    <div className={styles.page}>
      <Effectiveness effectiveness={detail.skill.effectiveness} />
      <div className={styles.band}>
        <MatchedCases detail={detail} />
        <ApplyToCase detail={detail} />
      </div>
    </div>
  );
}
