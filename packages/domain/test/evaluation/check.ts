import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVALUATION_ROOT,
  loadDataset,
  loadVocabulary,
  readLockedRuns,
  type Dataset,
  type LoadedCase,
  type VocabularyData,
} from './dataset';
import {
  describeOverlap,
  detectorTestSource,
  findForbiddenReaders,
  findOverlaps,
  packSource,
  sampleSource,
  splitSource,
  vocabularySource,
  type OverlapSource,
} from './guard';
import { latestRecords } from './labels';
import { verifyChain } from './locked';
import { verifyManifest } from './manifest';
import {
  CASE_ID_PATTERN,
  LETTER_SPLIT,
  NEGATION_REASONS,
  SPLITS,
  WORKLOAD_WITH_PACK,
  labelValueSchema,
  type AnnotationRecord,
  type EvalCase,
  type EvalEvent,
} from './schema';

/**
 * `pnpm --filter @caseguard/domain run eval:check`: structure, vocabulary, hashes and independence of the whole dataset.
 * It never runs the engine and never prints what a detector reads (see guard.ts for what a finding may show).
 */

export interface CheckResult {
  readonly errors: string[];
  readonly warnings: string[];
}

const CUSTOMER_SIDE = new Set(['customer', 'network', 'enduser']);
const CUSTOMER_TYPES = new Set(['customer_email', 'customer_call']);
const ENGINEER_TYPES = new Set([
  'engineer_email',
  'engineer_action',
  'resolution_note',
  'escalation',
  'escalation_response',
]);

/** Addresses and numbers that could belong to a real person or network. Synthetic text may use only reserved ones. */
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const RESERVED_DOMAIN = /(^|\.)(example(\.(com|org|net))?|test|invalid|localhost|corp|local)$/i;
const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

function reservedAddress(a: number, b: number, c: number): boolean {
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function checkSynthetic(source: EvalCase, errors: string[]): void {
  for (const event of source.events) {
    const text = `${event.title ?? ''}\n${event.text}`;
    for (const match of text.matchAll(EMAIL)) {
      if (!RESERVED_DOMAIN.test(match[1] ?? '')) {
        errors.push(`${source.id} ${event.key}: an e-mail address on a domain that is not reserved for examples (${match[1] ?? ''})`);
      }
    }
    for (const match of text.matchAll(IPV4)) {
      const [a = 0, b = 0, c = 0, d = 0] = match.slice(1, 5).map(Number);
      if ([a, b, c, d].some((part) => part > 255)) continue;
      if (!reservedAddress(a, b, c)) errors.push(`${source.id} ${event.key}: a public IPv4 address (${match[0]})`);
    }
  }
}

function checkEvents(loaded: LoadedCase, errors: string[], warnings: string[]): void {
  const { case: source } = loaded;
  const keys = new Set<string>();
  for (const event of source.events) {
    if (keys.has(event.key)) errors.push(`${source.id}: the event key ${event.key} is used twice`);
    keys.add(event.key);
    if (CUSTOMER_TYPES.has(event.type) && !CUSTOMER_SIDE.has(event.who)) {
      errors.push(`${source.id} ${event.key}: a ${event.type} must be written by the customer side, not by "${event.who}"`);
    }
    if (ENGINEER_TYPES.has(event.type) && event.who !== 'engineer') {
      errors.push(`${source.id} ${event.key}: a ${event.type} must be written by the engineer, not by "${event.who}"`);
    }
    if (event.type === 'system_event' && event.who !== 'system') {
      errors.push(`${source.id} ${event.key}: a system_event must come from "system"`);
    }
  }
  if (source.derivedFrom === null) {
    for (let index = 1; index < source.events.length; index += 1) {
      const previous = source.events[index - 1];
      const current = source.events[index];
      if (previous && current && current.at < previous.at) {
        errors.push(`${source.id}: events are listed out of time order at ${current.key} (only a reordered copy hands them over out of order)`);
      }
    }
    const count = source.events.length;
    const standard = count >= 5 && count <= 16;
    const long = count >= 25 && count <= 40;
    if (!standard && !long) warnings.push(`${source.id}: ${count} events (a case has 5 to 16, a few long ones 25 to 40)`);
  }
  checkSynthetic(source, errors);
}

function checkDerived(loaded: LoadedCase, byId: ReadonlyMap<string, LoadedCase>, errors: string[]): void {
  const { case: copy } = loaded;
  if (copy.derivedFrom === null) {
    if (copy.handedOverOrder !== null) errors.push(`${copy.id}: handedOverOrder is only for a reordered copy`);
    if (copy.categories.includes('reordered')) errors.push(`${copy.id}: category "reordered" is only for a copy (derivedFrom)`);
    return;
  }
  if (!copy.categories.includes('reordered')) errors.push(`${copy.id}: a reordered copy must carry the category "reordered"`);
  if (loaded.annotations !== null) errors.push(`${copy.id}: a reordered copy has no labels of its own (it inherits its source's); remove its annotation file`);
  const source = byId.get(copy.derivedFrom)?.case;
  if (!source) {
    errors.push(`${copy.id}: derivedFrom names ${copy.derivedFrom}, which does not exist`);
    return;
  }
  if (source.derivedFrom !== null) errors.push(`${copy.id}: its source ${source.id} is itself a copy`);
  if (source.split !== copy.split) errors.push(`${copy.id}: it is in the ${copy.split} split, its source ${source.id} in ${source.split}`);
  if (source.family !== copy.family) errors.push(`${copy.id}: its family ${copy.family} differs from its source's ${source.family}`);
  if (JSON.stringify(source.events) !== JSON.stringify(copy.events) || source.openedAt !== copy.openedAt || source.workload !== copy.workload) {
    errors.push(`${copy.id}: its events must repeat those of ${source.id} exactly`);
  }
  const order = copy.handedOverOrder;
  if (order === null) {
    errors.push(`${copy.id}: a reordered copy needs handedOverOrder`);
    return;
  }
  const keys = copy.events.map((event) => event.key);
  if (order.length !== keys.length || new Set(order).size !== keys.length || order.some((key) => !keys.includes(key))) {
    errors.push(`${copy.id}: handedOverOrder must list every event key exactly once`);
    return;
  }
  const byTime = [...copy.events].sort((a, b) => a.at - b.at).map((event) => event.key);
  if (JSON.stringify(order) === JSON.stringify(byTime) || JSON.stringify(order) === JSON.stringify(keys)) {
    errors.push(`${copy.id}: handedOverOrder is the order of time (or of the file), so nothing is reordered`);
  }
}

function checkCategories(loaded: LoadedCase, record: AnnotationRecord | undefined, errors: string[], warnings: string[]): void {
  const { case: source } = loaded;
  const hasPack = source.workload === WORKLOAD_WITH_PACK;
  if (!hasPack && !source.categories.includes('unsupported')) errors.push(`${source.id}: workload "${source.workload}" has no knowledge pack, so the case must be in the category "unsupported"`);
  if (hasPack && source.categories.includes('unsupported')) errors.push(`${source.id}: category "unsupported" needs another workload than "${WORKLOAD_WITH_PACK}"`);
  if (!record) return;
  if (source.categories.includes('unsupported') && (record.signals.length > 0 || (record.actions?.length ?? 0) > 0)) {
    warnings.push(`${source.id}: an unsupported case labels signals or actions that the engine will never read`);
  }
  if (source.categories.includes('negation') && record.absent !== undefined) {
    const reasons = record.absent.filter((label) => NEGATION_REASONS.has(label.reason)).length;
    if (reasons < 3) errors.push(`${source.id}: a negation-heavy case labels at least 3 absences with a reason (it has ${reasons})`);
  }
  if (source.categories.includes('contradiction') && record.conflicts !== undefined && record.conflicts.length < 2) {
    errors.push(`${source.id}: a contradiction-heavy case labels at least 2 conflicts (it has ${record.conflicts.length})`);
  }
  if (record.counterfactualDirection === 'better' && record.earliestMissed === null) {
    warnings.push(`${source.id}: the counterfactual direction is "better", but no earliest missed moment is labelled`);
  }
}

export function checkRecord(
  loaded: LoadedCase,
  record: AnnotationRecord,
  vocabulary: VocabularyData,
  registry: Map<string, string>,
  errors: string[],
): void {
  const { case: source } = loaded;
  const at = `${source.id} [${record.annotatorId} v${record.version}]`;
  const events = new Map<string, EvalEvent>(source.events.map((event) => [event.key, event]));
  const signalIds = new Set(vocabulary.signals.map((signal) => signal.id));
  const actionIds = new Set(vocabulary.actions.map((action) => action.id));
  const hypotheses = new Set(vocabulary.hypotheses.map((hypothesis) => hypothesis.id).filter((id) => id !== 'hyp.other'));
  const known = (event: string, what: string): EvalEvent | undefined => {
    const found = events.get(event);
    if (!found) errors.push(`${at}: ${what} names the event ${event}, which the case does not have`);
    return found;
  };

  const registered = registry.get(record.annotatorId);
  if (registered === undefined) errors.push(`${at}: the annotator is not in annotators.json`);
  else if (registered !== record.kind) errors.push(`${at}: annotators.json says ${registered}, the record says ${record.kind}`);
  if (record.excluded !== (record.exclusionReason !== null)) errors.push(`${at}: "excluded" and "exclusionReason" must go together`);

  const present = new Set<string>();
  for (const label of record.signals) {
    known(label.event, 'a signal label');
    if (!signalIds.has(label.id)) errors.push(`${at}: ${label.id} is not a signal of the vocabulary`);
    if (present.has(`${label.event}|${label.id}`)) errors.push(`${at}: ${label.id} is labelled twice on ${label.event}`);
    present.add(`${label.event}|${label.id}`);
  }
  for (const label of record.actions ?? []) {
    const event = known(label.event, 'an action label');
    if (!actionIds.has(label.id)) errors.push(`${at}: ${label.id} is not an action of the vocabulary`);
    if (event && event.who !== 'engineer') errors.push(`${at}: the action ${label.id} is labelled on ${label.event}, which the ${event.who} wrote (actions are labelled on engineer events)`);
    if (present.has(`${label.event}|${label.id}`)) errors.push(`${at}: ${label.id} is labelled twice on ${label.event}`);
    present.add(`${label.event}|${label.id}`);
  }
  const absent = new Set<string>();
  for (const label of record.absent ?? []) {
    known(label.event, 'an absence label');
    if (!signalIds.has(label.id) && !actionIds.has(label.id)) errors.push(`${at}: ${label.id} is neither a signal nor an action of the vocabulary`);
    const key = `${label.event}|${label.id}`;
    if (present.has(key)) errors.push(`${at}: ${label.id} is both present and absent on ${label.event}`);
    if (absent.has(key)) errors.push(`${at}: ${label.id} is marked absent twice on ${label.event}`);
    absent.add(key);
  }
  for (const label of record.forks ?? []) {
    const event = known(label.event, 'a fork label');
    if (event && event.who !== 'engineer') errors.push(`${at}: a fork is labelled on ${label.event}, which the ${event.who} wrote (a decision point is an engineer's step)`);
  }
  if (record.earliestMissed !== undefined && record.earliestMissed !== null) {
    const event = known(record.earliestMissed, 'earliestMissed');
    if (event && event.who !== 'engineer') errors.push(`${at}: earliestMissed is ${record.earliestMissed}, which the ${event.who} wrote (it is an engineer's step)`);
  }
  const order = new Map(source.events.map((event, index) => [event.key, index]));
  for (const conflict of record.conflicts ?? []) {
    const [first, second] = conflict.events;
    known(first, 'a conflict');
    known(second, 'a conflict');
    if (first === second) errors.push(`${at}: a conflict needs two different events`);
    else if ((order.get(first) ?? 0) > (order.get(second) ?? 0)) errors.push(`${at}: a conflict lists the earlier event first (${first} comes after ${second})`);
  }
  for (const cause of record.causes ?? []) {
    if (!hypotheses.has(cause)) errors.push(`${at}: ${cause} is not a named hypothesis of the vocabulary`);
  }
}

function checkAnnotations(
  dataset: Dataset,
  vocabulary: VocabularyData,
  errors: string[],
  warnings: string[],
): void {
  const registry = new Map((dataset.annotators?.annotators ?? []).map((annotator) => [annotator.id, annotator.kind as string]));
  if (dataset.annotators === null) errors.push('annotators.json is missing');
  for (const loaded of dataset.cases) {
    const { case: source, annotations } = loaded;
    if (source.derivedFrom !== null) continue;
    if (annotations === null) {
      errors.push(`${source.id}: no annotation file (annotations/${source.id}.json)`);
      continue;
    }
    if (annotations.caseId !== source.id) errors.push(`${source.id}: its annotation file is for ${annotations.caseId}`);
    const seen = new Set<string>();
    for (const record of annotations.annotations) {
      const key = `${record.annotatorId}@${record.version}`;
      if (seen.has(key)) errors.push(`${source.id}: annotator ${record.annotatorId} has two records of version ${record.version}`);
      seen.add(key);
      checkRecord(loaded, record, vocabulary, registry, errors);
    }
    const latest = latestRecords(annotations);
    checkCategories(loaded, latest[0], errors, warnings);
    const adjudication = annotations.adjudication;
    if (adjudication !== null) {
      if (!latest.some((record) => record.annotatorId === adjudication.acceptedFrom)) {
        errors.push(`${source.id}: the adjudication accepts labels of ${adjudication.acceptedFrom}, who has no record`);
      }
      if (latest.length < 2 && adjudication.status !== 'single_annotator' && adjudication.status !== 'excluded') {
        errors.push(`${source.id}: an adjudication of status ${adjudication.status} needs two annotators`);
      }
      for (const disagreement of adjudication.disagreements) {
        if (!labelValueSchema(disagreement.field).safeParse(disagreement.accepted).success) {
          errors.push(`${source.id}: the accepted value of "${disagreement.field}" in the adjudication is not a valid ${disagreement.field} label`);
        }
      }
    } else if (latest.length > 1) {
      warnings.push(`${source.id}: ${latest.length} annotators and no adjudication: the case is reported and not counted`);
    }
  }
  // An annotation file without a case.
  const dir = join(dataset.root, 'annotations');
  if (existsSync(dir)) {
    const ids = new Set(dataset.cases.map((loaded) => loaded.case.id));
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
      if (!ids.has(name.replace(/\.json$/, ''))) errors.push(`annotations/${name}: there is no case ${name.replace(/\.json$/, '')}`);
    }
  }
}

function checkPlacement(dataset: Dataset, errors: string[]): void {
  const byId = new Map<string, LoadedCase>();
  const familySplit = new Map<string, Set<string>>();
  for (const loaded of dataset.cases) {
    const { case: source } = loaded;
    if (byId.has(source.id)) errors.push(`${source.id}: the id is used in two files`);
    byId.set(source.id, loaded);
    const parts = CASE_ID_PATTERN.exec(source.id);
    if (parts && LETTER_SPLIT[parts[1] ?? ''] !== source.split) errors.push(`${source.id}: the id says split ${LETTER_SPLIT[parts[1] ?? ''] ?? '?'}, the case says ${source.split}`);
    if (loaded.caseFile !== `cases/${source.split}/${source.id}.json`) errors.push(`${loaded.caseFile}: a case file is cases/<split>/<id>.json, for split ${source.split} and id ${source.id}`);
    const splits = familySplit.get(source.family) ?? new Set<string>();
    splits.add(source.split);
    familySplit.set(source.family, splits);
  }
  for (const [family, splits] of familySplit) {
    if (splits.size > 1) errors.push(`${family}: a family lives in exactly one split, this one is in ${[...splits].join(' and ')}`);
  }
  for (const loaded of dataset.cases) checkDerived(loaded, byId, errors);
}

export function independenceSources(dataset: Dataset): OverlapSource[] {
  return [
    sampleSource(),
    vocabularySource(dataset.root),
    packSource(),
    detectorTestSource(),
    ...SPLITS.map((split) => splitSource(dataset, split)),
  ];
}

export function checkDataset(
  dataset: Dataset,
  vocabulary: VocabularyData,
  options: { readonly overlaps?: boolean } = {},
): CheckResult {
  const errors: string[] = [...dataset.problems];
  const warnings: string[] = [];
  checkPlacement(dataset, errors);
  for (const loaded of dataset.cases) checkEvents(loaded, errors, warnings);
  checkAnnotations(dataset, vocabulary, errors, warnings);
  errors.push(...verifyManifest(dataset));
  try {
    const log = readLockedRuns(dataset.root);
    if (log) errors.push(...verifyChain(log, dataset.manifest?.locked?.testSetSha256 ?? null));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const offender of findForbiddenReaders()) errors.push(`${offender.file}: ${offender.reason}`);
  if (options.overlaps !== false) {
    const cases = dataset.cases.map((loaded) => loaded.case);
    for (const overlap of findOverlaps(cases, independenceSources(dataset))) errors.push(describeOverlap(overlap));
  }
  return { errors, warnings };
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const dataset = loadDataset();
  const result = checkDataset(dataset, loadVocabulary(EVALUATION_ROOT));
  const write = (lines: readonly string[], title: string): void => {
    if (lines.length > 0) process.stdout.write(`${title}\n${lines.map((line) => `  - ${line}`).join('\n')}\n`);
  };
  write(result.errors, `${result.errors.length} error(s):`);
  write(result.warnings, `${result.warnings.length} warning(s):`);
  process.stdout.write(
    result.errors.length === 0
      ? `eval:check passed: ${dataset.cases.length} case files, ${result.warnings.length} warning(s).\n`
      : 'eval:check FAILED.\n',
  );
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}
