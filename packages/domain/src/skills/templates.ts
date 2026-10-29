import type { KnowledgeAction, QueryTemplate } from '@caseguard/schemas';
import { actionSlug, clip, placeholdersIn } from './util';

export type TemplateLanguage = QueryTemplate['language'];

const LANGUAGES: readonly TemplateLanguage[] = ['kql', 'powershell'];
const LANGUAGE_LABEL: Record<TemplateLanguage, string> = { kql: 'KQL', powershell: 'PowerShell' };

/** Template ids are derived from the action so a step can find its templates without a join column. */
export const templateIdFor = (actionKey: string, language: TemplateLanguage): string =>
  `tpl-${actionSlug(actionKey)}-${language}`;

export const isTemplateOf = (templateId: string, actionKey: string): boolean =>
  LANGUAGES.some((language) => templateIdFor(actionKey, language) === templateId);

/** The knowledge-pack query templates of one action, as skill query templates. */
export function templatesOfAction(action: KnowledgeAction): QueryTemplate[] {
  const out: QueryTemplate[] = [];
  for (const language of LANGUAGES) {
    const text = action.templates[language];
    if (!text) continue;
    out.push({
      id: templateIdFor(action.id, language),
      language,
      title: clip(`${action.label} (${LANGUAGE_LABEL[language]})`, 160),
      description: clip(action.description, 400),
      template: text,
      parameters: placeholdersIn(text).map((name) => ({
        name,
        description: clip(
          `Value for {{${name}}}. Use real values only in the live session, never in shared notes.`,
          200,
        ),
      })),
      safetyNote: clip(
        action.safetyNotes ??
          'Read-only. Replace the placeholders; never paste customer data into shared notes.',
        300,
      ),
    });
  }
  return out;
}
