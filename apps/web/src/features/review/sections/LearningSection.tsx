'use client';

import {
  EmptyState,
  LoadingSkeleton,
  Notice,
  ProvenanceBadge,
  ScrollRegion,
  StatusBadge,
  UiLink,
  cg,
  formatDateTimeUtc,
  useRestoreFocusTarget,
} from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { MoleculeRegular } from '@fluentui/react-icons';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useState } from 'react';
import { JobProgress } from '../../../components/common/JobProgress';
import { QueryErrorState } from '../../../components/common/QueryErrorState';
import { isApiError } from '../../../lib/api/errors';
import { useApiMutation } from '../../../lib/api/hooks';
import { GatedAction, useSession } from '../../../lib/auth/session';
import { useToast } from '../../../lib/toast';
import { ClampedText } from '../../quality/ClampedText';
import { explainFailure, failureText, needsReload } from '../../quality/failure';
import { GatedConfirm } from '../../quality/GatedConfirm';
import { explainJobStartFailure } from '../../reasoning/errors';
import { useActorLabel } from '../../reasoning/hooks';
import { useRefreshSkills } from '../../skills/hooks';
import { APPLY_INVALIDATES } from '../../skills/SkillMatchCard';
import { EvidenceChips } from '../evidence/EvidenceChips';
import { useLinkTitles } from '../evidence/useProvenance';
import {
  useMatchesHandle,
  useOverlayHandles,
  useRunHandle,
  useScenariosHandle,
  type Handle,
} from '../hooks';
import {
  deriveLearning,
  describeOverlay,
  type LearningMatch,
  type OverlayView,
} from '../model/learning';
import { methodNotes } from '../model/method';
import { acceptedScenario } from '../model/paths';
import { plural } from '../model/words';
import type { SkillOverlay } from '@caseguard/schemas';
import { PartState, SectionFrame, useRoleText } from './shared';

/** How many matching skills are explained in full; the rest are counted. */
const MATCHES_SHOWN = 3;

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[4], minWidth: 0 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[4],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    minWidth: 0,
    padding: cg.space[4],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    borderLeft: `4px solid ${cg.tone.skill.solid}`,
    backgroundColor: cg.surfaceSunken,
  },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  subtitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  meta: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  strong: { color: cg.text, fontWeight: tokens.fontWeightSemibold },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    minWidth: 0,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surface,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: tokens.fontSizeBase300,
    color: cg.text,
  },
  caption: {
    textAlign: 'left',
    padding: `0 0 ${cg.space[2]}`,
    fontWeight: tokens.fontWeightSemibold,
  },
  th: {
    textAlign: 'left',
    padding: cg.space[2],
    borderBottom: `2px solid ${cg.borderControl}`,
    fontWeight: tokens.fontWeightSemibold,
    verticalAlign: 'bottom',
  },
  td: { padding: cg.space[2], borderBottom: `1px solid ${cg.borderSubtle}`, verticalAlign: 'top' },
  basis: {
    display: 'block',
    marginTop: cg.space[1],
    fontSize: tokens.fontSizeBase200,
    fontWeight: tokens.fontWeightRegular,
    color: cg.textMuted,
  },
  bullets: {
    margin: 0,
    paddingLeft: cg.space[4],
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  details: { fontSize: tokens.fontSizeBase300, color: cg.textSecondary },
  summary: {
    cursor: 'pointer',
    color: cg.textLink,
    fontWeight: tokens.fontWeightSemibold,
    minHeight: '24px',
  },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  link: {
    color: cg.textLink,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    fontSize: tokens.fontSizeBase300,
    minHeight: '24px',
  },
});

const NOT_AVAILABLE = 'Not available';

function Overlay({ view }: { view: OverlayView }) {
  const styles = useStyles();
  return (
    <div className={styles.stack}>
      {view.decision ? (
        <p className={styles.text}>
          <span className={styles.strong}>Where the skill would have mattered:</span>{' '}
          {view.decision.title} ({formatDateTimeUtc(view.decision.at)}). {view.decision.summary}
        </p>
      ) : (
        <p className={styles.text}>
          No decision point of this case is one where the skill would have changed course.
        </p>
      )}
      <p className={styles.text}>
        <span className={styles.strong}>What the case recorded:</span>{' '}
        {view.recorded.label ? `${view.recorded.label}. ` : ''}
        {view.recorded.note}
      </p>
      {view.cheaper ? (
        <p className={styles.text}>
          <span className={styles.strong}>The skill’s cheaper alternative:</span> {view.cheaper.use}{' '}
          instead of {view.cheaper.instead}. {view.cheaper.rationale}
          {view.cheaper.minutesSaved ? ` ${view.cheaper.minutesSaved}.` : ''}
        </p>
      ) : null}
      <ScrollRegion label="Recorded against with the skill, scrollable">
        <table className={styles.table}>
          <caption className={styles.caption}>
            Recorded against with the skill (estimates worked out by the server)
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.th}>
                Measure
              </th>
              <th scope="col" className={styles.th}>
                Recorded
              </th>
              <th scope="col" className={styles.th}>
                With the skill (estimate)
              </th>
              <th scope="col" className={styles.th}>
                The skill’s own saving (estimate)
              </th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className={styles.td}>
                  {row.label}
                  <span className={styles.basis}>{row.basis}</span>
                </th>
                <td className={styles.td}>{row.recorded ?? NOT_AVAILABLE}</td>
                <td className={styles.td}>{row.withSkill ?? NOT_AVAILABLE}</td>
                <td className={styles.td}>{row.saved ?? NOT_AVAILABLE}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {view.steps.length > 0 ? (
        <details className={styles.details}>
          <summary className={styles.summary}>
            The skill’s steps for this case ({view.steps.length})
          </summary>
          <ol className={styles.bullets}>
            {view.steps.map((step) => (
              <li key={step.id}>
                <span className={styles.strong}>{step.title}</span> ({step.statusLabel}).{' '}
                {step.instruction}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {view.assumptions.length > 0 ? (
        <details className={styles.details}>
          <summary className={styles.summary}>Assumptions ({view.assumptions.length})</summary>
          <ul className={styles.bullets}>
            {view.assumptions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {view.limitations.length > 0 ? (
        <Notice variant="info" compact title="Limits of this comparison">
          <ul className={styles.bullets}>
            {view.limitations.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

function OverlayPart({ handle }: { handle: Handle<SkillOverlay> | undefined }) {
  const source = handle?.source;
  if (!handle || !source || source.kind === 'loading') {
    return (
      <LoadingSkeleton variant="text" count={3} label="Loading the comparison with the skill" />
    );
  }
  if (source.kind === 'denied') return null;
  if (source.kind === 'failed') {
    return (
      <QueryErrorState
        compact
        subject="The comparison with the skill"
        error={source.error}
        onRetry={handle.retry}
        retrying={handle.fetching}
      />
    );
  }
  return <Overlay view={describeOverlay(source.data)} />;
}

function MatchCard({
  caseId,
  match,
  overlay,
  titles,
}: {
  caseId: string;
  match: LearningMatch;
  overlay: Handle<SkillOverlay> | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const styles = useStyles();
  const headingId = useId();
  const toast = useToast();
  const actor = useActorLabel();
  const refresh = useRefreshSkills();
  const apply = useApiMutation('skillMatches.apply', { invalidate: APPLY_INVALIDATES });
  const subject = `${match.skillName} (why it fits)`;
  return (
    <li>
      <article className={styles.card} aria-labelledby={headingId}>
        <div className={styles.badges}>
          <StatusBadge
            status={match.applicabilityBadge}
            label={match.applicabilityLabel}
            size="small"
          />
          <StatusBadge status="neutral" label={match.lifecycleLabel} size="small" />
          <ProvenanceBadge kind="estimated" label="Estimated match" size="small" />
        </div>
        <h3 id={headingId} className={styles.title}>
          This resembles {match.skillName}
        </h3>
        <p className={styles.text}>
          <span className={styles.strong}>Match {match.scoreText}</span> (model estimate), version{' '}
          {match.version}. Matched using only the evidence on record up to{' '}
          {formatDateTimeUtc(match.asOf)}.
        </p>
        <ClampedText text={match.rationale} lines={3} label="reason for the match" />
        <EvidenceChips links={match.links} subject={subject} titles={titles} />
        <div className={styles.panel}>
          <h4 className={styles.subtitle}>Recorded against with the skill</h4>
          <OverlayPart handle={overlay} />
        </div>
        {match.applied ? (
          <p className={styles.text}>
            Plan adopted{match.appliedAt ? ` ${formatDateTimeUtc(match.appliedAt)}` : ''} by{' '}
            {actor(match.appliedBy)}
            {match.conformanceText ? `; ${match.conformanceText}` : ''}. Following a plan describes
            the process, not the person.
          </p>
        ) : null}
        <div className={styles.actions}>
          {match.applied ? null : (
            <GatedConfirm
              permission="skill:apply"
              trigger={
                <Button appearance="primary" aria-label={`Adopt this plan: ${match.skillName}`}>
                  Adopt this plan
                </Button>
              }
              title="Adopt this plan for the case?"
              confirmLabel="Adopt the plan"
              onConfirm={async () => {
                try {
                  await apply.mutateAsync({ params: { caseId, matchId: match.matchId } });
                  toast.success('Plan adopted', {
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
                Adopting records that the plan of “{match.skillName}” was adopted for this case,
                with how closely it was followed and an estimate of its effect. It does not change
                the case or run anything. The record is audited and adopting again does nothing new.
              </p>
            </GatedConfirm>
          )}
          <UiLink className={styles.link} href={`/skills/${encodeURIComponent(match.skillId)}`}>
            Open the skill
          </UiLink>
        </div>
      </article>
    </li>
  );
}

function Extract({ caseId, scenarioId }: { caseId: string; scenarioId: string }) {
  const styles = useStyles();
  const router = useRouter();
  const toast = useToast();
  const restoreFocus = useRestoreFocusTarget();
  const extract = useApiMutation('skills.extract');
  const [jobId, setJobId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const start = async (): Promise<void> => {
    setFailure(null);
    try {
      const result = await extract.mutateAsync({ params: { caseId }, body: { scenarioId } });
      setJobId(result.job.id);
    } catch (error) {
      setFailure(
        isApiError(error) && error.issues.length > 0
          ? `${error.message} ${error.issues.map((issue) => issue.message).join(' ')}`
          : explainJobStartFailure(error, 'extraction'),
      );
    }
  };
  return (
    <div className={styles.panel}>
      <h3 className={styles.subtitle}>Turn this case into a reusable skill</h3>
      <p className={styles.text}>
        A reviewer accepted a better-supported path for this case, so it can be distilled into a
        reusable skill. It starts as a draft and stays one until a curator approves it; nothing is
        published automatically.
      </p>
      <div className={styles.actions}>
        <GatedAction permission="skill:extract">
          <Button
            appearance="primary"
            icon={<MoleculeRegular />}
            disabled={extract.isPending || jobId !== null}
            onClick={() => void start()}
            {...restoreFocus}
          >
            Extract a reusable skill
          </Button>
        </GatedAction>
      </div>
      {failure ? (
        <Notice variant="warning" title="The skill could not be extracted">
          {failure}
        </Notice>
      ) : null}
      {jobId ? (
        <JobProgress
          jobId={jobId}
          title="Extracting a reusable skill"
          level={3}
          onTerminal={(job) => {
            if (job.status === 'succeeded') {
              const skillId = job.resultRef?.type === 'skill' ? job.resultRef.id : null;
              toast.success('Draft skill created', {
                body: skillId ? 'Opening the new skill.' : 'It is in the skill library.',
              });
              router.push(skillId ? `/skills/${encodeURIComponent(skillId)}` : '/skills');
              return;
            }
            setJobId(null);
            setFailure(
              job.status === 'cancelled'
                ? 'The extraction was cancelled before it finished, so no skill was created.'
                : (job.error?.message ?? 'The job stopped before it completed.'),
            );
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Learning: the skills that resemble the case, each with the comparison of what the case recorded against what following
 * the skill would have changed (every figure computed by the server and shown as given), the choice to adopt its plan,
 * and, when a reviewer accepted a better path and the role may extract skills, the way to turn this case into a reusable
 * skill. Skills stay drafts until a curator approves them.
 */
export function LearningSection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const matches = useMatchesHandle(caseId);
  const scenarios = useScenariosHandle(caseId);
  const run = useRunHandle(caseId);
  const role = useRoleText();
  const { can, isLoading } = useSession();
  const data = matches.source.kind === 'ready' ? matches.source.data : null;
  const learning = useMemo(() => (data ? deriveLearning(data) : null), [data]);
  const shown = learning?.matches.slice(0, MATCHES_SHOWN) ?? [];
  const overlays = useOverlayHandles(
    caseId,
    shown.map((match) => match.matchId),
  );
  const titles = useLinkTitles(
    caseId,
    shown.flatMap((match) => match.links),
  );
  const accepted =
    scenarios.source.kind === 'ready' ? acceptedScenario(scenarios.source.data) : null;
  const notes = methodNotes('learning', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: null,
    coaching: null,
    detail: null,
    path: null,
  });
  return (
    <SectionFrame
      id="learning"
      title="Learning"
      description="Reusable skills that resemble this case, and what following them would have changed."
      badges={<ProvenanceBadge kind="estimated" />}
      method={notes}
    >
      <div className={styles.stack}>
        {matches.source.kind !== 'ready' ? (
          <PartState handle={matches} what="the matching skills" />
        ) : !learning || learning.matches.length === 0 ? (
          <EmptyState
            compact
            icon={<MoleculeRegular />}
            title="No reusable skill resembles this case"
            description={
              learning && learning.notApplicable > 0
                ? `${plural(learning.notApplicable, 'skill')} matched but ${learning.notApplicable === 1 ? 'does' : 'do'} not apply to this case.`
                : 'No published or validated skill matches this case yet. Skills are extracted from a reviewer-accepted better path and then approved by a curator.'
            }
          />
        ) : (
          <>
            <ol className={styles.list} aria-label="Skills that resemble this case">
              {shown.map((match) => (
                <MatchCard
                  key={match.matchId}
                  caseId={caseId}
                  match={match}
                  overlay={overlays[match.matchId]}
                  titles={titles}
                />
              ))}
            </ol>
            {learning.matches.length > shown.length ? (
              <p className={styles.meta}>
                {plural(learning.matches.length - shown.length, 'more skill')} also resemble this
                case; they are in the skill library.
              </p>
            ) : null}
          </>
        )}
        {accepted ? (
          can('skill:extract') || isLoading ? (
            <Extract caseId={caseId} scenarioId={accepted.id} />
          ) : (
            <p className={styles.meta}>
              A reviewer accepted a better path for this case, so a skill could be extracted from
              it. Your role ({role}) cannot extract skills; engineers, skill curators and
              administrators can.
            </p>
          )
        ) : scenarios.source.kind === 'ready' ? (
          <p className={styles.meta}>
            No better path has been accepted by a reviewer yet, so there is nothing to extract a
            skill from.
          </p>
        ) : null}
        <p className={styles.meta}>
          Skills stay drafts until a curator approves them. Adopting a plan records that it was
          adopted; it does not change the case.
        </p>
      </div>
    </SectionFrame>
  );
}
