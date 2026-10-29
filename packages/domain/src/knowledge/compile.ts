import {
  KnowledgePackSchema,
  validateKnowledgePackReferences,
  type KnowledgeAction,
  type KnowledgeHypothesis,
  type KnowledgePack,
  type KnowledgeRequirement,
  type KnowledgeSignal,
  type SignalDetector,
} from '@caseguard/schemas';

export interface CompiledDetector {
  detector: SignalDetector;
  regex: RegExp | null;
}

/**
 * A knowledge pack with every regular expression compiled once, plus id lookups. Compilation also
 * validates the pack (schema + cross references) so a broken pack fails fast at load time.
 */
export interface CompiledPack {
  pack: KnowledgePack;
  hypothesisIds: readonly string[];
  hypotheses: ReadonlyMap<string, KnowledgeHypothesis>;
  signals: ReadonlyMap<string, KnowledgeSignal>;
  actions: ReadonlyMap<string, KnowledgeAction>;
  requirements: ReadonlyMap<string, KnowledgeRequirement>;
  signalDetectors: ReadonlyMap<string, readonly CompiledDetector[]>;
  actionDetectors: ReadonlyMap<string, readonly CompiledDetector[]>;
  requirementDetectors: ReadonlyMap<string, readonly CompiledDetector[]>;
  lexicon: {
    hedges: readonly RegExp[];
    definitive: readonly RegExp[];
    template: readonly RegExp[];
    workaround: readonly RegExp[];
    permanentFix: readonly RegExp[];
    validation: readonly RegExp[];
    nextSteps: readonly RegExp[];
    expectation: readonly RegExp[];
    closure: readonly RegExp[];
    customerReport: readonly RegExp[];
  };
  claimPatterns: readonly {
    id: string;
    subject: string;
    label: string;
    valueGroup: number;
    regex: RegExp;
    roles: readonly string[] | undefined;
    eventTypes: readonly string[] | undefined;
  }[];
  /**
   * Word-start regex for every hypothesis keyword, in keyword order, built once instead of per
   * sentence. They carry the `g` flag so hits can be counted with `String.prototype.match`, which
   * resets `lastIndex` itself; never call `test` or `exec` on them.
   */
  keywordPatterns: ReadonlyMap<string, readonly RegExp[]>;
  /**
   * One alternation per cue group, equivalent to testing every entry of the same `lexicon` group
   * (null when the group is empty). Lets a sentence be classified with one scan per group.
   */
  lexiconAny: {
    hedges: RegExp | null;
    definitive: RegExp | null;
    template: RegExp | null;
  };
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lexicon entries are word-prefix cues: "assum" matches "assumed", "assuming" and "assumption". */
function phrase(text: string): RegExp {
  return new RegExp(`(?<![\\w])${escapeRegex(text)}`, 'i');
}

/** The same cues as `phrase`, as one expression that matches when any of them does. */
function anyPhrase(texts: readonly string[]): RegExp | null {
  if (texts.length === 0) return null;
  return new RegExp(`(?<![\\w])(?:${texts.map(escapeRegex).join('|')})`, 'i');
}

/** Counts a keyword at word starts; short keywords must also end at a word boundary. */
function keywordPattern(keyword: string): RegExp {
  const needle = keyword.toLowerCase();
  const tail = needle.length <= 4 ? '(?![\\w])' : '';
  return new RegExp(`(?<![\\w])${escapeRegex(needle)}${tail}`, 'g');
}

/**
 * Compiles an authored pattern. The `g` and `y` flags are rejected: the compiled expression is shared
 * by every analysis, and those flags make `test`/`exec` depend on `lastIndex` left by the previous call.
 */
function compileAuthored(kind: string, pattern: string, flags: string): RegExp {
  if (/[gy]/.test(flags)) {
    throw new Error(
      `Invalid ${kind} pattern /${pattern}/: the "g" and "y" flags keep state between matches and are not allowed (flags: "${flags}").`,
    );
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(
      `Invalid ${kind} pattern /${pattern}/: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

function compileDetectors(list: readonly SignalDetector[]): CompiledDetector[] {
  return list.map((detector) =>
    detector.kind === 'regex'
      ? { detector, regex: compileAuthored('detector', detector.pattern, detector.flags) }
      : { detector, regex: null },
  );
}

export function compileKnowledgePack(input: KnowledgePack): CompiledPack {
  const pack = KnowledgePackSchema.parse(input);
  const problems = validateKnowledgePackReferences(pack);
  if (problems.length > 0) {
    throw new Error(`Knowledge pack ${pack.id} is inconsistent:\n- ${problems.join('\n- ')}`);
  }
  const lexicon = pack.lexicon;
  return {
    pack,
    hypothesisIds: pack.hypotheses.map((h) => h.id),
    hypotheses: new Map(pack.hypotheses.map((h) => [h.id, h])),
    signals: new Map(pack.signals.map((s) => [s.id, s])),
    actions: new Map(pack.actions.map((a) => [a.id, a])),
    requirements: new Map(pack.requirements.map((r) => [r.id, r])),
    signalDetectors: new Map(pack.signals.map((s) => [s.id, compileDetectors(s.detectors)])),
    actionDetectors: new Map(pack.actions.map((a) => [a.id, compileDetectors(a.detectors)])),
    requirementDetectors: new Map(
      pack.requirements.map((r) => [r.id, compileDetectors(r.satisfiedByDetectors)]),
    ),
    lexicon: {
      hedges: lexicon.hedges.map(phrase),
      definitive: lexicon.definitive.map(phrase),
      template: lexicon.template.map(phrase),
      workaround: lexicon.workaround.map(phrase),
      permanentFix: lexicon.permanentFix.map(phrase),
      validation: lexicon.validation.map(phrase),
      nextSteps: lexicon.nextSteps.map(phrase),
      expectation: lexicon.expectation.map(phrase),
      closure: lexicon.closure.map(phrase),
      customerReport: lexicon.customerReport.map(phrase),
    },
    claimPatterns: pack.claimPatterns.map((c) => ({
      id: c.id,
      subject: c.subject,
      label: c.label,
      valueGroup: c.valueGroup,
      regex: compileAuthored('claim', c.pattern, c.flags),
      roles: c.roles,
      eventTypes: c.eventTypes,
    })),
    keywordPatterns: new Map(pack.hypotheses.map((h) => [h.id, h.keywords.map(keywordPattern)])),
    lexiconAny: {
      hedges: anyPhrase(lexicon.hedges),
      definitive: anyPhrase(lexicon.definitive),
      template: anyPhrase(lexicon.template),
    },
  };
}
