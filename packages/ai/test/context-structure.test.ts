import { describe, expect, it } from 'vitest';
import {
  buildContext,
  contextProse,
  contextStructureKey,
  defaultInjectionScanner,
  type AgentContext,
  type AgentTask,
} from '../src';
import { one } from './orchestrator-harness';
import {
  baseOf,
  cfTask,
  classifierTask,
  forkTask,
  hypothesisTask,
  qualityTask,
  skillTask,
  viewUpTo,
  wholeRecordView,
} from './tasks';

type Path = (string | number)[];

const DEPS = {
  redact: (text: string) => text,
  scanInjection: defaultInjectionScanner,
  maxAnalysisDepth: 8,
};

/** The free text of events and the evidence and claim text derived from it: the only prose. */
const PROSE_PATH =
  /^events\.\d+\.(title|text)$|^evidence\.\d+\.(summary|excerpt)$|^claims\.\d+\.text$/;

function leafPaths(node: unknown, path: Path = [], out: Path[] = []): Path[] {
  if (Array.isArray(node)) node.forEach((item, i) => leafPaths(item, [...path, i], out));
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) leafPaths(value, [...path, key], out);
  } else out.push(path);
  return out;
}

const dotted = (path: Path): string => path.join('.');
const shapeOf = (path: Path): string =>
  path.map((part) => (typeof part === 'number' ? '*' : part)).join('.');

function parentAt(root: unknown, path: Path): Record<string | number, unknown> {
  let node = root;
  for (const part of path.slice(0, -1)) node = (node as Record<string | number, unknown>)[part];
  return node as Record<string | number, unknown>;
}

/** Changes a leaf in place so that it is certainly a different value of the same kind. */
function perturb(context: AgentContext, path: Path): void {
  const parent = parentAt(context, path);
  const last = path[path.length - 1] as string | number;
  const value = parent[last];
  parent[last] =
    typeof value === 'string'
      ? `${value}~`
      : typeof value === 'number'
        ? value + 1
        : typeof value === 'boolean'
          ? !value
          : 'x';
}

/** Up to three leaves (first, middle, last) of every field shape, so each kind of field is covered. */
function sampledLeaves(context: AgentContext): Path[] {
  const byShape = new Map<string, Path[]>();
  for (const path of leafPaths(context)) {
    byShape.set(shapeOf(path), [...(byShape.get(shapeOf(path)) ?? []), path]);
  }
  return [...byShape.values()].flatMap((paths) => {
    const middle = paths[Math.floor(paths.length / 2)];
    return [...new Set([paths[0], middle, paths[paths.length - 1]])].flatMap((p) => (p ? [p] : []));
  });
}

const TASKS: [string, AgentTask][] = [
  ['counterfactual simulator (focus: strategy, allowed actions)', cfTask(one, 'e09')],
  ['skill extractor (focus: scenario)', skillTask(one, 'e09')],
  ['quality judge (focus: forks, requirements, resolution)', qualityTask(one)],
  ['decision-fork detector (focus: engineer actions)', forkTask(one)],
  ['evidence classifier (claims)', classifierTask(one)],
  ['hypothesis generator (knowledge catalogue)', hypothesisTask(one, viewUpTo(one, 'e14'))],
];

describe('the cache bucket is derived from everything except event prose [FR-TK-02]', () => {
  for (const [name, task] of TASKS) {
    it(`[FR-TK-02] ${name}: changing any non-prose field changes the structure key, changing prose never does`, () => {
      const base = buildContext(task, 0, DEPS).context;
      const baseKey = contextStructureKey(base);
      const baseProse = contextProse(base);
      expect(baseKey).toMatch(/^[a-f0-9]{64}$/);

      let structural = 0;
      let prose = 0;
      for (const path of sampledLeaves(base)) {
        const mutated = structuredClone(base);
        const isProse = PROSE_PATH.test(dotted(path));
        if (isProse && parentAt(base, path)[path[path.length - 1] as string | number] === null)
          continue;
        perturb(mutated, path);
        if (isProse) {
          prose++;
          expect(contextStructureKey(mutated), `prose field ${shapeOf(path)}`).toBe(baseKey);
          expect(contextProse(mutated), `prose field ${shapeOf(path)}`).not.toBe(baseProse);
        } else {
          structural++;
          expect(contextStructureKey(mutated), `structure field ${shapeOf(path)}`).not.toBe(
            baseKey,
          );
        }
      }
      expect(structural).toBeGreaterThan(15);
      expect(prose).toBeGreaterThan(0);

      const longer = structuredClone(base);
      const first = base.events[0];
      if (!first) throw new Error('the context has no events');
      longer.events.push({ ...structuredClone(first), id: 'e_extra' });
      expect(contextStructureKey(longer), 'an extra event').not.toBe(baseKey);
      const shorter = structuredClone(base);
      shorter.events.pop();
      expect(contextStructureKey(shorter), 'a missing event').not.toBe(baseKey);
    });
  }

  it('[FR-TK-02] the structure key is stable, and the prose is the event text and nothing else', () => {
    const task = cfTask(one, 'e09');
    const a = buildContext(task, 0, DEPS).context;
    const b = buildContext(task, 0, DEPS).context;
    expect(contextStructureKey(a)).toBe(contextStructureKey(b));
    const prose = contextProse(a);
    const someText = a.events.find((e) => e.text !== null)?.text;
    expect(someText).toBeTruthy();
    expect(prose).toContain(someText ?? '');
    expect(prose).not.toContain('"strategy"');
  });

  it('[FR-TK-02] the trim level is structure: the same request at another level is another bucket', () => {
    const task = baseOf(one, wholeRecordView(one));
    const full = buildContext({ agent: 'timeline_analyzer', input: task }, 0, DEPS).context;
    const trimmed = buildContext({ agent: 'timeline_analyzer', input: task }, 2, DEPS).context;
    expect(contextStructureKey(full)).not.toBe(contextStructureKey(trimmed));
  });
});
