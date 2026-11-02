import type { ProvenanceItem, ProvenanceResponse } from '@caseguard/schemas';
import { describe, expect, it } from 'vitest';
import { PROVENANCE_ONE } from '../../../../test/review-fixtures';
import {
  UNRESOLVED_WORDS,
  describeItem,
  linkLabel,
  orderItems,
  titlesByKey,
} from './provenance-view';

const [verified, , eventItem] = PROVENANCE_ONE.items as [
  ProvenanceItem,
  ProvenanceItem,
  ProvenanceItem,
  ProvenanceItem,
];

const withSource = (
  item: ProvenanceItem,
  patch: Partial<NonNullable<ProvenanceItem['source']>>,
): ProvenanceItem => ({
  ...item,
  source: { ...(item.source as NonNullable<ProvenanceItem['source']>), ...patch },
});

describe('[REV-EVID-01] what the drawer shows for an item', () => {
  it('shows the verified passage with the matched part apart, who wrote it and when', () => {
    const view = describeItem(verified);
    expect(view.body).toMatchObject({
      kind: 'quote',
      match: 'Root cause is',
      beforeCut: false,
      afterCut: false,
    });
    expect(view.body.kind === 'quote' && view.body.before).toMatch(
      /^Findings: the sign-in logs show/,
    );
    expect(view.byline).toBe('Support engineer · 9 Mar 2026, 12:10 UTC');
    expect(view.fromTitle).toBe('Findings from sign-in logs');
    expect(view.eventId).toBe('e07');
    expect(view.typeWord).toBe('Statement');
    expect(view.details).toContainEqual({ label: 'Position in that text', value: '105 to 118' });
    expect(view.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never presents an excerpt that could not be matched as a quotation, and keeps it for "Details" only', () => {
    const view = describeItem(withSource(verified, { verification: 'mismatch', context: null }));
    expect(view.body).toEqual({ kind: 'mismatch' });
    expect(view.recordedExcerpt).toMatch(/Root cause is the Conditional Access policy/);
  });

  it('shows only the title of a derived item, and claims nothing about its excerpt', () => {
    const view = describeItem(
      withSource(verified, { verification: 'not_checkable', context: null }),
    );
    expect(view.body).toEqual({ kind: 'derived' });
  });

  it('does not treat a "verified" answer that carries no passage as a quotation', () => {
    const view = describeItem(withSource(verified, { verification: 'verified', context: null }));
    expect(view.body).toEqual({ kind: 'derived' });
  });

  it('has nothing to quote for text without a recorded source, or for a kind of item that has no text', () => {
    expect(describeItem({ ...verified, source: null }).body).toEqual({ kind: 'derived' });
    expect(describeItem(eventItem).body).toEqual({ kind: 'none' });
    expect(describeItem(eventItem).eventId).toBe('e07');
    const fork = describeItem({
      link: { type: 'fork', id: 'fork_1' },
      title: 'Disruptive change made before the cause was established',
      at: '2026-03-09T12:25:00Z',
      event: null,
      source: null,
    });
    expect(fork.body).toEqual({ kind: 'none' });
    expect(fork.eventId).toBeNull();
    expect(fork.typeWord).toBe('Decision point');
  });

  it('marks a passage that was probably cut at the limit of the context', () => {
    const long = withSource(verified, {
      context: { before: 'x'.repeat(400), match: 'm', after: 'y'.repeat(399) },
    });
    expect(describeItem(long).body).toMatchObject({ beforeCut: true, afterCut: false });
  });

  it('labels a link with its own label, then the title resolved for it, then its kind and a short id', () => {
    const titles = new Map([['evidence:evd_1', 'Client reports a failure']]);
    expect(linkLabel({ type: 'evidence', id: 'evd_1', label: 'Own label' }, titles)).toBe(
      'Own label',
    );
    expect(linkLabel({ type: 'evidence', id: 'evd_1' }, titles)).toBe('Client reports a failure');
    expect(linkLabel({ type: 'evidence', id: 'evd_0123456789abcdef' })).toBe(
      'Evidence evd_01234567…',
    );
    expect(linkLabel({ type: 'fork', id: 'f1' })).toBe('Decision point f1');
  });

  it('puts the item that was asked about first and keeps the order of the rest', () => {
    const keys = (items: ProvenanceItem[]): string[] =>
      items.map((i) => `${i.link.type}:${i.link.id}`);
    expect(keys(orderItems(PROVENANCE_ONE.items, 'event:e08'))[0]).toBe('event:e08');
    expect(keys(orderItems(PROVENANCE_ONE.items, null))).toEqual(keys([...PROVENANCE_ONE.items]));
    expect(keys(orderItems(PROVENANCE_ONE.items, 'event:nope'))).toEqual(
      keys([...PROVENANCE_ONE.items]),
    );
  });

  it('collects the titles of what was resolved and explains what could not be', () => {
    const response: ProvenanceResponse = {
      ...PROVENANCE_ONE,
      items: PROVENANCE_ONE.items.slice(2),
    };
    expect(titlesByKey(response).get('event:e07')).toBe('Findings from sign-in logs');
    expect(titlesByKey(undefined).size).toBe(0);
    expect(UNRESOLVED_WORDS.not_found).toMatch(/not in the case/);
    expect(UNRESOLVED_WORDS.not_yet_known).toMatch(/after the moment/);
  });
});
