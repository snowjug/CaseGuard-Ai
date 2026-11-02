'use client';

import type { ActionExecutor, Permission } from '@caseguard/schemas';
import { EmptyState, Notice, ProvenanceBadge, StatusBadge, cg } from '@caseguard/ui';
import { Button, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircleRegular, InfoRegular } from '@fluentui/react-icons';
import { useId, useMemo, useState } from 'react';
import { QueryErrorState } from '../../../components/common/QueryErrorState';
import { ClampedText } from '../../quality/ClampedText';
import { EvidenceChips } from '../evidence/EvidenceChips';
import { useLinkTitles } from '../evidence/useProvenance';
import {
  useCoachingHandle,
  useQualityHandle,
  useRankingHandle,
  useRunHandle,
  useScenariosHandle,
  useWarningsHandle,
  type Handle,
} from '../hooks';
import { GENERAL_GUIDANCE, deriveNextActions, type NextAction } from '../model/actions';
import { methodNotes } from '../model/method';
import { joinWords, plural } from '../model/words';
import { PermissionPart, SectionFrame } from './shared';

/** How many recommendations are listed before the rest are offered on request. */
const FIRST_SHOWN = 5;

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  item: {
    display: 'grid',
    gridTemplateColumns: '32px minmax(0, 1fr)',
    gap: `${cg.space[2]} ${cg.space[3]}`,
    padding: cg.space[3],
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    backgroundColor: cg.surfaceSunken,
  },
  rank: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.tone.brand.solid,
    color: cg.tone.brand.onSolid,
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  body: { display: 'flex', flexDirection: 'column', gap: cg.space[2], minWidth: 0 },
  badges: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  title: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
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
  general: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: cg.space[1],
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    color: cg.textSecondary,
  },
  source: { fontSize: tokens.fontSizeBase200, color: cg.textSecondary },
});

function ActionCard({
  index,
  action,
  titles,
}: {
  index: number;
  action: NextAction;
  titles: ReadonlyMap<string, string>;
}) {
  const styles = useStyles();
  const headingId = useId();
  return (
    <li className={styles.item}>
      <span className={styles.rank} aria-hidden="true">
        {index + 1}
      </span>
      <article className={styles.body} aria-labelledby={headingId}>
        <div className={styles.badges}>
          <StatusBadge status={action.priorityBadge} label={action.priorityLabel} size="small" />
          <span className={styles.source}>{action.sourceLabel}</span>
          {action.alsoCoachesNext ? (
            <StatusBadge status="neutral" size="small" label="Also the coach’s next action" />
          ) : null}
        </div>
        <h3 id={headingId} className={styles.title}>
          {action.title}
        </h3>
        <ClampedText text={action.reason} lines={2} label="reason" />
        {action.suggestion ? (
          <p className={styles.text}>
            <span className={styles.strong}>Suggested:</span> {action.suggestion}
          </p>
        ) : null}
        {action.owner || action.gain ? (
          <p className={styles.meta}>
            {[
              action.owner ? `Owner: ${action.owner}` : null,
              action.gain ? `Expected gain: ${action.gain}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        ) : null}
        {action.hasEvidence ? (
          <EvidenceChips links={action.links} subject={action.title} titles={titles} />
        ) : (
          <p className={styles.general}>
            <InfoRegular aria-hidden="true" /> {GENERAL_GUIDANCE}
          </p>
        )}
      </article>
    </li>
  );
}

interface UnreadPart {
  handle: Handle<unknown>;
  /** What the read is for, as a noun phrase. */
  what: string;
}

/**
 * Names, once each, the sources of the list that could not be read: those the role may not read are grouped by the
 * permission that is missing (so one missing permission is explained once), and those that failed get their own retry.
 */
function Unread({ parts }: { parts: readonly UnreadPart[] }) {
  const denied = new Map<Permission, string[]>();
  const failed: { part: UnreadPart; error: unknown }[] = [];
  for (const part of parts) {
    const source = part.handle.source;
    if (source.kind === 'denied')
      denied.set(source.permission, [...(denied.get(source.permission) ?? []), part.what]);
    else if (source.kind === 'failed') failed.push({ part, error: source.error });
  }
  return (
    <>
      {[...denied].map(([permission, whats]) => (
        <PermissionPart
          key={permission}
          permission={permission}
          what={joinWords(whats)}
          several={whats.length > 1}
        />
      ))}
      {failed.map(({ part, error }) => (
        <QueryErrorState
          key={part.what}
          compact
          subject={part.what.charAt(0).toUpperCase() + part.what.slice(1)}
          error={error}
          onRetry={part.handle.retry}
          retrying={part.handle.fetching}
        />
      ))}
    </>
  );
}

/**
 * Next actions: the highest-value recommendations in one ranked list, from the quality improvements, the warnings still
 * open, the coach's recommended next action and the best-ranked diagnostic steps. Each has its reason, a priority, an owner
 * where the data says who, the expected gain where there is one, and its evidence as chips; a recommendation with no
 * evidence says so. A source the role may not read, or that failed, is named, and the rest of the list stands.
 */
export function ActionsSection({ caseId }: { caseId: string }) {
  const styles = useStyles();
  const quality = useQualityHandle(caseId);
  const coaching = useCoachingHandle(caseId);
  const warnings = useWarningsHandle(caseId);
  const ranking = useRankingHandle(caseId);
  const scenarios = useScenariosHandle(caseId);
  const run = useRunHandle(caseId);
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  const qualityData = quality.source.kind === 'ready' ? quality.source.data : null;
  const coachingData = coaching.source.kind === 'ready' ? coaching.source.data : null;
  const warningData = warnings.source.kind === 'ready' ? warnings.source.data : null;
  const rankingData = ranking.source.kind === 'ready' ? ranking.source.data : null;
  const scenarioData = scenarios.source.kind === 'ready' ? scenarios.source.data : null;
  const executors = useMemo(() => {
    const map = new Map<string, ActionExecutor>();
    for (const scenario of scenarioData ?? [])
      for (const step of scenario.steps)
        if (!map.has(step.actionKey)) map.set(step.actionKey, step.executor);
    return map;
  }, [scenarioData]);
  const model = useMemo(
    () =>
      deriveNextActions({
        quality: qualityData,
        warnings: warningData,
        coaching: coachingData,
        ranking: rankingData,
        executors,
      }),
    [qualityData, warningData, coachingData, rankingData, executors],
  );
  const shown = expanded ? model.items : model.items.slice(0, FIRST_SHOWN);
  const titles = useLinkTitles(
    caseId,
    shown.flatMap((item) => item.links),
  );
  const handles = [quality, coaching, warnings, ranking];
  const loadingNow = handles.some((handle) => handle.source.kind === 'loading');
  const notes = methodNotes('actions', {
    run: run.source.kind === 'ready' ? run.source.data : null,
    quality: null,
    coaching: null,
    detail: null,
    path: null,
  });
  const rest = model.items.length - shown.length;
  return (
    <SectionFrame
      id="next-actions"
      title="Next actions"
      description="What to do next, most urgent first."
      badges={<ProvenanceBadge kind="estimated" />}
      method={notes}
    >
      <div className={styles.stack}>
        <Unread
          parts={[
            { handle: quality, what: 'the quality improvements' },
            { handle: coaching, what: 'the coach’s suggestion' },
            { handle: warnings, what: 'the warnings' },
            { handle: ranking, what: 'the ranked diagnostic steps' },
          ]}
        />
        {loadingNow && model.items.length === 0 ? (
          <p className={styles.meta} role="status">
            Loading the recommendations…
          </p>
        ) : model.items.length === 0 ? (
          <EmptyState
            compact
            icon={<CheckmarkCircleRegular />}
            title="Nothing to do next"
            description="The analysis has no recommendation for this case. That is a good sign, not an error."
          />
        ) : (
          <>
            <ol id={listId} className={styles.list} aria-label="Ranked recommendations">
              {shown.map((action, index) => (
                <ActionCard key={action.id} index={index} action={action} titles={titles} />
              ))}
            </ol>
            {model.items.length > FIRST_SHOWN ? (
              <div>
                <Button
                  appearance="outline"
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded
                    ? `Show only the first ${FIRST_SHOWN}`
                    : `Show ${plural(rest, 'more recommendation')}`}
                </Button>
              </div>
            ) : null}
          </>
        )}
        {warningData ? (
          <p className={styles.meta}>
            Warnings: {model.warnings.open} open, {model.warnings.resolved} resolved,{' '}
            {model.warnings.dismissed} dismissed.
            {model.warnings.open === 0 && model.warnings.resolved > 0
              ? ' Every warning raised while the case ran has been resolved; they stay on the quality page.'
              : ''}
          </p>
        ) : null}
        {model.noDiagnosticNote ? <p className={styles.meta}>{model.noDiagnosticNote}</p> : null}
        <Notice variant="info" compact title="About these recommendations">
          They are about the case and the process, never about a person. Gains are estimates.
        </Notice>
      </div>
    </SectionFrame>
  );
}
