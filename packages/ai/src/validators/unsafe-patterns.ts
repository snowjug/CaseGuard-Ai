export interface PatternRule {
  code: string;
  pattern: RegExp;
  message: string;
}

/** Words that introduce a recommendation: the unsafe verb must be an instruction, not a description. */
const LEAD = String.raw`(?:^|[.;:!?\n]\s*|\b(?:please|should|must|need(?:s)? to|recommend(?:ed)?(?: to)?|advise(?:d)?(?: to)?|go ahead and|just|simply|immediately|now|then|also|and|or)\s+)`;

const rule = (code: string, body: string, message: string, flags = 'im'): PatternRule => ({
  code,
  pattern: new RegExp(body, flags),
  message,
});

/**
 * Wording that must never appear as a recommendation. Matching is deliberately limited to
 * recommendation fields and is a defence in depth: the structural check on action keys is primary.
 */
export const UNSAFE_RECOMMENDATION_RULES: readonly PatternRule[] = [
  rule(
    'destructive_data_operation',
    `${LEAD}(?:delete|wipe|erase|purge|destroy|drop|truncate|reimage|factory[- ]reset)\\b[^.\\n]{0,50}\\b(?:databases?|tables?|mailbox(?:es)?|tenants?|accounts?|profiles?|user data|data|logs?|backups?|volumes?|disks?|drives?|storage|directory|folders?|registry|devices?|machines?|servers?)\\b`,
    'Recommends a destructive data or system operation.',
  ),
  rule(
    'destructive_command',
    String.raw`\brm\s+-rf\b|\bdel\s+/[fsq]\b|\bformat\s+[a-z]:|\bDROP\s+(?:TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b|Remove-Item[^\n]*-Recurse`,
    'Contains a destructive command.',
    'i',
  ),
  rule(
    'mass_credential_reset',
    `${LEAD}(?:reset|change|rotate|revoke|invalidate)\\b[^.\\n]{0,30}\\b(?:all|every|each|everyone'?s)\\b[^.\\n]{0,30}\\b(?:passwords?|credentials?|sessions?|tokens?|keys?)\\b`,
    'Recommends resetting or revoking credentials or sessions for everyone.',
  ),
  rule(
    'weaken_security',
    `${LEAD}(?:disable|turn off|switch off|bypass|exclude|skip|remove|whitelist|allow-?list)\\b[^.\\n]{0,50}\\b(?:mfa|multi-?factor|conditional access|2fa|antivirus|firewall|defender|security (?:policy|policies|controls?|inspection)|tls inspection|proxy inspection|audit(?:ing)? logs?|logging|encryption|authentication)\\b`,
    'Recommends weakening a security control.',
  ),
  rule(
    'grant_privilege',
    `${LEAD}(?:grant|give|assign|elevate)\\b[^.\\n]{0,40}\\b(?:global admin(?:istrator)?|domain admin|owner|full control|admin rights|administrator)\\b`,
    'Recommends granting elevated privileges.',
  ),
  rule(
    'share_secret',
    `${LEAD}(?:share|send|post|paste|e-?mail)\\b[^.\\n]{0,40}\\b(?:password|credentials?|secret|api key|token|private key|connection string)\\b`,
    'Recommends sharing a credential or secret.',
  ),
  rule(
    'auto_close_case',
    `\\bauto(?:matically)?[- ]?(?:close|resolve)\\b|${LEAD}(?:close|closing|resolve)\\b[^.\\n]{0,15}\\b(?:the )?(?:case|ticket|incident)\\b`,
    'Recommends closing the case; case closure is always a human decision.',
  ),
  rule(
    'approval_bypass',
    String.raw`\bwithout\s+(?:any\s+|prior\s+|further\s+|human\s+|manager\s+|customer\s+)*(?:approval|review|sign-?off|consent|confirmation)\b|\b(?:skip|bypass|waive)\s+(?:the\s+)?(?:approval|review|sign-?off)\b|\bno\s+approval\s+(?:is\s+)?(?:needed|required)\b`,
    'Recommends proceeding without approval or review.',
    'i',
  ),
];

/** Wording about people that is never acceptable anywhere in an output (responsible-AI rules). */
export const PEOPLE_RULES: readonly PatternRule[] = [
  rule(
    'individual_discipline',
    String.raw`\b(?:should|must|ought to|deserves? to|needs? to)\s+be\s+(?:disciplined|fired|terminated|demoted|reprimanded|punished|penali[sz]ed|dismissed|sacked)\b|\b(?:discipline|fire|terminate|demote|reprimand|punish|dismiss)\s+(?:the\s+|this\s+)?(?:engineer|employee|agent|analyst|person|individual)\b`,
    'Suggests disciplinary action against an individual.',
    'i',
  ),
  rule(
    'individual_ranking',
    String.raw`\b(?:rank|rate|score|grade|compare)\s+(?:the\s+|these\s+|all\s+)?(?:engineers?|employees?|agents?|analysts?|individuals?|people)\b|\b(?:worst|best|weakest|top|bottom)\s+(?:performing\s+)?(?:engineer|employee|agent|analyst)\b`,
    'Ranks or rates individuals.',
    'i',
  ),
  rule(
    'personal_judgement',
    String.raw`\b(?:is|was|are|were|being)\s+(?:an?\s+)?(?:incompetent|lazy|unprofessional|negligent|careless|useless|stupid)\b`,
    'Passes personal judgement instead of describing the process.',
    'i',
  ),
];

const NEGATION =
  /\b(?:not|never|no|cannot|can't|don't|do not|must not|should not|shouldn't|avoid|instead of|rather than|without|nor)\b/i;

/** True when a negation or contrast word sits earlier in the same clause (a description, not a recommendation). */
function negatedBefore(text: string, index: number): boolean {
  if (/[.;:!?\n]/.test(text.charAt(index))) return false;
  const window = text.slice(Math.max(0, index - 45), index);
  const boundary = Math.max(
    window.lastIndexOf('.'),
    window.lastIndexOf(';'),
    window.lastIndexOf('!'),
    window.lastIndexOf('?'),
    window.lastIndexOf('\n'),
  );
  return NEGATION.test(boundary >= 0 ? window.slice(boundary + 1) : window);
}

/** Returns every rule that matches `text` outside a negated context. */
export function findViolations(
  text: string,
  rules: readonly PatternRule[],
  respectNegation: boolean,
): PatternRule[] {
  const hits: PatternRule[] = [];
  for (const r of rules) {
    const match = r.pattern.exec(text);
    if (!match) continue;
    if (respectNegation && negatedBefore(text, match.index)) continue;
    hits.push(r);
  }
  return hits;
}
