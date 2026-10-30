'use client';

import type { SkillDetail, SkillDiffChange } from '@caseguard/schemas';
import {
  CopyButton,
  EmptyState,
  LoadingSkeleton,
  Panel,
  StatusBadge,
  formatDateTimeUtc,
} from '@caseguard/ui';
import { Field, Select } from '@fluentui/react-components';
import { HistoryRegular } from '@fluentui/react-icons';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApiQuery } from '../../lib/api/hooks';
import { useAuth } from '../../lib/auth/context';
import { shortId } from '../../lib/format';
import { codecs, useUrlState } from '../../lib/url-state';
import { useActorLabel } from '../quality/actors';
import { ClampedText } from '../quality/ClampedText';
import { PanelBoundary } from '../quality/PanelBoundary';
import { useInsightStyles } from '../quality/styles';
import { ManageSection, ProposalSection } from './ChangesPanels';
import { CHANGE_TYPE_LABELS, VERSION_STATES } from './labels';

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
  confidence: 'Confidence',
  applicability: 'Applicability',
  expectedBenefit: 'Expected benefit',
  provenance: 'Provenance',
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

function VersionHistory({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
  const actor = useActorLabel();
  const versions = [...detail.versions].sort((a, b) => b.sequence - a.sequence);
  const semver = new Map(detail.versions.map((version) => [version.id, version.version]));
  return (
    <Panel
      title="Version history"
      description="Every version, newest first. History is never rewritten."
      help="A version is a complete copy of the skill. Changes arrive as proposals, and a rollback adds a new version rather than deleting one. The content hash identifies the exact content, so two versions with the same hash have the same content."
    >
      <ol className={styles.list} aria-label="Versions">
        {versions.map((version) => {
          const state = VERSION_STATES[version.state];
          return (
            <li key={version.id} className={styles.item}>
              <div className={styles.itemHead}>
                <h3 className={styles.itemTitle}>Version {version.version}</h3>
                <StatusBadge status={state.status} label={state.label} size="small" />
                {version.id === detail.skill.currentVersionId ? (
                  <StatusBadge status="productive" label="Current" size="small" />
                ) : null}
                <span className={styles.meta}>{CHANGE_TYPE_LABELS[version.changeType]}</span>
              </div>
              <ClampedText
                text={version.changeSummary}
                lines={3}
                label={`summary of version ${version.version}`}
              />
              <p className={styles.meta}>
                By {actor(version.createdBy)} on {formatDateTimeUtc(version.createdAt)}
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
  const styles = useInsightStyles();
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
      {groups.map(([section, items]) => (
        <section key={section} className={styles.stack} aria-label={sectionLabel(section)}>
          <h3 className={styles.itemTitle}>{sectionLabel(section)}</h3>
          <ul className={styles.list}>
            {items.map((change) => {
              const badge = CHANGE_BADGE[change.type];
              const showBeforeAfter =
                change.type === 'modified' && change.before !== null && change.after !== null;
              return (
                <li key={`${change.path}:${change.type}`} className={styles.item}>
                  <div className={styles.itemHead}>
                    <StatusBadge status={badge.status} label={badge.label} size="small" />
                    <span className={styles.mono}>{change.path}</span>
                  </div>
                  <p className={styles.text}>{change.summary}</p>
                  {showBeforeAfter ? (
                    <div className={styles.band}>
                      <div>
                        <p className={styles.meta}>Before</p>
                        <p className={styles.text}>{change.before}</p>
                      </div>
                      <div>
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
  );
}

function DiffPanel({ detail }: { detail: SkillDetail }) {
  const styles = useInsightStyles();
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
          icon={<HistoryRegular />}
          title="Only one version so far"
          description="A comparison appears once a change has been proposed or a rollback has created another version."
        />
      ) : (
        <>
          <div className={styles.toolbar}>
            <Field label="From" className={styles.field}>
              <Select
                className={styles.select}
                value={from ?? ''}
                onChange={(_event, next) => setFrom(next.value || null)}
              >
                {options}
              </Select>
            </Field>
            <Field label="To" className={styles.field}>
              <Select
                className={styles.select}
                value={to ?? ''}
                onChange={(_event, next) => setTo(next.value || null)}
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
  const styles = useInsightStyles();
  return (
    <div className={styles.page}>
      <ProposalSection detail={detail} onReload={onReload} />
      <DiffPanel detail={detail} />
      <VersionHistory detail={detail} />
      <ManageSection detail={detail} onReload={onReload} />
    </div>
  );
}
