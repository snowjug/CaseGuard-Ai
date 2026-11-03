import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CaseCriticOutputSchema, CaseReasonerOutputSchema } from '@caseguard/schemas';
import * as layer from '../../src';
import { runModelAssistedReview, type Script } from '../../src';
import {
  conclusionsOf,
  criticReply,
  emptyCriticReply,
  one,
  reviewHarness,
  reviewInput,
  validReply,
  view,
} from './case-one';
import { assertSafeResult, truthyKeys } from './safety';

const srcDir = resolve(import.meta.dirname, '../../src');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });

/** Every property name a JSON schema declares, at any depth. */
function propertyNames(schema: unknown): string[] {
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && typeof value === 'object' && value !== null) {
        names.push(...Object.keys(value));
      }
      visit(value);
    }
  };
  visit(schema);
  return names;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

describe('nothing in the model layer decides, accepts or approves', () => {
  it('exports no function that reviews, approves, accepts, rejects, confirms or decides', () => {
    const names = Object.keys(layer);
    const offending = names.filter((name) =>
      /^(?:accept|approve|reject|decide|confirm|resolve|close|mark|setReview|saveReview|writeReview|persist|store|save)/i.test(
        name,
      ),
    );
    expect(offending).toEqual([]);
  });

  it('has no source in the reasoning layer or the scripted provider that sets a review state other than pending, or a flag of acceptance', () => {
    const files = [
      ...sources(join(srcDir, 'reasoning')),
      ...sources(join(srcDir, 'providers', 'scripted')),
    ];
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /\b(?:accepted|approved|isAccepted|isApproved)\s*[:=]\s*true\b/,
      );
      expect(text, file).not.toMatch(/reviewState\s*[:=]\s*['"](?!pending['"])/);
      expect(text, file).not.toMatch(/hybridStatus\s*[:=]\s*['"](?:DETERMINISTIC|REJECTED)['"]/);
    }
  });

  it('writes nowhere: the layer imports no repository, database, file system or network module', () => {
    const files = [
      ...sources(join(srcDir, 'reasoning')),
      ...sources(join(srcDir, 'providers', 'scripted')),
    ];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /from ['"](?:node:(?:fs|net|http|https|child_process|dgram)|pg|fs|http|https|undici|axios)['"]/,
      );
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it('gives the model no field that could carry an acceptance, a status, a tool call or a command', () => {
    for (const schema of [CaseReasonerOutputSchema, CaseCriticOutputSchema]) {
      const names = propertyNames(z.toJSONSchema(schema));
      expect(names.length).toBeGreaterThan(20);
      const forbidden = names.filter((name) =>
        /^(?:accepted|approved|approvedBy|status|reviewState|hybridStatus|validationStatus|modelOnly|deterministicCorroboration|tool_?calls?|function_?call|toolCalls|command|execute|url|href|email|webhook)$/i.test(
          name,
        ),
      );
      expect(forbidden).toEqual([]);
    }
  });

  describe('the whole pipeline', () => {
    const conclusions = conclusionsOf();
    const scripts: [string, Script][] = [
      [
        'an ordinary run',
        {
          case_reasoner: { output: validReply() },
          case_critic: { output: criticReply([{ targetId: conclusions[0]?.id ?? 'C1' }]) },
        },
      ],
      [
        'a reasoner that approves itself',
        {
          case_reasoner: () => {
            const reply = validReply();
            for (const item of reply.signals as Record<string, unknown>[])
              Object.assign(item, { approved: true, accepted: true, reviewState: 'accepted' });
            Object.assign(reply, { approved: true });
            return { output: reply };
          },
          case_critic: { output: emptyCriticReply() },
        },
      ],
      [
        'a critic that approves everything',
        {
          case_reasoner: { output: validReply() },
          case_critic: () => {
            const reply = criticReply(
              [{ targetId: conclusions[0]?.id ?? 'C1', kind: 'supported' }],
              'no_concerns',
            );
            Object.assign(reply.result as Record<string, unknown>, {
              approved: true,
              accepted: true,
            });
            return { output: reply };
          },
        },
      ],
    ];

    it.each(scripts.map(([name, script]) => ({ name, script })))(
      '$name: no field named accepted or approved is true, and every finding is pending',
      async ({ script }) => {
        const before = JSON.stringify(one.analysis);
        const input = reviewInput();
        const h = reviewHarness(script);
        const result = await runModelAssistedReview(h.deps, input);
        assertSafeResult(result, input, before);
        expect(truthyKeys(result, /accept|approv/i)).toEqual([]);
        for (const finding of result.findings) {
          expect(finding.reviewState).toBe('pending');
          expect(finding.hybridStatus).not.toBe('DETERMINISTIC');
          expect(finding.hybridStatus).not.toBe('REJECTED');
        }
      },
    );

    it('reads the case and writes nothing to it: the review runs on frozen copies of the view and the analysis', async () => {
      const analysis = deepFreeze(structuredClone(one.analysis));
      const frozenView = deepFreeze(structuredClone(view));
      const h = reviewHarness(scripts[0]?.[1] ?? {});
      const result = await runModelAssistedReview(
        h.deps,
        reviewInput({ analysis, view: frozenView }),
      );
      expect(result.assistance).toMatchObject({ mode: 'ran', fallbackCount: 0 });
      expect(result.findings.length).toBeGreaterThan(0);
    });
  });
});
