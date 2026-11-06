'use client';

import type { SkillDetail, SkillDiffChange } from '@caseguard/schemas';
import {
  Accordion,
  AccordionItem,
  CopyButton,
  EmptyState,
  Field,
  LoadingSkeleton,
  Panel,
  RelativeTime,
  Select,
  cg,
} from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { HistoryIcon } from 'lucide-react';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ExpandableText } from '../../components/case/ExpandableText';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { shortId } from '../../lib/format';
import { codecs, useUrlState } from '../../lib/url-state';
import { useActorLabel } from '../quality/actors';
import { PanelBoundary } from '../quality/PanelBoundary';
import { ManageSection, ProposalSection } from './ChangesPanels';
import { StatusPill } from './Hints';
import { CHANGE_TYPE_LABELS, VERSION_STATES } from './labels';
import { useSkillStyles } from './styles';

const ID_CODEC = codecs.optionalString();

const SECTION_LABELS: Record<string, string> = {
  triggerConditions: 'Trigger conditions',
  exclusions: 'Exclusions',
  requiredInputs: 'Required inputs',
  minimumEvidence: 'Minimum evidence',
  decisionSequence: 'Decision sequence',
  candidateActions: 'Candidate actions',
  stopConditions: 'Stop conditions',
  successConditions: 'Success conditions',
  escalationConditions: 'Escalation conditions',
  safetyConstraints: 'Safety constraints',
  queryTemplates: 'Query templates',
  knownFailureModes: 'Known failure modes',
  sourceCases: 'Source cases',
  cheaperAlternatives: 'Cheaper alternatives',
  validationCriteria: 'Validation criteria',
  confidence: 'Estimated success',
  applicability: 'Applicability',
  expectedBenefit: 'Expected benefit',
  provenance: 'Source',
};

/** `triggerConditions` becomes "Trigger conditions"; a name the table does not know is split at its capitals. */
export function sectionLabel(section: string): string {
  const known = SECTION_LABELS[section];
  if (known) return known;
  const spaced = section.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const CHANGE_BADGE: Record<
  SkillDiffChange['type'],
  { label: string; status: 'productive' | 'unsupported' | 'uncertain' }
> = {
  added: { label: 'Added', status: 'productive' },
  removed: { label: 'Removed', status: 'unsupported' },
  modified: { label: 'Changed', status: 'uncertain' },
};

const useStyles = makeStyles({
  beforeAfter: {
    display: 'grid',
    gap: cg.space[3],
    gridTemplateColumns: 'minmax(0, 1fr)',
    '@media (min-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  side: { display: 'flex', flexDirection: 'column', gap: cg.space[1], minWidth: 0 },
  controls: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: cg.space[3] },
  field: { flex: '1 1 220px', minWidth: 0 },
  sectionTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase300,
    lineHeight: tokens.lineHeightBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: cg.text,
  },
  versionTitle: {
    margin: 0,
    fontSize: tokens.fontSizeBase400,
    lineHeight: tokens.lineHeightBase400,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.01em',
    color: cg.text,
  },
  summary: { color: cg.textSecondary },
});

function VersionHistory({ detail }: { detail: SkillDetail }) {
  const styles = useSkillStyles();
  const own = useStyles();
  const actor = useActorLabel();
  const versions = [...detail.versions].sort((a, b) => b.sequence - a.sequence);
  const semver = new Map(detail.versions.map((version) => [version.id, version.version]));
  return (
    <Panel
      title="Version history"
      description="Every version, newest first. History is never rewritten."
      help="A version is a complete copy of the skill. Changes arrive as proposals, and a rollback adds a new version rather than deleting one. The content hash identifies the exact content, so two versions with the same hash have the same content."
    >
      <ol className={styles.rows} aria-label="Versions">
        {versions.map((version) => {
          const state = VERSION_STATES[version.state];
          const current = version.id === detail.skill.currentVersionId;
          return (
            <li key={version.id} className={styles.rowItem}>
              <div className={styles.rowHead}>
                <h3 className={own.versionTitle}>Version {version.version}</h3>
                {current ? <StatusPill status="productive" label="Current" /> : null}
                {!current || version.state !== 'active' ? (
                  <StatusPill status={state.status} label={state.label} />
                ) : null}
                <span className={styles.meta}>{CHANGE_TYPE_LABELS[version.changeType]}</span>
              </div>
              <ExpandableText
                text={version.changeSummary}
                lines={3}
                label={`summary of version ${version.version}`}
                className={own.summary}
              />
              <p className={styles.meta}>
                By {actor(version.createdBy)} <RelativeTime value={version.createdAt} />
                {version.parentVersionId
                  ? ` · builds on version ${semver.get(version.parentVersionId) ?? shortId(version.parentVersionId)}`
                  : ''}
                {' · content '}
                <span className={styles.mono}>{shortId(version.contentHash, 12)}</span>
                <CopyButton
                  value={version.contentHash}
                  label={`Copy the content hash of version ${version.version}`}
                />
              </p>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function DiffBody({
  changes,
  lines,
}: {
  changes: readonly SkillDiffChange[];
  lines: readonly string[];
}) {
  const styles = useSkillStyles();
  const own = useStyles();
  const groups = useMemo(() => {
    const map = new Map<string, SkillDiffChange[]>();
    for (const change of changes)
      map.set(change.section, [...(map.get(change.section) ?? []), change]);
    return [...map.entries()];
  }, [changes]);
  return (
    <div className={styles.stack}>
      <ul className={styles.bullets} aria-label="Summary of the changes">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Accordion>
        <AccordionItem
          title="Every change, by section"
          subtitle={`${changes.length} ${changes.length === 1 ? 'change' : 'changes'} in ${groups.length} ${groups.length === 1 ? 'section' : 'sections'}`}
          headingLevel={3}
          lazy={false}
        >
          <div className={styles.stack}>
            {groups.map(([section, items]) => (
              <section key={section} className={styles.tight} aria-label={sectionLabel(section)}>
                <h4 className={own.sectionTitle}>{sectionLabel(section)}</h4>
                <ul className={styles.rows}>
                  {items.map((change) => {
                    const badge = CHANGE_BADGE[change.type];
                    const showBeforeAfter =
                      change.type === 'modified' && change.before !== null && change.after !== null;
                    return (
                      <li key={`${change.path}:${change.type}`} className={styles.rowItem}>
                        <div className={styles.rowHead}>
                          <StatusPill status={badge.status} label={badge.label} />
                          <span className={styles.mono}>{change.path}</span>
                        </div>
                        <p className={styles.text}>{change.summary}</p>
                        {showBeforeAfter ? (
                          <div className={own.beforeAfter}>
                            <div className={own.side}>
                              <p className={styles.meta}>Before</p>
                              <p className={styles.text}>{change.before}</p>
                            </div>
                            <div className={own.side}>
                              <p className={styles.meta}>After</p>
                              <p className={styles.text}>{change.after}</p>
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

function DiffPanel({ detail }: { detail: SkillDetail }) {
  const styles = useSkillStyles();
  const own = useStyles();
  const auth = useAuth();
  const [fromParam, setFrom] = useUrlState('from', ID_CODEC);
  const [toParam, setTo] = useUrlState('to', ID_CODEC);
  const sorted = [...detail.versions].sort((a, b) => a.sequence - b.sequence);
  const proposed = detail.proposedVersion;
  const defaultTo = proposed?.id ?? sorted.at(-1)?.id ?? null;
  const defaultFrom = proposed ? detail.currentVersion.id : (sorted.at(-2)?.id ?? null);
  const known = (id: string | null): id is string =>
    id !== null && detail.versions.some((v) => v.id === id);
  const from = known(fromParam) ? fromParam : defaultFrom;
  const to = known(toParam) ? toParam : defaultTo;
  const ready = from !== null && to !== null && from !== to;
  const query = useApiQuery(
    'skills.diff',
    {
      params: { skillId: detail.skill.id },
      query: { fromVersionId: from ?? '', toVersionId: to ?? '' },
    },
    { enabled: auth.status === 'ready' && ready, placeholderData: keepPreviousData },
  );
  const options = sorted.map((version) => (
    <option key={version.id} value={version.id}>
      Version {version.version} ({VERSION_STATES[version.state].label})
    </option>
  ));
  return (
    <Panel
      title="What changed between two versions"
      description="A plain-language list of every difference."
      help="Choose any two versions. Each change says what was added, removed or changed in words, with the old and the new text where something was edited. The choice is part of the address."
    >
      {detail.versions.length < 2 ? (
        <EmptyState
          compact
          headingLevel={3}
          icon={<HistoryIcon />}
          title="Only one version so far"
          description="A comparison appears once a change has been proposed or a rollback has created another version."
        />
      ) : (
        <>
          <div className={own.controls}>
            <Field label="From" className={own.field}>
              <Select
                className={styles.select}
                value={from ?? ''}
                onChange={(event) => setFrom(event.target.value || null)}
              >
                {options}
              </Select>
            </Field>
            <Field label="To" className={own.field}>
              <Select
                className={styles.select}
                value={to ?? ''}
                onChange={(event) => setTo(event.target.value || null)}
              >
                {options}
              </Select>
            </Field>
          </div>
          {!ready ? (
            <p className={styles.text}>Choose two different versions to compare.</p>
          ) : (
            <PanelBoundary
              query={query}
              subject="The comparison of versions"
              skeleton={
                <LoadingSkeleton variant="list" count={3} label="Loading the differences" />
              }
              isEmpty={(diff) => diff.changes.length === 0}
              empty={<p className={styles.text}>These two versions have the same content.</p>}
            >
              {(diff) => <DiffBody changes={diff.changes} lines={diff.summaryLines} />}
            </PanelBoundary>
          )}
        </>
      )}
    </Panel>
  );
}

export interface VersionsTabProps {
  detail: SkillDetail;
  onReload: () => void;
}

/** The "Versions" tab: the proposed change, a human-readable diff of any two versions, the history, proposing and rollback. */
export function VersionsTab({ detail, onReload }: VersionsTabProps) {
  const styles = useSkillStyles();
  return (
    <div className={styles.page}>
      <ProposalSection detail={detail} onReload={onReload} />
      <DiffPanel detail={detail} />
      <VersionHistory detail={detail} />
      <ManageSection detail={detail} onReload={onReload} />
    </div>
  );
}
