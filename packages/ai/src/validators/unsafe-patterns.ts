export interface PatternRule {
  code: string;
  /** Global, so every occurrence is examined: a negated first match must not hide a later real one. */
  pattern: RegExp;
  message: string;
  /**
   * What a negation has to govern before a match stops being a recommendation.
   * - `verb`: the negation is the lead-in directly in front of the verb ("do not just wipe ...").
   * - `clause`: the match is a phrase that qualifies an action ("without approval", "rm -rf"), so a
   *   negation of the short clause it sits in is enough ("never act without approval").
   */
  negation: 'verb' | 'clause';
}

/**
 * Words that introduce a recommendation: the unsafe verb must be an instruction, not a description
 * of what someone did. The `lead` group is what precedes the verb itself.
 */
const LEAD = String.raw`(?<lead>^|[.;:!?,\n]\s*|\b(?:please|should|must|need(?:s)? to|recommend(?:ed)?(?: to)?|advise(?:d)?(?: to)?|go ahead and|just|simply|immediately|now|then|also|and|or|but|so|instead|otherwise|first|next|finally)\s+)`;

const DESTRUCTIVE_VERBS = 'delete|wipe|erase|purge|destroy|drop|truncate|reimage|factory[- ]reset';
const RESET_VERBS = 'reset|change|rotate|revoke|invalidate';
const WEAKEN_VERBS = 'disable|turn off|switch off|bypass|exclude|skip|remove|whitelist|allow-?list';
const GRANT_VERBS = 'grant|give|assign|elevate';
const SHARE_VERBS = 'share|send|post|paste|e-?mail';
const CLOSE_VERBS = 'close|closing|resolve';
const PEOPLE_VERBS =
  'discipline|fire|terminate|demote|reprimand|punish|dismiss|rank|rate|score|grade|compare';
const ALL_VERBS = [
  DESTRUCTIVE_VERBS,
  RESET_VERBS,
  WEAKEN_VERBS,
  GRANT_VERBS,
  SHARE_VERBS,
  CLOSE_VERBS,
  PEOPLE_VERBS,
].join('|');

const rule = (
  code: string,
  body: string,
  message: string,
  negation: PatternRule['negation'],
  flags = 'gim',
): PatternRule => ({ code, pattern: new RegExp(body, flags), message, negation });

/**
 * Wording that must never appear as a recommendation. Matching is deliberately limited to
 * recommendation fields and is a defence in depth: the structural check on action keys is primary.
 */
export const UNSAFE_RECOMMENDATION_RULES: readonly PatternRule[] = [
  rule(
    'destructive_data_operation',
    String.raw`${LEAD}(?:${DESTRUCTIVE_VERBS})\b[^.\n]{0,50}?\b(?:databases?|tables?|mailbox(?:es)?|tenants?|accounts?|profiles?|user data|data|logs?|backups?|volumes?|disks?|drives?|storage|directory|folders?|registry|devices?|machines?|servers?)\b`,
    'Recommends a destructive data or system operation.',
    'verb',
  ),
  rule(
    'destructive_command',
    String.raw`\brm\s+-rf\b|\bdel\s+/[fsq]\b|\bformat\s+[a-z]:|\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b|Remove-Item[^\n]*-Recurse`,
    'Contains a destructive command.',
    'clause',
    'gi',
  ),
  rule(
    'mass_credential_reset',
    String.raw`${LEAD}(?:${RESET_VERBS})\b[^.\n]{0,30}?\b(?:all|every|each|everyone'?s)\b[^.\n]{0,30}?\b(?:passwords?|credentials?|sessions?|tokens?|keys?)\b`,
    'Recommends resetting or revoking credentials or sessions for everyone.',
    'verb',
  ),
  rule(
    'weaken_security',
    String.raw`${LEAD}(?:${WEAKEN_VERBS})\b[^.\n]{0,50}?\b(?:mfa|multi-?factor|conditional access|2fa|antivirus|firewall|defender|security (?:policy|policies|controls?|inspection)|tls inspection|proxy inspection|audit(?:ing)? logs?|logging|encryption|authentication)\b`,
    'Recommends weakening a security control.',
    'verb',
  ),
  rule(
    'grant_privilege',
    String.raw`${LEAD}(?:${GRANT_VERBS})\b[^.\n]{0,40}?\b(?:global admin(?:istrator)?|domain admin|owner|full control|admin rights|administrator)\b`,
    'Recommends granting elevated privileges.',
    'verb',
  ),
  rule(
    'share_secret',
    String.raw`${LEAD}(?:${SHARE_VERBS})\b[^.\n]{0,40}?\b(?:password|credentials?|secret|api key|token|private key|connection string)\b`,
    'Recommends sharing a credential or secret.',
    'verb',
  ),
  rule(
    'auto_close_case',
    String.raw`\bauto(?:matically)?[- ]?(?:close|resolve)\b|${LEAD}(?:${CLOSE_VERBS})\b[^.\n]{0,15}?\b(?:the )?(?:case|ticket|incident)\b`,
    'Recommends closing the case; case closure is always a human decision.',
    'verb',
  ),
  rule(
    'approval_bypass',
    String.raw`\bwithout\s+(?:any\s+|prior\s+|further\s+|human\s+|manager\s+|customer\s+)*(?:approval|review|sign-?off|consent|confirmation)\b|\b(?:skip|bypass|waive)\s+(?:the\s+)?(?:approval|review|sign-?off)\b|\bno\s+approval\s+(?:is\s+)?(?:needed|required)\b`,
    'Recommends proceeding without approval or review.',
    'clause',
    'gi',
  ),
];

/** Wording about people that is never acceptable anywhere in an output (responsible-AI rules). */
export const PEOPLE_RULES: readonly PatternRule[] = [
  rule(
    'individual_discipline',
    String.raw`\b(?:should|must|ought to|deserves? to|needs? to)\s+be\s+(?:disciplined|fired|terminated|demoted|reprimanded|punished|penali[sz]ed|dismissed|sacked)\b|\b(?:discipline|fire|terminate|demote|reprimand|punish|dismiss)\s+(?:the\s+|this\s+)?(?:engineer|employee|agent|analyst|person|individual)\b`,
    'Suggests disciplinary action against an individual.',
    'verb',
    'gi',
  ),
  rule(
    'individual_ranking',
    String.raw`\b(?:rank|rate|score|grade|compare)\s+(?:the\s+|these\s+|all\s+)?(?:engineers?|employees?|agents?|analysts?|individuals?|people)\b|\b(?:worst|best|weakest|top|bottom)\s+(?:performing\s+)?(?:engineer|employee|agent|analyst)\b`,
    'Ranks or rates individuals.',
    'clause',
    'gi',
  ),
  rule(
    'personal_judgement',
    String.raw`\b(?:is|was|are|were|being)\s+(?:an?\s+)?(?:incompetent|lazy|unprofessional|negligent|careless|useless|stupid)\b`,
    'Passes personal judgement instead of describing the process.',
    'verb',
    'gi',
  ),
];

/** Phrases that negate what follows: a prohibition, or a statement that something is not advised. */
const NEGATOR = String.raw`(?:do(?:es)?\s+not|don'?t|doesn'?t|never|avoid|must\s+not|mustn'?t|should\s+not|shouldn'?t|cannot|can\s?not|can'?t|will\s+not|won'?t|would\s+not|wouldn'?t|need\s+not|needn'?t|no\s+need\s+to|not\s+to|(?:is|are|was|were)\s+not|isn'?t|aren'?t|wasn'?t|weren'?t|(?:does|do|did)\s+not\s+(?:mean|imply|suggest|indicate)(?:\s+that)?(?:\s+[a-z'-]+){0,3}|no\s+one|nobody|neither(?:\s+of\s+\w+)?|none\s+of\s+\w+)`;

/** Words that may sit between a negation and the verb it governs ("do not just wipe", "is not recommended to delete"). */
const GLUE = String.raw`(?:just|simply|ever|really|actually|even|immediately|now|then|also|please|kindly|go\s+ahead\s+and|try\s+to|attempt\s+to|need(?:s)?\s+to|have\s+to|has\s+to|want\s+to|to|should|must|may|might|can|could|would|will|ought\s+to|recommend(?:ed)?|advis(?:e|ed|able)|suggest(?:ed)?|necessary|required|needed|wise|safe|appropriate|permitted|allowed|acceptable|ok|okay|a\s+good\s+idea)`;

/**
 * The text in front of a verb ends in a negation (optionally followed by the words above and by
 * other unsafe verbs it also governs: "do not delete or wipe"). Anything else in between, such as
 * a comma, another clause or an unrelated "not", means the negation does not govern the verb.
 */
const NEGATED_LEAD_IN = new RegExp(
  String.raw`(?:^|[\s(])${NEGATOR}(?:\s+${GLUE})*\s*(?:\b(?:${ALL_VERBS})\b(?:\s*,\s*(?:(?:and|or|nor)\s+)?|\s+(?:and|or|nor)\s+))*$`,
  'i',
);

/** Verbal negations only: "is not DNS" is not a negation of the action that follows. */
const CLAUSE_NEGATOR = new RegExp(
  String.raw`\b(?:do(?:es)?\s+not|don'?t|doesn'?t|never|avoid|must\s+not|mustn'?t|should\s+not|shouldn'?t|cannot|can\s?not|can'?t|will\s+not|won'?t|would\s+not|wouldn'?t|need\s+not|needn'?t|no\s+need\s+to|not\s+to|(?:is|are|was|were)\s+not\s+(?:recommended|advisable|advised|wise|safe|appropriate|permitted|allowed|acceptable|ok|okay)(?:\s+to)?)\b`,
  'gi',
);
const CLAUSE_BREAK =
  /[,;:()]|\b(?:and|or|nor|but|however|although|though|while|whereas|because|since|so|then|if|when|unless|except|instead|otherwise)\b/i;
const MAX_CLAUSE_WORDS = 6;
const MAX_PREFIX_CHARS = 120;
const SENTENCE_END = /[.;:!?\n]/;

/** The words of the current sentence before `end` (bounded). */
function clausePrefix(text: string, end: number): string {
  const floor = Math.max(0, end - MAX_PREFIX_CHARS);
  let start = end;
  while (start > floor && !SENTENCE_END.test(text.charAt(start - 1))) start--;
  return text.slice(start, end);
}

/** A negated short clause ("never act without approval"): a negation, then a few unbroken words. */
function negatedClause(prefix: string): boolean {
  for (const match of prefix.matchAll(CLAUSE_NEGATOR)) {
    const rest = prefix.slice(match.index + match[0].length);
    const words = rest.split(/\s+/).filter((word) => word.length > 0).length;
    if (words <= MAX_CLAUSE_WORDS && !CLAUSE_BREAK.test(rest)) return true;
  }
  return false;
}

function isNegated(text: string, verbStart: number, kind: PatternRule['negation']): boolean {
  const prefix = clausePrefix(text, verbStart);
  return kind === 'verb' ? NEGATED_LEAD_IN.test(prefix) : negatedClause(prefix);
}

/**
 * Folds the spellings a plain pattern would miss: full-width and other compatibility forms,
 * zero-width and other format characters inside a word, markdown emphasis, runs of spaces.
 */
const normalizeForPolicy = (text: string): string =>
  text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[*`]+/g, '')
    .replace(/[^\S\n]+/g, ' ');

function hasUnnegatedMatch(
  text: string,
  candidate: PatternRule,
  respectNegation: boolean,
): boolean {
  const { pattern } = candidate;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (!respectNegation) return true;
    const verbStart = match.index + (match.groups?.lead?.length ?? 0);
    if (!isNegated(text, verbStart, candidate.negation)) return true;
    // Keep looking inside this match: a real verb may follow a negated one in the same stretch.
    pattern.lastIndex = verbStart + 1;
  }
  return false;
}

/**
 * Returns every rule that matches `text` outside a negated context. Every occurrence is examined,
 * and a negation only counts when it is the lead-in directly governing the verb (or, for phrases,
 * negates the short clause they sit in); an unrelated "not" or "no" earlier in the sentence does not.
 */
export function findViolations(
  text: string,
  rules: readonly PatternRule[],
  respectNegation: boolean,
): PatternRule[] {
  const normalized = normalizeForPolicy(text);
  return rules.filter((candidate) => hasUnnegatedMatch(normalized, candidate, respectNegation));
}
