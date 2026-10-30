'use client';

import { SYNTHETIC_EFFECTIVENESS_NOTICE, type AnalyticsOverview } from '@caseguard/schemas';
import {
  DataTable,
  EmptyState,
  Notice,
  Panel,
  ProvenanceBadge,
  StackedBar,
  UiLink,
  type DataTableColumn,
} from '@caseguard/ui';
import { MoleculeRegular } from '@fluentui/react-icons';
import { formatNumber, formatPercent } from '../../lib/format';
import { optionalRate, timeBasisText, timeDeltaText } from './portfolio-model';
import { useInsightStyles } from './styles';

type EffectivenessRow = AnalyticsOverview['skillEffectiveness'][number];

const TIME_BASIS_NOTE =
  'Time to diagnosis is compared with the recorded path of the case each skill came from where there is one: the same kind of figure, but a different case and no control group. Otherwise it is compared with a simulated baseline that has no waiting between steps, so recorded times read longer than it by construction.';

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  const styles = useInsightStyles();
  return (
    <li className={styles.tile}>
      <p className={styles.tileLabel}>{label}</p>
      <p className={styles.tileValue}>{value}</p>
      {note ? <p className={styles.tileNote}>{note}</p> : null}
    </li>
  );
}

const count = (value: number): string => formatNumber(value, { maximumFractionDigits: 0 });

function SkillLink({ id, name }: { id: string; name: string }) {
  const styles = useInsightStyles();
  return (
    <UiLink href={`/skills/${encodeURIComponent(id)}`} className={styles.link}>
      {name}
    </UiLink>
  );
}

/**
 * The change in time to diagnosis with what it is compared with named under it (the basis changes what the figure
 * means), then the labels of the figure. They sit in the cell rather than in a column of their own: a column that only
 * holds badges is squeezed to a few pixels on a phone, and a label cut to "Esti…" labels nothing.
 */
function TimeCell({ row }: { row: EffectivenessRow }) {
  const styles = useInsightStyles();
  const delta = row.timeToDiagnosisDeltaPct;
  const basis = delta === null ? null : timeBasisText(row.timeToDiagnosisBasis);
  return (
    <div className={styles.cellStack}>
      <span>{timeDeltaText(delta, row.timeToDiagnosisBasis)}</span>
      {basis ? <span className={styles.meta}>{basis}</span> : null}
      {delta !== null || row.synthetic ? (
        <span className={styles.cellBadges}>
          {delta !== null ? <ProvenanceBadge kind="estimated" size="small" /> : null}
          {row.synthetic ? <ProvenanceBadge kind="synthetic" size="small" /> : null}
        </span>
      ) : null}
    </div>
  );
}

const EFFECTIVENESS_COLUMNS: readonly DataTableColumn<EffectivenessRow>[] = [
  {
    id: 'skill',
    header: 'Skill',
    rowHeader: true,
    cell: (row) => <SkillLink id={row.skillId} name={row.name} />,
    sortValue: (row) => row.name,
  },
  {
    id: 'applications',
    header: 'Applications',
    align: 'end',
    cell: (row) => count(row.applications),
    sortValue: (row) => row.applications,
  },
  {
    id: 'delta',
    header: 'Time to diagnosis',
    cell: (row) => <TimeCell row={row} />,
    sortValue: (row) => row.timeToDiagnosisDeltaPct,
  },
];

export function SkillsPanel({
  adoption,
  effectiveness,
}: {
  adoption: AnalyticsOverview['skillAdoption'];
  effectiveness: AnalyticsOverview['skillEffectiveness'];
}) {
  const styles = useInsightStyles();
  const anySynthetic = effectiveness.some((row) => row.synthetic);
  return (
    <Panel
      title="SkillDNA adoption and effectiveness"
      description="How many governed skills exist, where they were matched and applied, and what that did to time to diagnosis."
      help="Adoption counts skills by lifecycle stage and the cases they matched or were applied to. Effectiveness compares time to diagnosis, for each skill that has been applied, with the recorded path of the case the skill came from where there is one, and otherwise with a simulated baseline. These are estimates from very few applications: treat them as a demonstration of the measurement, not as proof that a skill works."
    >
      {adoption.totalSkills === 0 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<MoleculeRegular />}
          title="No skills yet"
          description="SkillDNA is extracted from an accepted counterfactual path and then governed through review, pilot and publication."
        />
      ) : (
        <ul className={styles.tiles} aria-label="SkillDNA adoption">
          <Tile label="Skills" value={count(adoption.totalSkills)} />
          <Tile label="Published" value={count(adoption.published)} />
          <Tile label="Pilot or validated" value={count(adoption.pilotOrValidated)} />
          <Tile label="Cases matched" value={count(adoption.matchedCases)} />
          <Tile label="Cases where applied" value={count(adoption.appliedCases)} />
        </ul>
      )}
      {effectiveness.length > 0 ? (
        <>
          <div className={styles.tableWrap}>
            <DataTable
              caption="Skill effectiveness"
              columns={EFFECTIVENESS_COLUMNS}
              rows={effectiveness}
              getRowId={(row) => row.skillId}
              dense
            />
          </div>
          {effectiveness.some((row) => row.timeToDiagnosisBasis) ? (
            <p className={styles.meta}>{TIME_BASIS_NOTE}</p>
          ) : null}
          {anySynthetic ? (
            <Notice variant="synthetic" compact>
              {SYNTHETIC_EFFECTIVENESS_NOTICE}
            </Notice>
          ) : null}
        </>
      ) : adoption.totalSkills > 0 ? (
        <p className={styles.text}>
          No skill has been applied to a case yet, so there is no effectiveness to show.
        </p>
      ) : null}
    </Panel>
  );
}

export function TokenPanel({ tokens }: { tokens: AnalyticsOverview['tokenEfficiency'] }) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Token efficiency"
      description="Information gained per token, and estimated savings from a simulated better path."
      help="Bits per 1,000 tokens is the information the analysis gained from hypothesis updates for every thousand tokens used; the saving compares the real path with a simulated one. Both are estimates, and the token counts come from the deterministic provider's synthetic telemetry."
      actions={
        <>
          <ProvenanceBadge kind="estimated" />
          <ProvenanceBadge kind="simulated" />
        </>
      }
      footer={
        <UiLink href="/efficiency" className={styles.link}>
          Open the Efficiency Monitor
        </UiLink>
      }
    >
      <ul className={styles.tiles} aria-label="Token efficiency">
        <Tile
          label="Information per 1,000 tokens"
          value={
            tokens.avgBitsPer1kTokens === null
              ? 'Not enough data'
              : `${formatNumber(tokens.avgBitsPer1kTokens, { maximumFractionDigits: 2 })} bits`
          }
          note="Average over analysed cases"
        />
        <Tile
          label="Estimated token saving"
          value={
            tokens.avgEstimatedSavingsPct === null
              ? 'Not enough data'
              : formatPercent(tokens.avgEstimatedSavingsPct, 1)
          }
          note="Real path versus simulated path"
        />
      </ul>
    </Panel>
  );
}

export function AcceptancePanel({
  acceptance,
}: {
  acceptance: AnalyticsOverview['counterfactualAcceptance'];
}) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Counterfactual acceptance"
      description="How often a reviewer accepted a simulated better path."
      help="Reviewers accept or reject each simulated path with a reason. A low rate can mean the simulations need work; it says nothing about the people who ran or reviewed them."
    >
      {acceptance.reviewed === 0 ? (
        <p className={styles.text}>No simulated path has been reviewed yet, so there is no rate.</p>
      ) : (
        <>
          <p className={styles.tileValue}>
            {optionalRate(acceptance.rate, 'No rate yet')}
            <span className={styles.meta}> accepted</span>
          </p>
          <StackedBar
            title="Reviewed simulated paths"
            valueLabel="Paths"
            valueFormat={(value) => formatNumber(value, { maximumFractionDigits: 0 })}
            segments={[
              {
                key: 'accepted',
                label: 'Accepted',
                value: acceptance.accepted,
                tone: 'productive',
              },
              {
                key: 'rejected',
                label: 'Rejected',
                value: acceptance.rejected,
                tone: 'unsupported',
              },
            ]}
          />
          <p className={styles.meta}>
            {acceptance.accepted} accepted and {acceptance.rejected} rejected out of{' '}
            {acceptance.reviewed} reviewed.
          </p>
        </>
      )}
    </Panel>
  );
}

export function DisagreementPanel({
  disagreement,
}: {
  disagreement: AnalyticsOverview['reviewerDisagreement'];
}) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Reviewer corrections"
      description="How often a reviewer changed the evidence category the analysis proposed."
      help="A correction means a reviewer chose a different evidence category from the one the analysis proposed. It measures how often the classifier needs help. It is never a measure of how any person performs."
    >
      {disagreement.reviewedClaims === 0 ? (
        <p className={styles.text}>No claim has been reviewed yet, so there is no rate.</p>
      ) : (
        <>
          <p className={styles.tileValue}>
            {optionalRate(disagreement.rate, 'No rate yet')}
            <span className={styles.meta}> corrected</span>
          </p>
          <p className={styles.meta}>
            {disagreement.corrected} of {disagreement.reviewedClaims} reviewed claims were
            corrected.
          </p>
        </>
      )}
    </Panel>
  );
}

export function PrivacyPanel({ notes }: { notes: readonly string[] }) {
  const styles = useInsightStyles();
  return (
    <Panel
      title="Privacy and how to read these analytics"
      description="What is shown, what is never shown, and how far to trust it."
    >
      <ul className={styles.bullets}>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </Panel>
  );
}
