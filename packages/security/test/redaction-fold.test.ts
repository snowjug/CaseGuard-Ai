import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { foldForDetection } from '../src/redaction/fold';
import { Rewriter, mergeEdits } from '../src/redaction/rewriter';

const cp = (...points: number[]): string => String.fromCodePoint(...points);
const view = (text: string): string => foldForDetection(text)?.text ?? text;
const EMOJI = cp(0x1f600);
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe('foldForDetection: the view the rules read (H1)', { timeout: 60_000 }, () => {
  it('needs no view for plain text and for non-ASCII text that is already in detection form', () => {
    for (const text of ['', 'password: x', 'a\tb\r\nc', `caf\u00e9 \u65e5\u672c\u8a9e ${EMOJI}`]) {
      expect(foldForDetection(text)).toBeNull();
    }
    expect(foldForDetection('e\u0301')).toBeNull();
  });

  it.each([
    ['no-break space', cp(0xa0)],
    ['ogham space mark', cp(0x1680)],
    ['en quad to hair space', cp(0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006)],
    ['figure space', cp(0x2007)],
    ['punctuation, thin and hair space', cp(0x2008, 0x2009, 0x200a)],
    ['narrow no-break space', cp(0x202f)],
    ['medium mathematical space', cp(0x205f)],
    ['ideographic space', cp(0x3000)],
    ['braille blank', cp(0x2800)],
  ])('turns %s into plain spaces', (_name, spaces) => {
    expect(view(`a${spaces}b`)).toBe(`a${' '.repeat(spaces.length)}b`);
  });

  it('turns line and paragraph separators and NEL into newlines', () => {
    expect(view(`a${cp(0x2028)}b${cp(0x2029)}c${cp(0x85)}d`)).toBe('a\nb\nc\nd');
  });

  it('maps full-width and other compatibility characters to ASCII one for one', () => {
    expect(view('\uff30\uff21\uff33\uff33\uff1a\uff11\uff12\uff1d\uff20\uff0e')).toBe('PASS:12=@.');
    expect(view('\uff02\uff07')).toBe('"\'');
    expect(view(`${cp(0x1d429)}${cp(0x1d41a)}ss`)).toBe('pass'); // mathematical bold letters (astral)
    expect(view('\u2460\u00b2')).toBe('12'); // circled one, superscript two
  });

  it.each([
    ['zero-width space', 0x200b],
    ['zero-width non-joiner', 0x200c],
    ['zero-width joiner', 0x200d],
    ['left-to-right mark', 0x200e],
    ['right-to-left mark', 0x200f],
    ['right-to-left override', 0x202e],
    ['pop directional formatting', 0x202c],
    ['word joiner', 0x2060],
    ['left-to-right isolate', 0x2066],
    ['pop directional isolate', 0x2069],
    ['byte order mark', 0xfeff],
    ['soft hyphen', 0xad],
    ['combining grapheme joiner', 0x034f],
    ['variation selector 16', 0xfe0f],
    ['Arabic letter mark', 0x061c],
    ['language tag letter', 0xe0041],
    ['Hangul filler', 0x3164],
    ['NUL', 0x00],
    ['bell', 0x07],
    ['escape', 0x1b],
    ['vertical tab', 0x0b],
    ['form feed', 0x0c],
    ['delete', 0x7f],
    ['C1 control', 0x9f],
  ])('removes %s', (_name, point) => {
    expect(view(`pass${cp(point)}word`)).toBe('password');
  });

  it('does not guess at look-alikes, combining marks or expansions', () => {
    const kept = ['p\u0430ssword', 'e\u0301', '\ufb01nal', 'wait\u2026', 'a\u2122', '\u00bd'];
    for (const text of kept) expect(view(text)).toBe(text);
  });

  it('maps every folded character back to the character that produced it', () => {
    const source = `a${cp(0xa0)}${cp(0x200b)}b${cp(0x1d429)}${EMOJI}${cp(0xff1a)}c`;
    const folded = foldForDetection(source);
    expect(folded?.text).toBe(`a bp${EMOJI}:c`);
    // a, nbsp, (zwsp removed), b, mathematical p (2 units), emoji (2 units), full-width colon, c
    expect(Array.from(folded?.starts ?? [])).toEqual([0, 1, 3, 4, 6, 6, 8, 9, 10]);
  });

  it('is a fixed point and keeps the map sorted, for arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (text) => {
        const folded = foldForDetection(text);
        if (folded === null) return true;
        const starts = Array.from(folded.starts);
        const sorted = starts.every((value, i) => i === 0 || (starts[i - 1] ?? 0) <= value);
        return (
          sorted &&
          starts.length === folded.text.length + 1 &&
          starts[starts.length - 1] === text.length &&
          foldForDetection(folded.text) === null
        );
      }),
      { numRuns: 400 },
    );
  });

  it('stays linear on a large hostile input', () => {
    const text = `${'\u200b'.repeat(500_000)}${'\u00a0'.repeat(300_000)}${'a\u200bb'.repeat(100_000)}`;
    const started = performance.now();
    const folded = foldForDetection(text);
    expect(folded?.text.length).toBe(300_000 + 200_000);
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

describe('Rewriter: replacements land on the original text', () => {
  function rewrite(source: string, pattern: RegExp, replacement: string, afterPrefix = false) {
    const doc = new Rewriter(source);
    if (afterPrefix) {
      doc.replaceAfterPrefix(
        pattern,
        (_match: string, prefix: string) => `${prefix}${replacement}`,
      );
    } else {
      doc.replace(pattern, () => replacement);
    }
    return doc.finish();
  }

  it('keeps invisible characters and original spacing around a redacted span', () => {
    const source = `${cp(0x200b)}pass${cp(0x200b)}word:${cp(0xa0)}hunter2${cp(0x200d)} tail`;
    expect(rewrite(source, /(password: )(\S+)/g, '[X]', true)).toBe(
      `${cp(0x200b)}pass${cp(0x200b)}word:${cp(0xa0)}[X]${cp(0x200d)} tail`,
    );
  });

  it('replaces invisible characters that sit inside the redacted span', () => {
    const source = `a ${cp(0xad)}sk-ab${cp(0x200b)}cd${cp(0x2060)}ef ${cp(0xfeff)}z`;
    expect(rewrite(source, /sk-\w+/g, '[K]')).toBe(`a ${cp(0xad)}[K] ${cp(0xfeff)}z`);
  });

  it('is the identity when nothing was replaced', () => {
    const source = `a${cp(0xa0)}b${cp(0x200b)}c`;
    expect(new Rewriter(source).finish()).toBe(source);
    expect(rewrite(source, /nomatch/g, '[X]')).toBe(source);
  });

  it('never splits a surrogate pair at either end of a span', () => {
    const source = `${EMOJI}${cp(0xa0)}secret${EMOJI}`; // units: 0-1 emoji, 2 space, 3-8 secret, 9-10 emoji
    const starting = new Rewriter(source);
    starting.replaceSpans([1, 5], '[X]'); // begins between the halves of the first emoji
    expect(starting.finish()).toBe(`[X]ret${EMOJI}`);

    const ending = new Rewriter(source);
    ending.replaceSpans([8, 2], '[X]'); // ends between the halves of the last emoji
    expect(ending.finish()).toBe(`${EMOJI}${cp(0xa0)}secre[X]`);
    expect(LONE_SURROGATE.test(starting.finish() + ending.finish())).toBe(false);
  });

  it('reports whether it tracks anything', () => {
    expect(new Rewriter('plain').tracked).toBe(false);
    expect(new Rewriter(`a${cp(0xa0)}b`).tracked).toBe(true);
    expect(new Rewriter('plain', { forceTracking: true }).tracked).toBe(true);
  });
});

/**
 * Reference model: one cell per working-text character. A kept character stands for its own folded
 * index, an inserted one for the folded interval of everything it replaced. It shares no code with
 * `mergeEdits`, so agreement between the two is meaningful.
 */
type Cell =
  | { readonly kind: 'keep'; readonly at: number }
  | { readonly kind: 'new'; readonly lo: number; readonly hi: number };

class Model {
  cells: Cell[];

  constructor(length: number) {
    this.cells = Array.from({ length }, (_, at): Cell => ({ kind: 'keep', at }));
  }

  replace(spans: [number, number][], length: number): void {
    const next: Cell[] = [];
    let cursor = 0;
    for (const [start, end] of spans) {
      next.push(...this.cells.slice(cursor, start));
      let lo = Infinity;
      let hi = -Infinity;
      for (const cell of this.cells.slice(start, end)) {
        lo = Math.min(lo, cell.kind === 'keep' ? cell.at : cell.lo);
        hi = Math.max(hi, cell.kind === 'keep' ? cell.at + 1 : cell.hi);
      }
      for (let i = 0; i < length; i += 1) next.push({ kind: 'new', lo, hi });
      cursor = end;
    }
    next.push(...this.cells.slice(cursor));
    this.cells = next;
  }

  /** Runs of replacement characters; neighbouring cells whose folded intervals overlap are one region. */
  regions(): number[] {
    const out: number[] = [];
    let i = 0;
    while (i < this.cells.length) {
      const first = this.cells[i];
      if (first?.kind !== 'new') {
        i += 1;
        continue;
      }
      let lo = first.lo;
      let hi = first.hi;
      const start = i;
      let end = i + 1;
      for (; end < this.cells.length; end += 1) {
        const next = this.cells[end];
        if (next?.kind !== 'new' || !(next.lo < hi && next.hi > lo)) break;
        lo = Math.min(lo, next.lo);
        hi = Math.max(hi, next.hi);
      }
      out.push(start, end, lo, hi);
      i = end;
    }
    return out;
  }
}

describe(
  'mergeEdits: region bookkeeping agrees with a per-character model',
  { timeout: 60_000 },
  () => {
    const alphabet = [
      'a',
      'b',
      'c',
      ' ',
      cp(0xa0),
      cp(0x200b),
      cp(0xff1a),
      '\u00e9',
      '\u65e5',
      EMOJI,
      'x',
    ];
    const sources = fc
      .array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 30 })
      .map((parts) => parts.join(''));
    const operation = fc.record({
      seeds: fc.array(fc.nat(1000), { minLength: 1, maxLength: 5 }),
      widths: fc.array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 5 }),
      length: fc.integer({ min: 1, max: 9 }),
    });

    /** Picks disjoint, ascending spans that do not cut a surrogate pair. */
    function pickSpans(text: string, seeds: number[], widths: number[]): [number, number][] {
      const splits = (index: number): boolean => {
        const before = text.charCodeAt(index - 1);
        const after = text.charCodeAt(index);
        return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
      };
      const spans: [number, number][] = [];
      let cursor = 0;
      seeds.forEach((seed, k) => {
        if (cursor >= text.length) return;
        let start = cursor + (seed % Math.max(1, text.length - cursor));
        while (start < text.length && splits(start)) start += 1;
        let end = Math.min(text.length, start + (widths[k % widths.length] ?? 1));
        while (end < text.length && splits(end)) end += 1;
        if (start >= end || start >= text.length) return;
        spans.push([start, end]);
        cursor = end;
      });
      return spans;
    }

    it('matches the model across random edit scripts, including absorbed and touching edits', () => {
      fc.assert(
        fc.property(
          sources,
          fc.array(operation, { minLength: 1, maxLength: 5 }),
          (source, operations) => {
            const doc = new Rewriter(source, { forceTracking: true });
            const model = new Model(doc.text.length);
            for (const op of operations) {
              const spans = pickSpans(doc.text, op.seeds, op.widths);
              if (spans.length === 0) continue;
              doc.replaceSpans(
                spans.flatMap(([start, end]) => [start, end - start]),
                'R'.repeat(op.length),
              );
              model.replace(spans, op.length);
            }
            const regions = (doc as unknown as { regions: number[] }).regions;
            const out = doc.finish();
            // The region list is the model's, and what finish() writes reads, through the detection
            // view, exactly like the working text the rules saw.
            return (
              model.cells.length === doc.text.length &&
              JSON.stringify(regions) === JSON.stringify(model.regions()) &&
              view(out) === doc.text &&
              !LONE_SURROGATE.test(out)
            );
          },
        ),
        { numRuns: 1500 },
      );
    });

    it('keeps edits that merely touch as separate regions and merges what overlaps a region', () => {
      // two touching edits
      expect(mergeEdits([], [0, 3], [3, 5], [4, 4])).toEqual([0, 4, 0, 3, 4, 8, 3, 5]);
      // two edits around one existing region absorb it into a single region
      expect(mergeEdits([2, 8, 2, 5], [0, 7], [3, 10], [2, 2])).toEqual([0, 8, 0, 7]);
      // an edit inside an existing region absorbs it and keeps its folded range
      expect(mergeEdits([2, 7, 2, 4], [4], [5], [3])).toEqual([2, 9, 2, 4]);
      // an edit that reaches into a region from the left extends the folded range over both
      expect(mergeEdits([4, 8, 4, 6], [2], [6], [1])).toEqual([2, 5, 2, 6]);
      // regions after an edit shift by its net length change, folded ranges stay
      expect(mergeEdits([8, 12, 8, 10], [0], [2], [5])).toEqual([0, 5, 0, 2, 11, 15, 8, 10]);
    });
  },
);
