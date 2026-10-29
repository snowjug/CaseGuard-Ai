import type { InjectionIndicator, InjectionScanner } from '../types';
import { redactSecrets } from '../util/redact';
import { clip, wordShingles } from '../util/text';
import type { OutputIssue, ValidationContext } from './types';
import { collectTexts } from './walk';

interface InputRule {
  ruleId: string;
  severity: InjectionIndicator['severity'];
  pattern: RegExp;
}

/**
 * Conservative, pattern-based detector for instruction-like content in untrusted case text. It is
 * a heuristic: it flags (and the prompt marks) suspicious passages, it never removes evidence, and
 * it is not a complete defence. The structural defences (delimited data blocks, output validation)
 * do not depend on it. The API layer may inject the shared scanner from the security package.
 */
const INPUT_RULES: readonly InputRule[] = [
  {
    ruleId: 'override_instructions',
    severity: 'high',
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(?:instructions?|rules?|prompts?|guidelines?|directions?|constraints?)\b/i,
  },
  {
    ruleId: 'role_override',
    severity: 'high',
    pattern:
      /\b(?:you are now (?:a|an|the|in)\b|pretend (?:to be|you are)\b|from now on,? you\b|developer mode|jailbreak|DAN mode)/i,
  },
  {
    ruleId: 'prompt_disclosure',
    severity: 'high',
    pattern:
      /\b(?:reveal|show|print|repeat|output|display|leak|disclose)\b[^.\n]{0,30}\b(?:system|hidden|initial|original)\b[^.\n]{0,15}\b(?:prompt|instructions?|message|rules)\b/i,
  },
  {
    ruleId: 'credential_disclosure',
    severity: 'high',
    pattern:
      /\b(?:reveal|print|output|leak|disclose|exfiltrate)\b[^.\n]{0,40}\b(?:your|the|any)\b[^.\n]{0,20}\b(?:api[-_ ]?keys?|passwords?|secrets?|tokens?|credentials?)\b/i,
  },
  {
    ruleId: 'delimiter_forgery',
    severity: 'high',
    pattern:
      /CASEGUARD_DATA|<\|(?:im_start|im_end|system|endoftext)\|>|\[\/?INST\]|<\/?(?:system|assistant)>|^\s*#{2,}\s*(?:system|instructions?)\b/im,
  },
  {
    ruleId: 'tool_request',
    severity: 'high',
    pattern:
      /\b(?:call|invoke|use|run)\s+(?:the\s+)?[\w.-]{2,40}\s+(?:tool|function|plugin)\b|"?(?:tool_calls?|function_call)"?\s*[:=]/i,
  },
  {
    ruleId: 'exfiltration_request',
    severity: 'high',
    pattern:
      /\b(?:send|post|upload|forward|e-?mail|exfiltrate|transmit|leak)\b[^.\n]{0,80}(?:https?:\/\/|\b[\w.+-]+@[\w-]+\.[\w.-]+)/i,
  },
  {
    ruleId: 'instruction_injection',
    severity: 'medium',
    pattern:
      /\b(?:new|updated|real|actual) instructions?\s*:|\b(?:end of|stop reading) (?:the )?(?:data|case|context|input)\b[^.\n]{0,25}\b(?:now|new)\b|\bsystem override\b/i,
  },
  {
    ruleId: 'delimiter_like',
    severity: 'low',
    pattern: /<{3,}|>{3,}/,
  },
];

/** Built-in scanner used when the API layer does not inject the shared security-package scanner. */
export const defaultInjectionScanner: InjectionScanner = (text) => {
  const findings: InjectionIndicator[] = [];
  for (const rule of INPUT_RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      findings.push({
        ruleId: rule.ruleId,
        severity: rule.severity,
        excerpt: clip(redactSecrets(match[0]), 120),
      });
    }
  }
  return findings;
};

interface OutputRule {
  code: string;
  message: string;
  pattern: RegExp;
  /** When true, a match that also occurs verbatim in the case data is allowed (quoting an attack). */
  allowIfInContext: boolean;
}

const OUTPUT_RULES: readonly OutputRule[] = [
  {
    code: 'active_markup',
    message: 'The output contains active markup, a script or an embedded image.',
    pattern:
      /<\s*(?:script|iframe|img|object|embed|svg|link|style)\b|javascript:|data:text\/html|!\[[^\]]*\]\([^)]*\)|\bon(?:error|load)\s*=/gi,
    allowIfInContext: false,
  },
  {
    code: 'external_url',
    message: 'The output contains a link that is not present in the case data.',
    pattern: /\b(?:https?:\/\/|www\.)[^\s"'<>)\]]+/gi,
    allowIfInContext: true,
  },
  {
    code: 'external_email',
    message: 'The output contains an e-mail address that is not present in the case data.',
    pattern: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
    allowIfInContext: true,
  },
  {
    code: 'tool_request',
    message: 'The output asks for or simulates a tool call; no tools are available.',
    pattern:
      /"?(?:tool_calls?|function_call)"?\s*[:=]|<\s*tool_call|\bcall(?:ing)?\s+the\s+[\w.-]+\s+(?:tool|function)\b/gi,
    allowIfInContext: true,
  },
  {
    code: 'obeyed_instruction',
    message: 'The output shows signs of following instructions found inside the case data.',
    pattern:
      /\bignor(?:e|ed|ing)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)\b|\bas\s+(?:instructed|requested|directed)\s+(?:in|by)\s+the\s+(?:case|note|email|data|customer|text)\b|\bI\s+(?:have\s+)?(?:ignored|disregarded|overridden|bypassed)\b|\bnew\s+instructions?\s+(?:accepted|received|applied)\b|\bdeveloper\s+mode\b/gi,
    allowIfInContext: true,
  },
  {
    code: 'delimiter_echo',
    message: 'The output echoes internal data-block delimiters.',
    pattern: /CASEGUARD_DATA|\bnonce\s*=/gi,
    allowIfInContext: false,
  },
];

const SHINGLE_SIZE = 6;
const MAX_ISSUES = 20;

/** Behavioural indicators that a model followed injected instructions or leaked internals. */
export function checkOutputInjection(output: unknown, vctx: ValidationContext): OutputIssue[] {
  const issues: OutputIssue[] = [];
  const texts = collectTexts(output);
  const context = vctx.built.allText;
  const { nonce, templateShingles } = vctx.promptGuard;
  for (const { path, text } of texts) {
    for (const rule of OUTPUT_RULES) {
      const offending = [...text.matchAll(rule.pattern)].find(
        (match) => !(rule.allowIfInContext && context.includes(match[0].toLowerCase())),
      );
      if (offending) {
        issues.push({ kind: 'injection', code: rule.code, path, message: rule.message });
      }
    }
    if (nonce && nonce.length >= 8 && text.includes(nonce)) {
      issues.push({
        kind: 'injection',
        code: 'delimiter_echo',
        path,
        message: 'The output echoes the data-block nonce.',
      });
    }
    if (redactSecrets(text) !== text) {
      issues.push({
        kind: 'injection',
        code: 'secret_in_output',
        path,
        message: 'The output contains a secret-like value.',
      });
    }
    if ([...wordShingles(text, SHINGLE_SIZE)].some((s) => templateShingles.has(s))) {
      issues.push({
        kind: 'injection',
        code: 'prompt_leak',
        path,
        message: 'The output repeats the internal instructions.',
      });
    }
  }
  return issues.slice(0, MAX_ISSUES);
}
