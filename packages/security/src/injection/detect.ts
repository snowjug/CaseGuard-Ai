import type { InjectionFinding, InjectionSummary } from '@caseguard/schemas';
import { redactText } from '../redaction/redact-text';
import { countHiddenCharacters, stripHiddenCharacters, visualizeHiddenCharacters } from './hidden';
import {
  DECODE_AND_FOLLOW,
  ENCODED_BLOB,
  INJECTION_RULES,
  type InjectionRule,
  type InjectionSeverity,
} from './rules';

export interface DetectInjectionOptions {
  /** Event the text came from; recorded on every finding (null for pasted or uploaded text). */
  eventId?: string | null;
}

/** Text beyond this offset is not examined; ingestion limits (1-2 MiB) keep real inputs far below it. */
const MAX_SCAN_CHARS = 4_000_000;
const MAX_PER_RULE = 3;
const MAX_FINDINGS = 25;
const MAX_EXCERPT = 200;
const SEVERITY_RANK: Record<InjectionSeverity, number> = { low: 1, medium: 2, high: 3 };

interface Candidate {
  readonly ruleId: string;
  readonly severity: InjectionSeverity;
  readonly explanation: string;
  readonly start: number;
  readonly end: number;
  readonly order: number;
  /** Text the excerpt is cut from (the normalised text, or the raw text for hidden characters). */
  readonly source: string;
  readonly visualize?: boolean;
}

/** Short, single-line, secret-free window around a match, safe to store and show to reviewers. */
function excerptAround(source: string, start: number, end: number, visualize = false): string {
  const from = Math.max(0, start - 40);
  const to = Math.min(source.length, end + 80);
  let slice = source.slice(from, to);
  if (visualize) slice = visualizeHiddenCharacters(slice);
  else slice = stripHiddenCharacters(slice);
  slice = redactText(slice.replace(/\s+/g, ' ').trim()).text;
  let excerpt = `${from > 0 ? '\u2026' : ''}${slice}${to < source.length ? '\u2026' : ''}`;
  if (excerpt.length > MAX_EXCERPT) excerpt = `${excerpt.slice(0, MAX_EXCERPT - 1)}\u2026`;
  return excerpt;
}

function matchesOf(rule: InjectionRule, text: string, order: number): Candidate[] {
  const found: Candidate[] = [];
  rule.pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = rule.pattern.exec(text)) !== null) {
    if (match[0].length === 0) {
      rule.pattern.lastIndex += 1;
      continue;
    }
    const severity =
      typeof rule.severity === 'function'
        ? rule.severity(match[0], text, match.index)
        : rule.severity;
    if (severity !== null) {
      found.push({
        ruleId: rule.id,
        severity,
        explanation: rule.explanation,
        start: match.index,
        end: match.index + match[0].length,
        order,
        source: text,
      });
    }
    if (found.length >= MAX_PER_RULE * 4) break;
  }
  return found;
}

function hiddenCharacterCandidates(raw: string): Candidate[] {
  const counts = countHiddenCharacters(raw);
  const out: Candidate[] = [];
  const add = (severity: InjectionSeverity, index: number, explanation: string): void => {
    out.push({
      ruleId: 'hidden_unicode',
      severity,
      explanation,
      start: index,
      end: index + 1,
      order: -1,
      source: raw,
      visualize: true,
    });
  };
  if (counts.tagCharacters > 0) {
    add(
      'high',
      counts.firstIndex.tagCharacters,
      `Contains ${counts.tagCharacters} Unicode tag character(s): invisible text that a model can read but a person cannot (ASCII smuggling).`,
    );
  }
  if (counts.bidiControls > 0) {
    add(
      'medium',
      counts.firstIndex.bidiControls,
      `Contains ${counts.bidiControls} bidirectional control character(s) that can make the displayed text differ from what is processed.`,
    );
  }
  if (counts.zeroWidth > 0) {
    add(
      counts.zeroWidth >= 3 ? 'medium' : 'low',
      counts.firstIndex.zeroWidth,
      `Contains ${counts.zeroWidth} zero-width or invisible character(s), which can hide or split keywords.`,
    );
  }
  return out;
}

function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let printable = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 0x20 && code < 0x7f) || code === 0x0a || code === 0x0d || code === 0x09)
      printable += 1;
  }
  return printable / text.length;
}

function decodeBlob(blob: string): string | null {
  const isHex = /^(?:[0-9a-fA-F]{2})+$/.test(blob);
  const bytes = Buffer.from(blob.slice(0, 4096), isHex ? 'hex' : 'base64');
  const decoded = bytes.toString('utf8');
  return printableRatio(decoded) >= 0.9 ? decoded : null;
}

/** "Decode this and follow it" next to a long encoded run; high when the payload itself is hostile. */
function encodedInstructionCandidates(text: string): Candidate[] {
  DECODE_AND_FOLLOW.lastIndex = 0;
  const cue = DECODE_AND_FOLLOW.exec(text);
  if (cue === null) return [];
  const blobs = [...text.matchAll(ENCODED_BLOB)].slice(0, 3).map((match) => match[0]);
  if (blobs.length === 0) return [];

  let severity: InjectionSeverity = 'medium';
  let explanation =
    'Asks the reader to decode a long encoded block and follow it, a way to smuggle instructions past text filters.';
  for (const blob of blobs) {
    const decoded = decodeBlob(blob);
    if (decoded === null) continue;
    const hostile = INJECTION_RULES.some((rule, order) =>
      matchesOf(rule, stripHiddenCharacters(decoded).normalize('NFKC'), order).some(
        (candidate) => candidate.severity === 'high',
      ),
    );
    if (hostile) {
      severity = 'high';
      explanation =
        'Asks the reader to decode an encoded block and follow it, and the decoded text itself contains injection instructions.';
      break;
    }
  }
  return [
    {
      ruleId: 'encoded_instruction',
      severity,
      explanation,
      start: cue.index,
      end: cue.index + cue[0].length,
      order: INJECTION_RULES.length,
      source: text,
    },
  ];
}

/**
 * Flags text that tries to give instructions to the model that reads it. Returns findings sorted by
 * severity (high first), at most three per rule and 25 in total; every excerpt is short and redacted.
 * An empty array means "nothing recognised", not "safe".
 */
export function detectPromptInjection(
  text: string,
  options: DetectInjectionOptions = {},
): InjectionFinding[] {
  const eventId = options.eventId ?? null;
  const raw = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  if (raw.length === 0) return [];

  // Strip first so "ig\u200Bnore" cannot split a keyword, then fold look-alike forms (full-width etc.).
  const normalized = stripHiddenCharacters(raw).normalize('NFKC');

  const candidates: Candidate[] = [...hiddenCharacterCandidates(raw)];
  INJECTION_RULES.forEach((rule, order) => candidates.push(...matchesOf(rule, normalized, order)));
  candidates.push(...encodedInstructionCandidates(normalized));

  candidates.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.order - b.order ||
      a.start - b.start,
  );

  const perRule = new Map<string, number>();
  const seen = new Set<string>();
  const findings: InjectionFinding[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.ruleId}:${candidate.start}`;
    const used = perRule.get(candidate.ruleId) ?? 0;
    if (seen.has(key) || used >= MAX_PER_RULE) continue;
    seen.add(key);
    perRule.set(candidate.ruleId, used + 1);
    findings.push({
      ruleId: candidate.ruleId,
      severity: candidate.severity,
      eventId,
      excerpt: excerptAround(candidate.source, candidate.start, candidate.end, candidate.visualize),
      explanation: candidate.explanation.slice(0, 300),
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

/** Rolls findings up for the ingestion preview: detected flag, highest severity, at most 100 findings. */
export function summarizeInjection(findings: readonly InjectionFinding[]): InjectionSummary {
  let highest: InjectionSummary['highestSeverity'] = 'none';
  for (const finding of findings) {
    if (highest === 'none' || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest]) {
      highest = finding.severity;
    }
  }
  const ordered = [...findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  return {
    detected: findings.length > 0,
    highestSeverity: highest,
    findings: ordered.slice(0, 100),
  };
}
