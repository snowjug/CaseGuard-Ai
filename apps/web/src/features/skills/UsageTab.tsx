'use client';

import {
  SYNTHETIC_EFFECTIVENESS_NOTICE,
  type SkillDetail,
  type SkillEffectiveness,
} from '@caseguard/schemas';
import {
  EmptyState,
  Panel,
  ProvenanceBadge,
  UiLink,
  cg,
  formatDuration,
  formatProbability,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { UsersIcon } from 'lucide-react';
import { formatNumber } from '../../lib/format';
import { SKILL_APPLICABILITY } from '../../lib/labels';
import type { AppliedRecord } from './ApplyToCase';
import { StatusPill } from './Hints';
import { PRECEDENT_READING_GUIDE, precedentHeadline, precedentTitle } from './precedent';
import { SkillMatchCard } from './SkillMatchCard';
import { useSkillStyles } from './styles';

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

const useStyles = makeStyles({
  precedent: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.md,
    backgroundColor: cg.surfaceSunken,
    boxShadow: `inset 3px 0 0 ${cg.tone.brand.solid}`,
  },
  headline: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  secondary: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.tone.simulated.border}`,
  },
  figure: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  notes: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    margin: 0,
    paddingLeft: cg.space[4],
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    color: cg.textMuted,
  },
});

function Effectiveness({ effectiveness }: { effectiveness: SkillEffectiveness }) {
  const styles = useSkillStyles();
  const own = useStyles();
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
          <div role="group" aria-label={precedentTitle(precedent)} className={own.precedent}>
            <div className={own.figure}>
              <p className={styles.title}>{precedentTitle(precedent)}</p>
              <ProvenanceBadge kind="estimated" size="small" />
            </div>
            <p className={own.headline}>
              {precedentHeadline(precedent, effectiveness.applications)}
            </p>
            <p className={styles.meta}>{PRECEDENT_READING_GUIDE}</p>
            <p className={styles.meta}>{precedent.basis}</p>
          </div>
          <div role="group" aria-label={SECONDARY_TITLE} className={own.secondary}>
            <div className={own.figure}>
              <p className={styles.title}>{SECONDARY_TITLE}</p>
              <ProvenanceBadge kind="simulated" size="small" />
            </div>
            {baseline}
          </div>
        </>
      ) : (
        baseline
      )}
      {effectiveness.notes.length > 0 ? (
        <ul className={own.notes} aria-label="Notes on the figures">
          {effectiveness.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {effectiveness.synthetic ? (
        <p className={styles.caption}>{SYNTHETIC_EFFECTIVENESS_NOTICE}</p>
      ) : null}
    </Panel>
  );
}

function MatchedCases({ detail }: { detail: SkillDetail }) {
  const styles = useSkillStyles();
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
          icon={<UsersIcon />}
          title="No case has matched this skill"
          description="Matches appear when an analysed case meets the skill's trigger conditions."
        />
      ) : (
        <ul className={styles.rows} aria-label="Matched cases">
          {detail.matches.map((match) => {
            const applicability = SKILL_APPLICABILITY[match.applicability];
            return (
              <li key={match.caseId} className={styles.rowItem}>
                <div className={styles.spread}>
                  <UiLink
                    href={`/cases/${encodeURIComponent(match.caseId)}/quality?tab=skills`}
                    className={styles.link}
                  >
                    {match.caseReference}
                  </UiLink>
                  <div className={styles.row}>
                    <StatusPill status={applicability.status} label={applicability.label} />
                    {match.applied ? (
                      <StatusPill status="productive" label="Applied" />
                    ) : (
                      <StatusPill status="missing" label="Not applied" />
                    )}
                  </div>
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

export interface UsageTabProps {
  detail: SkillDetail;
  /** The application that was just recorded from the page's "Apply to a case" action, shown first. */
  applied?: AppliedRecord | null;
}

/** The "Cases" tab: what was just applied, effectiveness (estimated, demo data where it is) and the cases the skill matched. */
export function UsageTab({ detail, applied = null }: UsageTabProps) {
  const styles = useSkillStyles();
  return (
    <div className={styles.page}>
      {applied ? (
        <Panel
          title="Just applied"
          description={
            applied.caseReference
              ? `Recorded on ${applied.caseReference}.`
              : 'Recorded on the case you chose.'
          }
        >
          <ul className={styles.rows} aria-label="The match that was recorded">
            <SkillMatchCard
              match={applied.match}
              caseId={applied.match.caseId}
              requestedAsOf={null}
            />
          </ul>
        </Panel>
      ) : null}
      <Effectiveness effectiveness={detail.skill.effectiveness} />
      <MatchedCases detail={detail} />
    </div>
  );
}
