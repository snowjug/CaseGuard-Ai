/*
 * Prompt-injection heuristics for untrusted case text (NFR-SEC-05, threat AI-1).
 *
 * These are pattern based and WILL be evaded by a determined attacker (paraphrase, other languages,
 * homoglyphs). They exist to flag and quarantine the obvious attempts, to give reviewers evidence,
 * and to complement the real controls: instruction/data separation (`wrapUntrustedContent`), a model
 * with no tools, schema/citation/policy validation of every output.
 *
 * Support-engineer language is full of imperatives ("ignore the previous error", "run this command",
 * "send the logs to ..."). Rules therefore require the AI-specific nouns (instructions, system
 * prompt, tool, skill, score) and grade severity by how unambiguous the phrase is.
 *
 * Every pattern is linear: bounded gaps, finite word lists, no nested unbounded quantifiers.
 */

export type InjectionSeverity = 'low' | 'medium' | 'high';

export interface InjectionRule {
  /** Stable identifier recorded in findings and metrics. */
  readonly id: string;
  readonly explanation: string;
  /** Must be global and case-insensitive. */
  readonly pattern: RegExp;
  /** Fixed severity, or a function that grades the match (return null to discard it). */
  readonly severity:
    InjectionSeverity | ((match: string, text: string, index: number) => InjectionSeverity | null);
}

const word = (alternatives: string): string => `(?:${alternatives})`;

const IGNORE_VERB = word('ignore|disregard|forget|override|overrule|bypass|discard');
const IGNORE_FILLER = word(
  'all|any|every|everything|of|the|your|my|these|those|previous|prior|earlier|above|preceding|original|initial|system|safety|and|then|that|you|were|was|have|been|told|given|about|new|other|rest',
);
const INSTRUCTION_NOUN = word(
  'instructions?|prompts?|directives?|guidelines|rules|constraints|guardrails?|programming|training|system\\s+(?:prompt|message|instructions?)',
);
/** Qualifiers that make "ignore ... instructions" unmistakably about the AI's own configuration. */
const STRONG_QUALIFIER =
  /\b(?:previous|prior|earlier|above|preceding|original|initial|system|your|safety)\b/i;

const REVEAL_VERB = word(
  'reveal|show|print|display|repeat|output|leak|disclose|expose|dump|recite|tell|give|share|send|paste|echo|write',
);
const REVEAL_FILLER = word(
  'me|us|to|out|back|verbatim|exactly|word|for|all|the|your|you|of|full|entire|complete|hidden|secret|initial|original|current|internal|above|previous|prior|first|own|exact',
);

const MODEL_NOUN = word(
  'system\\s+(?:prompt|message|instructions?)|(?:hidden|secret|initial|original|internal)\\s+(?:prompt|instructions?|rules|message)|(?:your|the\\s+system)\\s+(?:prompt|instructions?|rules)',
);

const SENSITIVE_OBJECT = word(
  'system\\s+prompt|(?:your|the\\s+system|all\\s+(?:previous|prior))\\s+(?:instructions|prompt|messages|context|secrets|credentials|api\\s*keys?|tokens?)|chat\\s+history|conversation(?:\\s+history)?|environment\\s+variables?|the\\s+(?:above|previous|entire)\\s+(?:text|messages?|content|conversation)',
);

const ACTION_AFTER_CONTINUATION = word(
  'must|should|will|do|say|write|print|output|reply|respond|answer|act|tell|reveal|approve|publish|mark|set|give',
);

const POLICY_SUBJECT = word(
  'safety|policy|policies|approval|guardrails?|safeguards?|governance|citation|verification',
);

/** Words near a bypass phrase that tie it to CaseGuard's own governed decisions. */
const GOVERNED_CONTEXT =
  /\b(?:skill|skills|quality\s+score|score|publish|approve|approval|finding|findings|analysis)\b/i;

/** What must follow "send <sensitive thing>" for it to count as exfiltration: a destination. */
const EXFIL_DESTINATION =
  /^[^.\n]{0,80}?\b(?:to|at|via|into)\b[^.\n]{0,20}?(?:https?:\/\/\S{4,200}|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+)/i;

export const INJECTION_RULES: readonly InjectionRule[] = [
  {
    id: 'ignore_previous_instructions',
    explanation:
      'Tells the reader to ignore or override earlier instructions, a classic instruction-hijacking phrase.',
    pattern: new RegExp(
      `\\b${IGNORE_VERB}\\b(?:\\s+${IGNORE_FILLER}){0,8}\\s+${INSTRUCTION_NOUN}\\b`,
      'gi',
    ),
    // "ignore the instructions I sent earlier" is ordinary correspondence: only qualified forms are high.
    severity: (match) => (STRONG_QUALIFIER.test(match) ? 'high' : 'medium'),
  },
  {
    id: 'ignore_previous_instructions',
    explanation:
      'Tells the reader to forget everything above and then do something else: instruction hijacking.',
    pattern: new RegExp(
      `\\b(?:ignore|disregard|forget)\\s+(?:all\\s+|everything\\s+)(?:above|before|previously|prior)\\b[^.\\n]{0,20}?\\b(?:and|then|instead|now)\\s+(?:you\\s+)?${ACTION_AFTER_CONTINUATION}\\b`,
      'gi',
    ),
    severity: 'high',
  },
  {
    id: 'system_prompt_exfiltration',
    explanation: 'Asks for the hidden system prompt or instructions to be revealed or repeated.',
    pattern: new RegExp(
      `\\b${REVEAL_VERB}\\b(?:\\s+${REVEAL_FILLER}){0,7}\\s+${MODEL_NOUN}\\b`,
      'gi',
    ),
    severity: 'high',
  },
  {
    id: 'system_prompt_exfiltration',
    explanation: 'Asks the model what its system prompt, instructions or rules are.',
    pattern:
      /\bwhat\s+(?:is|are|were)\s+your\s+(?:(?:system|initial|original|hidden|secret)\s+)?(?:prompt|instructions|rules)\b/gi,
    severity: 'high',
  },
  {
    id: 'system_prompt_exfiltration',
    explanation: 'Asks the model to repeat everything that came before the user content.',
    pattern:
      /\b(?:repeat|print|output|echo|recite)\s+(?:everything|all|the\s+(?:words|text|content|conversation))\s+(?:above|before|so\s+far|prior)\b/gi,
    severity: 'medium',
  },
  {
    id: 'role_override',
    explanation:
      'Tries to switch the model into an unrestricted persona or remove its safety behaviour.',
    pattern: new RegExp(
      [
        'you\\s+(?:are|will\\s+be|must\\s+be)\\s+now\\s+(?:in\\s+)?(?:dan|developer\\s+mode|jailbroken|unrestricted|uncensored|unfiltered)',
        '(?:enter|enable|activate|switch\\s+to|turn\\s+on)\\s+(?:developer|dev|god|debug|sudo|jailbreak|unrestricted|dan)\\s+mode',
        'do\\s+anything\\s+now',
        'you\\s+(?:have|are\\s+under|operate\\s+with|will\\s+have)\\s+no\\s+(?:restrictions|limitations|filters|rules|guidelines|ethical\\s+(?:guidelines|constraints|boundaries))',
        '(?:ignore|disable|remove)\\s+(?:all\\s+)?(?:your\\s+)?(?:safety|ethical|content)\\s+(?:filters?|guidelines|restrictions|policies)',
      ]
        .map((alternative) => `\\b${alternative}\\b`)
        .join('|'),
      'gi',
    ),
    severity: 'high',
  },
  {
    id: 'role_override',
    explanation: 'Asks the model to pretend to be, or act as, a privileged system role.',
    pattern:
      /\b(?:pretend|imagine|act|behave|roleplay|role-play)\s+(?:(?:that\s+)?you\s+are\s+|as\s+(?:if\s+you\s+(?:were|are)\s+)?|to\s+be\s+)(?:an?\s+|the\s+)?(?:system|administrator|admin|root|developer|assistant|ai|model|reviewer|manager|curator)\b/gi,
    severity: 'medium',
  },
  {
    id: 'role_override',
    explanation:
      'Tries to re-task the model for the rest of the conversation ("from now on you will respond only ...").',
    pattern:
      /\bfrom\s+now\s+on\s*,?\s+(?:you|your)\s+(?:are|will|must|should|shall)\s+(?:only\s+|always\s+|never\s+)?(?:respond|answer|reply|act|behave|ignore|obey|follow|output|print|say|speak|write|comply)\b/gi,
    severity: 'medium',
  },
  {
    id: 'tool_invocation',
    explanation: 'Contains model tool-call or function-call markup that could trigger an action.',
    pattern:
      /<\s*\/?\s*(?:tool_call|function_call|function_calls|tool_use|invoke)\b|"(?:tool_calls?|function_call)"\s*:|\[\s*\/?\s*TOOL_CALLS?\s*\]|<\|\s*(?:tool|function)[^|>]{0,30}\|>|\bto=functions\.\w+/gi,
    severity: 'high',
  },
  {
    id: 'tool_invocation',
    explanation: 'Instructs the model to call a destructive or privileged tool by name.',
    pattern:
      /\b(?:call|invoke|use|run|execute|trigger)\s+(?:the\s+)?[`"']?(?:publish_skill|approve_skill|delete_case|export_data|update_role|grant_permission|send_email|shell|bash|powershell|exec)[`"']?(?:\s+(?:tool|function|command|api))?\b/gi,
    severity: 'high',
  },
  {
    id: 'tool_invocation',
    explanation: 'Orders the model to call a named tool or function.',
    pattern:
      /\byou\s+(?:must|should|need\s+to|have\s+to|will|shall)\s+(?:now\s+)?(?:call|invoke|use|run|execute|trigger)\s+(?:the\s+)?[`"']?[\w.-]{2,40}[`"']?\s+(?:tool|function|plugin)\b/gi,
    severity: 'medium',
  },
  {
    id: 'delimiter_spoofing',
    explanation:
      'Contains chat-template or CaseGuard delimiter tokens that try to end the data block or open a system turn.',
    pattern:
      /<\|\s*(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id|begin_of_text|end_of_text|fim_prefix|fim_suffix)\s*\|>|\[\/?INST\]|<<\/?SYS>>|\bUNTRUSTED[_ -]?(?:CONTENT|DATA)\b/gi,
    severity: 'high',
  },
  {
    id: 'delimiter_spoofing',
    explanation: 'Uses role tags or headings that imitate a system or assistant message.',
    pattern:
      /<\s*\/?\s*(?:system|assistant|developer|instructions?|prompt)\s*>|^[ \t]{0,3}#{1,6}[ \t]*(?:system|assistant)\b|^[ \t]*```[ \t]*(?:system|assistant)\b/gim,
    severity: 'medium',
  },
  {
    id: 'delimiter_spoofing',
    explanation: 'A line that starts like a system or assistant turn and then gives orders.',
    pattern:
      /^[ \t]*(?:system|assistant|developer)[ \t]*[:>][ \t]*(?:you\s+(?:are|must|will|should)|ignore|disregard|from\s+now|always|never|do\s+not)\b/gim,
    severity: 'medium',
  },
  {
    id: 'policy_override',
    explanation: 'Asks the system to approve or publish a skill without going through governance.',
    pattern:
      /\b(?:approve|publish|release|promote)\s+(?:and\s+(?:approve|publish|release)\s+)?(?:this|the|that|these|it)\s+(?:skill|skilldna|playbook)s?\b/gi,
    severity: 'high',
  },
  {
    id: 'policy_override',
    explanation: 'Asks to skip or bypass a safety, policy, approval or governance check.',
    pattern: new RegExp(
      `\\b(?:skip|bypass|circumvent|disable|turn\\s+off|override|ignore)\\s+(?:the\\s+|any\\s+|all\\s+|human\\s+)?${POLICY_SUBJECT}(?:\\s+(?:check|checks|step|steps|process|requirements?|rules?|validation|review))?\\b`,
      'gi',
    ),
    severity: (match, text, index) => {
      const window = text.slice(Math.max(0, index - 100), index + match.length + 100);
      return GOVERNED_CONTEXT.test(window) ? 'high' : 'medium';
    },
  },
  {
    id: 'policy_override',
    explanation: 'Tries to mark a skill, analysis or case as approved, validated or published.',
    pattern:
      /\b(?:mark|set|flag|record|label)\s+(?:this|the|it)\s+(skill|analysis|finding|case|review|run)\s+(?:as\s+)?(?:approved|validated|verified|published|safe|passed|reviewed)\b/gi,
    severity: (match) => (/\b(?:case|review)\b/i.test(match) ? 'medium' : 'high'),
  },
  {
    id: 'policy_override',
    explanation: 'Tries to dictate a quality score or rating.',
    pattern:
      /\b(?:set|give|assign|rate|score|rank)\b[^.\n]{0,40}?\b(?:quality\s+)?score\b[^.\n]{0,25}?\b(?:100|10\s*\/\s*10|perfect|maximum|highest|full\s+marks|top)\b|\b(?:give|rate|score)\s+(?:this|the)\s+(?:case|engineer|analysis)\s+(?:a\s+)?(?:perfect|100|full|top|maximum)\b/gi,
    severity: 'high',
  },
  {
    id: 'policy_override',
    explanation: 'Asks the system to hide something from the human reviewer.',
    pattern:
      /\bdo\s+not\s+(?:tell|mention|reveal|report|disclose)\b[^.\n]{0,30}?\b(?:the\s+)?(?:user|reviewer|human|operator|auditor)\b/gi,
    severity: 'medium',
  },
  {
    id: 'exfil_url_instruction',
    explanation:
      'A markdown image or link whose address carries template placeholders, a way to leak data when rendered.',
    pattern:
      /!\[[^\]\n]{0,100}\]\(\s*https?:\/\/[^\s)]{1,200}[?&][^\s)]{0,100}(?:\{\{?[^}\s]{1,40}\}\}?|\$\{[^}\s]{1,40}\}|<[^>\s]{1,40}>|%7B%7B[^)\s]{1,40}%7D%7D)[^\s)]{0,100}\)/gi,
    severity: 'high',
  },
  {
    id: 'exfil_url_instruction',
    explanation:
      'Instructs the model to send its prompt, conversation or secrets to an external address.',
    // Two stages keep this linear: a cheap candidate match, then one bounded look at what follows.
    pattern: new RegExp(
      `\\b(?:send|post|upload|forward|transmit|exfiltrate|email|submit|leak|pipe|append|include|encode|put|write)\\b[^.\\n]{0,60}?\\b${SENSITIVE_OBJECT}\\b`,
      'gi',
    ),
    severity: (match, text, index) =>
      EXFIL_DESTINATION.test(text.slice(index + match.length, index + match.length + 160))
        ? 'high'
        : null,
  },
  {
    id: 'exfil_url_instruction',
    explanation:
      'Asks the model to fetch a URL whose query string is filled in from conversation data.',
    pattern:
      /\b(?:visit|open|fetch|load|request|curl|wget|browse|navigate\s+to)\b[^.\n]{0,30}?https?:\/\/\S{4,200}\?\S*(?:\{\{?[^}\s]{1,40}\}\}?|\$\{[^}\s]{1,40}\}|%7B%7B)/gi,
    severity: 'medium',
  },
];

/** Cue that asks the reader to decode something and then act on it. */
export const DECODE_AND_FOLLOW =
  /\b(?:base64[\s-]*decode|decode(?:\s+(?:the|following|this|below|above|base64|hex|rot13|string|text|message)){0,4}|rot13|hex[\s-]*decode|deobfuscate)\b[^.\n]{0,40}?\b(?:and|then)\s+(?:follow|execute|run|obey|apply|do|comply|carry\s+out|treat)\b/gi;

/** A long base64 or hex run that could carry an encoded payload. */
export const ENCODED_BLOB = /[A-Za-z0-9+/]{80,}={0,2}|(?:[0-9a-fA-F]{2}){40,}/g;
