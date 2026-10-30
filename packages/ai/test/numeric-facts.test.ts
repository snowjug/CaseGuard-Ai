import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_CONFIG } from '@caseguard/schemas';
import { AiOrchestrator, prepareTask, validateAgentOutput, type AgentTask } from '../src';
import { one } from './orchestrator-harness';
import { skillTask, timelineTask, validOutput } from './tasks';

const deps = new AiOrchestrator({ config: DEFAULT_MODEL_CONFIG }).prepareDependencies;

function vctxOf(task: AgentTask) {
  const { vctx } = prepareTask(task, 'req_facts', 'm', deps, { applyBudget: false });
  if (!vctx) throw new Error('no validation context');
  return vctx;
}

const codes = (report: { issues: { code: string }[] }): string[] =>
  report.issues.map((i) => i.code);

const events = one.normalized.events;
const indexOf = (id: string): number => events.findIndex((e) => e.id === id);
const minutesBetween = (fromId: string, toId: string): number => {
  const from = events[indexOf(fromId)];
  const to = events[indexOf(toId)];
  if (!from || !to) throw new Error('unknown event');
  return Math.max(0, Math.round((Date.parse(to.timestamp) - Date.parse(from.timestamp)) / 60_000));
};

describe('numbers and relations the record can recompute are checked [NFR-SEC-05]', () => {
  const task = timelineTask(one);
  const vctx = vctxOf(task);
  const validate = (out: unknown) => validateAgentOutput('timeline_analyzer', out, vctx);

  it('[NFR-SEC-05] the reference timeline passes, with its delays exactly as the record gives them', () => {
    const out = validOutput(task);
    expect(out.delays.length).toBeGreaterThan(0);
    const report = validate(out);
    expect(codes(report)).toEqual([]);
    expect(report.ok).toBe(true);
    for (const d of out.delays) expect(d.minutes).toBe(minutesBetween(d.fromEventId, d.toEventId));
  });

  it('[NFR-SEC-05] rejects a delay whose minutes are not the gap between the two events', () => {
    const out = validOutput(task);
    const delay = out.delays[0];
    if (!delay) throw new Error('the reference output has no delay');
    delay.minutes = 525_000;
    const report = validate(out);
    expect(codes(report)).toContain('delay_minutes');
    expect(report.ok).toBe(false);
    expect(report.outcome.citationsValid).toBe(false);
    expect(report.repairable).toBe(true);
    const message = report.issues.find((i) => i.code === 'delay_minutes')?.message ?? '';
    expect(message).toContain(String(minutesBetween(delay.fromEventId, delay.toEventId)));
    expect(message).not.toContain('525000');
  });

  it('[NFR-SEC-05] is exact: one minute too many is rejected too', () => {
    const out = validOutput(task);
    const delay = out.delays[0];
    if (!delay) throw new Error('the reference output has no delay');
    delay.minutes += 1;
    expect(codes(validate(out))).toContain('delay_minutes');
  });

  it('[NFR-SEC-05] rejects a delay that runs backwards in time', () => {
    const out = validOutput(task);
    const delay = out.delays[0];
    if (!delay) throw new Error('the reference output has no delay');
    [delay.fromEventId, delay.toEventId] = [delay.toEventId, delay.fromEventId];
    expect(codes(validate(out))).toContain('delay_order');
  });

  it('[NFR-SEC-05] rejects a delay between events that are not consecutive, even with the right elapsed time', () => {
    const out = validOutput(task);
    const delay = out.delays.find((d) => {
      const at = indexOf(d.toEventId);
      const before = events[at - 2];
      const between = events[at - 1];
      return (
        before !== undefined && between !== undefined && minutesBetween(before.id, between.id) >= 2
      );
    });
    if (!delay) throw new Error('the reference output has no suitable delay');
    const earlier = events[indexOf(delay.toEventId) - 2];
    if (!earlier) throw new Error('no earlier event');
    delay.fromEventId = earlier.id;
    delay.minutes = minutesBetween(earlier.id, delay.toEventId);
    const found = codes(validate(out));
    expect(found).toContain('delay_not_consecutive');
    expect(found).not.toContain('delay_minutes');
    expect(found).not.toContain('delay_order');
  });

  it('[NFR-SEC-05] a delay naming an unknown event is a citation problem only', () => {
    const out = validOutput(task);
    const delay = out.delays[0];
    if (!delay) throw new Error('the reference output has no delay');
    delay.fromEventId = 'e99';
    const found = codes(validate(out));
    expect(found).toContain('unknown_event');
    expect(found.filter((c) => c.startsWith('delay_'))).toEqual([]);
  });

  it('[NFR-SEC-05] the repair feedback never repeats the model-supplied number', () => {
    const out = validOutput(task);
    const delay = out.delays[0];
    if (!delay) throw new Error('the reference output has no delay');
    delay.minutes = 123_457;
    expect(JSON.stringify(validate(out).issues)).not.toContain('123457');
  });
});

describe('skill steps are numbered 1..n [NFR-SEC-05]', () => {
  const task = skillTask(one, 'e09');
  const vctx = vctxOf(task);

  it('[NFR-SEC-05] rejects steps whose order is not 1..n without gaps', () => {
    const out = validOutput(task);
    expect(validateAgentOutput('skilldna_extractor', out, vctx).ok).toBe(true);
    const step = out.steps[0];
    if (!step) throw new Error('the reference skill has no step');
    step.order = 7;
    const report = validateAgentOutput('skilldna_extractor', out, vctx);
    expect(codes(report)).toContain('step_order');
    expect(report.ok).toBe(false);
    expect(report.repairable).toBe(true);
  });

  it('[NFR-SEC-05] rejects repeated step numbers', () => {
    const out = validOutput(task);
    const first = out.steps[0];
    if (!first) throw new Error('the reference skill has no step');
    out.steps = [first, { ...first }];
    expect(codes(validateAgentOutput('skilldna_extractor', out, vctx))).toContain('step_order');
  });
});
