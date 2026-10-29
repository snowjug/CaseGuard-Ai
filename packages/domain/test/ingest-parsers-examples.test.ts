import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CaseBundleSchema,
  CUSTOMER_SIDE_ROLES,
  type CaseBundle,
  type CaseEvent,
} from '@caseguard/schemas';
import { createTemporalView, runDeterministicAnalysis } from '../src';
import { parseCaseBundleJson, parseCsvEvents, parsePastedTranscript } from '../src/ingest/parsers';
import { BASE, expectOk, expectValidDraft, readExample } from './ingest-parsers.helpers';
import { CONFIG, prepareBundle } from './helpers';

const casesDir = resolve(import.meta.dirname, '../../../synthetic-data/cases');
const transcript = readExample('transcript-teams-signin-proxy.txt');
const csv = readExample('events-teams-signin-proxy.csv');
const minimal = readExample('minimal-case-bundle.json');

const csvDraft = () =>
  expectOk(
    parseCsvEvents(csv, {
      ...BASE,
      reference: 'CG-SYN-2002',
      workload: 'teams-authentication',
      product: 'Microsoft Teams',
      severity: 'B',
      customerAlias: 'Fabrikam Synthetic BV',
    }),
  );

describe('synthetic examples parse cleanly', () => {
  it('[FR-ING-09] the pasted transcript becomes the expected 15-event draft', () => {
    const draft = expectOk(parsePastedTranscript(transcript, BASE));
    const { bundle } = draft;
    expect(bundle.case).toMatchObject({
      reference: 'CG-SYN-2001',
      workload: 'teams-authentication',
      severity: 'B',
      status: 'resolved',
      closedAt: '2026-04-14T16:10:00Z',
      customerAlias: 'Fabrikam Synthetic BV',
      openedAt: '2026-04-14T07:35:00Z',
    });
    expect(bundle.participants.map((p) => `${p.role}:${p.alias}`)).toEqual([
      'customer_admin:Customer IT Admin 1',
      'support_engineer:Support Engineer 1',
      'customer_network_admin:Customer Network Admin 1',
      'system:Case System',
    ]);
    expect(bundle.events.map((e) => e.type)).toEqual([
      'customer_email',
      'engineer_email',
      'engineer_action',
      'customer_email',
      'engineer_action',
      'query_output',
      'case_note',
      'engineer_email',
      'customer_email',
      'engineer_email',
      'customer_email',
      'customer_email',
      'validation_result',
      'resolution_note',
      'status_change',
    ]);
    const links = bundle.events.flatMap((e) =>
      e.inResponseTo ? [`${e.id}>${e.inResponseTo}`] : [],
    );
    expect(links).toEqual(['e04>e02', 'e06>e05', 'e09>e08', 'e11>e10']);
    expect(bundle.resolution).toMatchObject({
      resolvedAt: '2026-04-14T16:00:00Z',
      workaround: 'proxy-rtm-2 removed from PAC rotation at 11:35 UTC.',
    });
    expect(bundle.resolution?.rootCause).toContain('proxy-rtm-2 was saturated (97 percent CPU)');
    expectValidDraft(bundle);
  });

  it('[FR-ING-09] the transcript raises no warnings that need attention and is highly confident', () => {
    const draft = expectOk(parsePastedTranscript(transcript, BASE));
    expect(draft.warnings.filter((w) => w.severity === 'warning')).toEqual([]);
    expect(draft.warnings.map((w) => w.code)).toEqual(['quoted_text_removed']);
    expect(draft.confidence).toMatchObject({ level: 'high', estimated: true });
    expect(draft.confidence.score).toBeGreaterThanOrEqual(0.95);
    expect(draft.stats).toMatchObject({ events: 15, participants: 4, ignoredLines: 0 });
  });

  it('[FR-ING-09] the CSV becomes a 13-event draft with explicit links and actions', () => {
    const { bundle, warnings } = csvDraft();
    expect(bundle.events).toHaveLength(13);
    expect(bundle.participants.map((p) => p.role)).toEqual([
      'customer_admin',
      'support_engineer',
      'customer_network_admin',
      'system',
    ]);
    expect(
      bundle.events.filter((e) => e.inResponseTo).map((e) => `${e.id}>${e.inResponseTo}`),
    ).toEqual(['E03>E02', 'E05>E04', 'E08>E07', 'E10>E09']);
    expect(bundle.events[1]?.action).toMatchObject({
      customerEffort: 'low',
      durationMinutes: 8,
      destructive: false,
    });
    expect(bundle.events[4]?.body).toContain('\n| join kind=leftouter');
    expect(bundle.resolution?.rootCause).toContain('proxy-rtm-2 was saturated');
    expect(bundle.case).toMatchObject({
      status: 'resolved',
      title: 'Teams sign-in failing at Rotterdam',
    });
    expect(warnings.filter((w) => w.severity === 'warning')).toEqual([]);
    expectValidDraft(bundle);
  });

  it('[FR-ING-09] the minimal JSON bundle is valid and as small as the schema allows', () => {
    const draft = expectOk(parseCaseBundleJson(minimal));
    expect(draft.bundle.events).toHaveLength(3);
    expect(draft.bundle.resolution).toBeUndefined();
    expect(draft.warnings).toEqual([]);
  });

  it('[FR-ING-09] every example is clearly synthetic and carries no real-looking addresses', () => {
    const files = { transcript, csv, minimal };
    for (const [name, text] of Object.entries(files)) {
      expect(text.toLowerCase(), name).toMatch(/synthetic/);
      for (const mail of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) {
        expect(mail, `${name}: ${mail}`).toMatch(/\.invalid$/);
      }
      for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        expect(ip, `${name}: ${ip}`).toMatch(
          /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/,
        );
      }
      for (const host of text.match(/https?:\/\/[\w.-]+/g) ?? []) {
        expect(host, `${name}: ${host}`).toMatch(
          /login\.microsoftonline\.com|aadcdn\.msftauth\.net/,
        );
      }
    }
    expect(expectOk(parsePastedTranscript(transcript, BASE)).bundle.syntheticNotice).toContain(
      'SYNTHETIC',
    );
    expect(JSON.parse(minimal)).toMatchObject({ synthetic: true });
  });
});

describe('round trip: example -> draft bundle -> normalizeBundle -> deterministic analysis', () => {
  it('[FR-ING-09] the transcript analyses end to end and reaches the proxy diagnosis', () => {
    const { bundle } = expectOk(parsePastedTranscript(transcript, BASE));
    const prepared = prepareBundle(bundle);
    const { analysis } = prepared;
    expect(prepared.normalized.events).toHaveLength(15);
    expect(prepared.normalized.case.synthetic).toBe(true);
    expect(prepared.normalized.resolution?.rootCause).toContain('proxy-rtm-2');
    const ranked = [...analysis.hypotheses].sort(
      (a, b) => b.currentConfidence - a.currentConfidence,
    );
    expect(ranked[0]).toMatchObject({ key: 'hyp.proxy-egress', currentStatus: 'confirmed' });
    expect(ranked[0]?.currentConfidence).toBeGreaterThan(0.85);
    expect(ranked[0]?.modelEstimate).toBe(true);
    expect(analysis.evidence.length).toBeGreaterThan(5);
    expect(analysis.claims.length).toBeGreaterThan(10);
    expect(analysis.actions.map((a) => a.actionKey)).toEqual(
      expect.arrayContaining([
        'act.request-minimal-scoping',
        'act.check-service-health',
        'act.signin-log-correlation',
      ]),
    );
    expect(analysis.forks).toEqual([]);
  });

  it('[FR-ING-09] an as-of replay of the parsed transcript only uses what was known by then', () => {
    const prepared = prepareBundle(expectOk(parsePastedTranscript(transcript, BASE)).bundle);
    const events = prepared.normalized.events;
    const cut = events[2] as CaseEvent;
    const prefix = runDeterministicAnalysis({
      view: createTemporalView(events, cut.timestamp),
      pack: prepared.pack,
      config: CONFIG,
      ctx: prepared.ctx,
    });
    const known = prepared.analysis.evidence.filter((e) => e.observedAt <= cut.timestamp);
    expect(prefix.evidence.map((e) => e.id)).toEqual(known.map((e) => e.id));
    const full = prepared.analysis.hypotheses.find((h) => h.key === 'hyp.proxy-egress');
    const early = prefix.hypotheses.find((h) => h.key === 'hyp.proxy-egress');
    expect(early?.currentConfidence).toBeLessThan(full?.currentConfidence ?? 0);
  });

  it('[FR-ING-09] the CSV analyses end to end', () => {
    const prepared = prepareBundle(csvDraft().bundle);
    const ranked = [...prepared.analysis.hypotheses].sort(
      (a, b) => b.currentConfidence - a.currentConfidence,
    );
    expect(ranked[0]).toMatchObject({ key: 'hyp.proxy-egress', currentStatus: 'confirmed' });
    expect(prepared.analysis.evidence.length).toBeGreaterThan(5);
  });

  it('[FR-ING-09] the minimal JSON bundle analyses without a resolution', () => {
    const prepared = prepareBundle(expectOk(parseCaseBundleJson(minimal)).bundle);
    expect(prepared.normalized.resolution).toBeNull();
    expect(prepared.analysis.hypotheses.length).toBeGreaterThan(1);
  });
});

/** Renders a bundle as a plain "[time] Alias: body" transcript, dropping titles and structure. */
function renderAsTranscript(bundle: CaseBundle): string {
  const alias = new Map(bundle.participants.map((p) => [p.id, p.alias] as const));
  return bundle.events
    .map((e) => {
      const stamp = `${e.timestamp.slice(0, 10)} ${e.timestamp.slice(11, 16)} UTC`;
      return `[${stamp}] ${alias.get(e.participantId)}: ${e.body}`;
    })
    .join('\n');
}

describe('fidelity: plain-text renderings of the sample cases', () => {
  const samples = ['case-one-teams-signin-dns.json', 'case-two-teams-signin-proxy.json'].map(
    (file) => ({
      file,
      bundle: CaseBundleSchema.parse(JSON.parse(readFileSync(resolve(casesDir, file), 'utf8'))),
    }),
  );

  it.each(samples)(
    '[FR-ING-01] recovers roles, order and most event types of $file',
    ({ bundle }) => {
      const draft = expectOk(
        parsePastedTranscript(renderAsTranscript(bundle), {
          ...BASE,
          workload: bundle.case.workload,
        }),
      );
      expect(draft.bundle.events).toHaveLength(bundle.events.length);
      const roleOf = (b: CaseBundle) => new Map(b.participants.map((p) => [p.id, p.role] as const));
      const original = roleOf(bundle);
      const parsed = roleOf(draft.bundle);
      let typeHits = 0;
      bundle.events.forEach((event, i) => {
        const other = draft.bundle.events[i];
        expect(other?.timestamp).toBe(event.timestamp);
        expect(parsed.get(other?.participantId ?? '')).toBe(original.get(event.participantId));
        if (other?.type === event.type) typeHits += 1;
      });
      const agreement = typeHits / bundle.events.length;
      expect(agreement).toBeGreaterThanOrEqual(0.9);
      expect(draft.warnings.filter((w) => w.code === 'role_unknown')).toEqual([]);
    },
  );

  it('[FR-ING-01] never types customer-side messages as engineer events or the reverse', () => {
    for (const { bundle } of samples) {
      const draft = expectOk(
        parsePastedTranscript(renderAsTranscript(bundle), {
          ...BASE,
          workload: bundle.case.workload,
        }),
      );
      const roles = new Map(draft.bundle.participants.map((p) => [p.id, p.role] as const));
      for (const event of draft.bundle.events) {
        const customerSide = CUSTOMER_SIDE_ROLES.includes(
          roles.get(event.participantId) ?? 'system',
        );
        const customerType = event.type === 'customer_email' || event.type === 'customer_call';
        if (customerType) expect(customerSide).toBe(true);
        if (event.type === 'engineer_email' || event.type === 'engineer_action') {
          expect(customerSide).toBe(false);
        }
      }
    }
  });
});
