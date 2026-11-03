import { checkOutputInjection } from '../../validators/injection';
import type { RuleContext } from '../context';
import { collectProposalTexts, sanitisePath } from '../text';
import type { ProposalIssue } from '../types';

const MESSAGE =
  'The proposal contains instruction-like text, markup, a link or a sign of obeying the record.';

/**
 * The existing injection scanner, on what a model returned. Everything the proposal holds is read, quotations
 * included: a model that repeats an instruction from the record, or obeys one, is not trusted with that finding. Weak
 * indicators (a run of angle brackets) are not instructions and do not count. The output-side checks of the validators
 * add the behaviours of a compromised model: markup, links and addresses that are not in the record, tool calls, the
 * data delimiter or its nonce, repeating the internal instructions, signs of having obeyed. (A secret-like value is
 * `secret_like_text`.)
 */
export function checkInstructionLikeText(proposal: unknown, ctx: RuleContext): ProposalIssue[] {
  const { own, quoted } = collectProposalTexts(proposal);
  const issues = new Map<string, ProposalIssue>();
  const add = (path: string): void => {
    const safe = sanitisePath(path);
    issues.set(safe, { code: 'instruction_like_text', path: safe, message: MESSAGE });
  };
  for (const { path, text } of [...own, ...quoted]) {
    if (ctx.scanInjection(text).some((hit) => hit.severity !== 'low')) add(path);
  }
  const behaviours = checkOutputInjection(proposal, {
    built: { allText: ctx.injection.allText },
    promptGuard: ctx.injection.promptGuard,
  }).filter((issue) => issue.code !== 'secret_in_output');
  for (const issue of behaviours) add(issue.path);
  return [...issues.values()].slice(0, 5);
}
