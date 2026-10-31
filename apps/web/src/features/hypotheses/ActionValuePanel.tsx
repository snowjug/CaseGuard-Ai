'use client';

import { ACTION_KIND_LABELS, type ActionValueBreakdown } from '@caseguard/schemas';
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  KeyValueList,
  Notice,
  Panel,
  ProvenanceBadge,
  StatusBadge,
  cg,
  formatDateTimeUtc,
  formatDuration,
  formatNumber,
  formatProbability,
  useRestoreFocusTarget,
  type DataTableColumn,
} from '@caseguard/ui';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Field,
  Input,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowSortRegular, ShieldProhibitedRegular } from '@fluentui/react-icons';
import { useState } from 'react';
import { useApiMutation } from '../../lib/api/hooks';
import { GatedAction } from '../../lib/auth/session';
import { useToast } from '../../lib/toast';
import { explainOverrideFailure } from '../reasoning/errors';
import { formatInstant } from '../reasoning/format';
import { useActorLabel } from '../reasoning/hooks';
import { usePrimeWholeRecordRanking } from './hooks';
import { hasNothingToRank, overrideEntries, type RankingView } from './model';
import { OverridesList } from './OverridesList';

const useStyles = makeStyles({
  stack: { display: 'flex', flexDirection: 'column', gap: cg.space[3], minWidth: 0 },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: cg.space[2] },
  muted: { margin: 0, fontSize: tokens.fontSizeBase200, color: cg.textMuted },
  text: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    color: cg.textSecondary,
    overflowWrap: 'anywhere',
  },
  h3: { margin: 0, fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold },
  header: {
    display: 'grid',
    alignItems: 'center',
    columnGap: cg.space[3],
    rowGap: cg.space[1],
    width: '100%',
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 900px)': {
      gridTemplateColumns: '28px minmax(0, 1.6fr) minmax(150px, 1fr) minmax(0, 1.4fr)',
    },
  },
  rank: {
    fontVariantNumeric: 'tabular-nums',
    fontWeight: tokens.fontWeightSemibold,
    color: cg.textSecondary,
  },
  label: {
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
    overflowWrap: 'anywhere',
  },
  kind: {
    display: 'block',
    fontSize: tokens.fontSizeBase200,
    color: cg.textMuted,
    fontWeight: 400,
  },
  score: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  track: {
    display: 'block',
    height: '8px',
    borderRadius: cg.radius.pill,
    backgroundColor: cg.surfaceSunken,
    border: `1px solid ${cg.borderSubtle}`,
    overflow: 'hidden',
  },
  fill: {
    display: 'block',
    height: '100%',
    backgroundColor: cg.tone.brand.solid,
    backgroundImage: `repeating-linear-gradient(45deg, transparent 0 4px, color-mix(in srgb, ${cg.tone.brand.onSolid} 35%, transparent) 4px 6px)`,
  },
  scoreText: {
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
    fontVariantNumeric: 'tabular-nums',
  },
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: `${cg.space[1]} ${cg.space[2]}`,
    fontSize: tokens.fontSizeBase200,
    color: cg.textSecondary,
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[3],
    padding: `${cg.space[2]} ${cg.space[2]} ${cg.space[3]}`,
  },
  overrideBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[1],
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px dashed ${cg.tone.brand.border}`,
    backgroundColor: cg.tone.brand.tint,
  },
  details: {
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    padding: `${cg.space[1]} ${cg.space[3]}`,
    backgroundColor: cg.surface,
  },
  summary: {
    cursor: 'pointer',
    minHeight: '32px',
    display: 'flex',
    alignItems: 'center',
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  formula: {
    display: 'block',
    margin: `${cg.space[2]} 0`,
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.sm,
    backgroundColor: cg.surfaceSunken,
    fontFamily: cg.font.mono,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  blocked: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: `${cg.space[2]} ${cg.space[3]}`,
    borderRadius: cg.radius.md,
    border: `1px solid ${cg.borderSubtle}`,
    listStyle: 'none',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: cg.space[2],
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  num: { fontVariantNumeric: 'tabular-nums' },
});

const HELP =
  'Ranks the diagnostic actions that could be taken next with a configurable decision-support heuristic: expected information × relevance × confidence, divided by time, tokens, customer effort and operational risk, every term scaled to 0–1. It is not a scientific law. Actions the safety policy blocks are never recommended, whatever their score. A reviewer can record an override of a rank, with a reason: it is audited, listed under the ranking and shown next to the machine rank, which is never replaced. An earlier view lists only the overrides recorded, and about a moment, by its end, and always says that those recorded after it are not shown. When the last event has nothing left to rank, the ranking just before the earliest meaningful decision fork is shown instead.';

interface TermRow {
  id: string;
  term: string;
  raw: string;
  normalized: number;
  role: 'Numerator' | 'Denominator';
}

/** The seven inputs of one calculation: raw value, unit-normalised value and where it enters the formula. */
export function calculationRows(item: ActionValueBreakdown): TermRow[] {
  const { inputs, normalized } = item;
  return [
    {
      id: 'information',
      term: 'Expected information gain',
      raw: `${formatNumber(inputs.expectedInformationGainBits, { maximumFractionDigits: 2 })} bits`,
      normalized: normalized.information,
      role: 'Numerator',
    },
    {
      id: 'relevance',
      term: 'Relevance',
      raw: formatNumber(inputs.relevance, { maximumFractionDigits: 2 }),
      normalized: normalized.relevance,
      role: 'Numerator',
    },
    {
      id: 'confidence',
      term: 'Confidence',
      raw: formatNumber(inputs.confidence, { maximumFractionDigits: 2 }),
      normalized: normalized.confidence,
      role: 'Numerator',
    },
    {
      id: 'time',
      term: 'Time cost',
      raw: formatDuration(inputs.timeMinutes),
      normalized: normalized.time,
      role: 'Denominator',
    },
    {
      id: 'token',
      term: 'Token cost',
      raw: `≈ ${formatNumber(inputs.tokens, { maximumFractionDigits: 0 })} tokens`,
      normalized: normalized.token,
      role: 'Denominator',
    },
    {
      id: 'customer',
      term: 'Customer effort',
      raw: formatNumber(inputs.customerEffort, { maximumFractionDigits: 2 }),
      normalized: normalized.customer,
      role: 'Denominator',
    },
    {
      id: 'risk',
      term: 'Operational risk',
      raw: formatNumber(inputs.operationalRisk, { maximumFractionDigits: 2 }),
      normalized: normalized.risk,
      role: 'Denominator',
    },
  ];
}

const TERM_COLUMNS: DataTableColumn<TermRow>[] = [
  { id: 'term', header: 'Term', cell: (row) => row.term, rowHeader: true },
  { id: 'raw', header: 'Value', cell: (row) => row.raw, align: 'end' },
  {
    id: 'normalized',
    header: 'Scaled to 0–1',
    cell: (row) => formatNumber(row.normalized, { maximumFractionDigits: 3 }),
    align: 'end',
  },
  { id: 'role', header: 'Enters the formula as', cell: (row) => row.role },
];

const SCENARIO_COLUMNS: DataTableColumn<
  ActionValueBreakdown['sensitivity']['scenarios'][number]
>[] = [
  { id: 'label', header: 'Weights changed', cell: (s) => s.label, rowHeader: true },
  { id: 'rank', header: 'Rank', cell: (s) => String(s.rank), align: 'end' },
  {
    id: 'score',
    header: 'Score',
    cell: (s) => formatNumber(s.score, { maximumFractionDigits: 2 }),
    align: 'end',
  },
];

function OverrideAction({
  caseId,
  item,
  rankingAsOf,
  count,
  windowed,
}: {
  caseId: string;
  item: ActionValueBreakdown;
  rankingAsOf: string;
  count: number;
  /** True for an earlier view: the override is recorded now, about this moment, and is not part of the view. */
  windowed: boolean;
}) {
  const toast = useToast();
  const restoreFocus = useRestoreFocusTarget();
  const prime = usePrimeWholeRecordRanking();
  const [open, setOpen] = useState(false);
  const [rank, setRank] = useState(String(item.override?.rank ?? item.rank));
  const mutation = useApiMutation('actionValue.override', {
    // The response carries the whole-record list: it replaces the cached one at once, and the whole-record ranking is
    // read again in the background (the dialog does not wait for it). An earlier window cannot know a decision made
    // after it, so none is read again: that read is metered and its answer would not change.
    onSuccess: (updated) => prime(caseId, updated),
  });
  const parsed = Number.parseInt(rank, 10);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= Math.max(count, 1);
  const moment = formatInstant(rankingAsOf);

  return (
    <>
      <GatedAction permission="actionvalue:override">
        <Button
          size="small"
          appearance="outline"
          icon={<ArrowSortRegular />}
          onClick={() => setOpen(true)}
          {...restoreFocus}
        >
          {item.override ? 'Change the override' : 'Override this rank'}
        </Button>
      </GatedAction>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Override the rank of “${item.label}”`}
        confirmLabel="Record override"
        reason={{
          label: 'Reason for the override',
          placeholder:
            'For example: the customer already mentioned a deployment, so ask about changes first.',
          minLength: 5,
          maxLength: 500,
        }}
        onConfirm={async (reason) => {
          if (!valid) throw new Error(`Enter a rank between 1 and ${count}.`);
          try {
            await mutation.mutateAsync({
              params: { caseId },
              body: { asOf: rankingAsOf, actionKey: item.actionKey, rank: parsed, reason },
            });
          } catch (error) {
            throw new Error(explainOverrideFailure(error), { cause: error });
          }
          toast.success('Override recorded', {
            body: windowed
              ? `It is audited. This view only shows what was known at ${moment}, so the override is listed in the whole record, not here.`
              : 'It is audited and shown next to the machine rank, which is unchanged.',
          });
        }}
      >
        <p>
          The machine rank ({item.rank}) stays visible. Your override is recorded with your
          identity, the time and your reason, and it appears next to the machine rank for everyone
          who opens this ranking.
        </p>
        {windowed ? (
          <p>
            It is about the ranking at {moment}. This view only shows what was known then, so the
            override does not appear here: it is listed in the whole record.
          </p>
        ) : null}
        <Field label={`Move to rank (1 to ${count})`} required>
          <Input
            type="number"
            min={1}
            max={count}
            value={rank}
            onChange={(_event, data) => setRank(data.value)}
          />
        </Field>
      </ConfirmDialog>
    </>
  );
}

function RankRow({
  item,
  caseId,
  rankingAsOf,
  count,
  windowed,
}: {
  item: ActionValueBreakdown;
  caseId: string;
  rankingAsOf: string;
  count: number;
  windowed: boolean;
}) {
  const styles = useStyles();
  const actorLabel = useActorLabel();
  const { sensitivity } = item;
  const range =
    sensitivity.minRank === sensitivity.maxRank
      ? `${sensitivity.minRank}`
      : `${sensitivity.minRank}–${sensitivity.maxRank}`;
  return (
    <AccordionItem value={item.actionKey}>
      <AccordionHeader>
        <span className={styles.header}>
          <span className={styles.rank}>#{item.rank}</span>{' '}
          <span className={styles.label}>
            {item.label} <span className={styles.kind}>{ACTION_KIND_LABELS[item.kind]}</span>
          </span>{' '}
          <span className={styles.score}>
            <span className={styles.track} aria-hidden="true">
              <span
                className={styles.fill}
                style={{ width: `${Math.round(item.relativeScore * 100)}%` }}
              />
            </span>{' '}
            <span className={styles.scoreText}>
              {formatProbability(item.relativeScore)} of the best safe action · score{' '}
              {formatNumber(item.score, { maximumFractionDigits: 2 })}
            </span>
          </span>{' '}
          <span className={styles.facts}>
            <span>
              {formatNumber(item.inputs.expectedInformationGainBits, { maximumFractionDigits: 2 })}{' '}
              bits
            </span>{' '}
            <span aria-hidden="true">·</span> <span>{formatDuration(item.inputs.timeMinutes)}</span>{' '}
            <span aria-hidden="true">·</span>{' '}
            <span>
              {sensitivity.rankStable ? `Rank stable (${range})` : `Rank varies (${range})`}
            </span>
            {item.override ? (
              <>
                {' '}
                <StatusBadge
                  status="uncertain"
                  label={`Reviewer override: rank ${item.override.rank}`}
                  size="small"
                />
              </>
            ) : null}
          </span>
        </span>
      </AccordionHeader>
      <AccordionPanel>
        <div className={styles.body}>
          <p className={styles.text}>{item.explanation}</p>
          {item.requiresFirst.length > 0 ? (
            <p className={styles.text}>Needs first: {item.requiresFirst.join('; ')}.</p>
          ) : null}
          <section
            className={styles.stack}
            aria-label={`How the score of ${item.label} is calculated`}
          >
            <h3 className={styles.h3}>How this score was calculated</h3>
            <DataTable
              caption={`Calculation of ${item.label}`}
              columns={TERM_COLUMNS}
              rows={calculationRows(item)}
              getRowId={(row) => row.id}
              dense
            />
            <p className={styles.text}>
              Numerator{' '}
              <span className={styles.num}>
                {formatNumber(item.numerator, { maximumFractionDigits: 4 })}
              </span>{' '}
              ÷ denominator{' '}
              <span className={styles.num}>
                {formatNumber(item.denominator, { maximumFractionDigits: 4 })}
              </span>{' '}
              = score{' '}
              <strong className={styles.num}>
                {formatNumber(item.score, { maximumFractionDigits: 2 })}
              </strong>
              , which is {formatProbability(item.relativeScore)} of the best safe action.
            </p>
          </section>
          <section className={styles.stack} aria-label={`Sensitivity of ${item.label}`}>
            <h3 className={styles.h3}>Sensitivity to the weights</h3>
            <p className={styles.text}>
              {sensitivity.rankStable
                ? `The rank holds (${range}) when each weight changes by 25%.`
                : `The rank changes (${range}) when a weight changes by 25%, so treat it as a close call.`}
            </p>
            {sensitivity.scenarios.length > 0 ? (
              <DataTable
                caption={`Rank under changed weights for ${item.label}`}
                columns={SCENARIO_COLUMNS}
                rows={sensitivity.scenarios}
                getRowId={(s) => s.label}
                dense
              />
            ) : null}
          </section>
          <section className={styles.stack} aria-label={`Reviewer override for ${item.label}`}>
            <h3 className={styles.h3}>Reviewer override</h3>
            {item.override ? (
              <div className={styles.overrideBox}>
                <span className={styles.text}>
                  <strong>Override: rank {item.override.rank}</strong>, machine rank {item.rank}
                </span>
                <span className={styles.muted}>
                  By {actorLabel(item.override.by)} on {formatDateTimeUtc(item.override.at)}: “
                  {item.override.reason}”
                </span>
              </div>
            ) : (
              <p className={styles.muted}>
                {windowed
                  ? 'No reviewer override had been recorded by this moment.'
                  : 'No reviewer has overridden this rank.'}
              </p>
            )}
            <div>
              <OverrideAction
                caseId={caseId}
                item={item}
                rankingAsOf={rankingAsOf}
                count={count}
                windowed={windowed}
              />
            </div>
          </section>
        </div>
      </AccordionPanel>
    </AccordionItem>
  );
}

const LAST_EVENT_RESOLVED =
  'The case is resolved: at its last event there is nothing left to rank. Choose an earlier decision point.';
const LAST_EVENT_PLAIN =
  'At its last event there is nothing left to rank. Choose an earlier decision point.';

export interface ActionValuePanelProps {
  caseId: string;
  /** What to show: the ranking, which overrides it lists and whether it is an earlier view. */
  view: RankingView;
  /** Leaves an earlier view for the whole record, where every override is listed. */
  onShowLatest?: () => void;
}

/**
 * The ranked next actions with the whole calculation visible: inputs, scaled values, sensitivity to the weights, the
 * safety verdict and a gated, audited reviewer override, then the list of reviewer overrides. It is a heuristic and says
 * so. An earlier view lists only the overrides recorded (and about a moment) by its end and always says that those
 * recorded after it are not shown (no count); an override may still be recorded on it, about its moment, and then
 * appears in the whole record. A ranking whose every score is zero (a resolved case at its last event) is never
 * presented as a recommendation: the panel says so, and the page shows the ranking just before the earliest meaningful
 * decision fork instead when it has one.
 */
export function ActionValuePanel({ caseId, view, onShowLatest }: ActionValuePanelProps) {
  const styles = useStyles();
  const { ranking, windowed, decisionFork } = view;
  const nothingToRank = hasNothingToRank(ranking);
  const lastEventNote = view.caseResolved ? LAST_EVENT_RESOLVED : LAST_EVENT_PLAIN;
  const candidates = (
    <Accordion
      collapsible
      multiple={false}
      defaultOpenItems={nothingToRank ? [] : (ranking.candidates[0]?.actionKey ?? [])}
    >
      {ranking.candidates.map((item) => (
        <RankRow
          key={item.actionKey}
          item={item}
          caseId={caseId}
          rankingAsOf={ranking.asOf}
          count={ranking.candidates.length}
          windowed={windowed}
        />
      ))}
    </Accordion>
  );
  return (
    <Panel
      title="Next best action"
      description="Which diagnostic action the heuristic ranks first at this time, and exactly why."
      help={HELP}
      accent="brand"
    >
      <div className={styles.meta}>
        <ProvenanceBadge kind="estimated" label="Estimated scores" />
        <span className={styles.muted}>
          Ranked as of {formatInstant(ranking.asOf)}
          {decisionFork ? ', just before the earliest meaningful decision fork' : ''} ·
          configuration v{ranking.configVersion}
        </span>
      </div>
      <Notice variant="model-estimate" compact title="Heuristic">
        {ranking.notice}
      </Notice>
      <details className={styles.details}>
        <summary className={styles.summary}>The formula</summary>
        <code className={styles.formula}>{ranking.formula}</code>
      </details>
      {decisionFork ? (
        <Notice variant="info" compact title="Nothing left to rank at the last event">
          <span>{lastEventNote}</span>{' '}
          <span>
            Showing the ranking just before the earliest meaningful decision fork (“
            {decisionFork.title}”, decided {formatInstant(decisionFork.at)}) instead. Move the time
            cursor to choose another moment.
          </span>
        </Notice>
      ) : nothingToRank ? (
        <Notice
          variant="info"
          compact
          title={
            view.atLastEvent
              ? 'Nothing left to rank at the last event'
              : 'Nothing left to rank at this moment'
          }
        >
          <span>
            {view.atLastEvent
              ? lastEventNote
              : 'No candidate action is expected to add information at this moment, so there is nothing left to rank. Choose an earlier decision point.'}
          </span>{' '}
          <span>
            Move the time cursor back to an earlier moment to see a ranking that can still be acted
            on.
          </span>
        </Notice>
      ) : null}

      {ranking.candidates.length === 0 ? (
        <EmptyState
          compact
          icon={<ArrowSortRegular />}
          title="No safe action to rank"
          description="Every candidate action is blocked by the safety policy at this time."
        />
      ) : nothingToRank ? (
        <details className={styles.details}>
          <summary className={styles.summary}>
            Candidate actions ({ranking.candidates.length}): every score is 0, so none is a
            recommendation
          </summary>
          {candidates}
        </details>
      ) : (
        candidates
      )}

      <OverridesList
        entries={overrideEntries(view.overrides, ranking)}
        windowed={windowed}
        onShowWholeRecord={onShowLatest}
      />

      <details className={styles.details}>
        <summary className={styles.summary}>
          Blocked by the safety policy ({ranking.blocked.length}): never recommended
        </summary>
        {ranking.blocked.length === 0 ? (
          <p className={styles.text}>The safety policy blocks nothing at this time.</p>
        ) : (
          <ul className={styles.list}>
            {ranking.blocked.map((item) => (
              <li key={item.actionKey} className={styles.blocked}>
                <span className={styles.label}>
                  <StatusBadge status="unsupported" label="Blocked" size="small" /> {item.label}
                </span>
                {item.safety.blockedReasons.map((reason) => (
                  <span key={reason} className={styles.muted}>
                    <ShieldProhibitedRegular aria-hidden="true" /> {reason}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        )}
      </details>
      <details className={styles.details}>
        <summary className={styles.summary}>Confidence this ranking is based on</summary>
        <KeyValueList
          columns={2}
          items={ranking.posterior.map((p) => ({
            id: p.hypothesisId,
            label: p.name,
            value: `${formatProbability(p.confidence)} (model estimate)`,
          }))}
        />
      </details>
    </Panel>
  );
}
