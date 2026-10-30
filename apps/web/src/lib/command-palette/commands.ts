import type { Persona, CaseSummary } from '@caseguard/schemas';
import { ROLE_LABELS } from '@caseguard/schemas';
import { NAV_ITEMS, type NavContext } from '../nav';

export type CommandGroup =
  'Navigate' | 'Cases' | 'Appearance' | 'Identity' | 'Presentation' | 'Actions';
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
  'Navigate',
  'Cases',
  'Appearance',
  'Identity',
  'Presentation',
  'Actions',
];

export interface PaletteCommand {
  id: string;
  label: string;
  group: CommandGroup;
  /** Extra words that match the search but are not shown. */
  keywords?: string;
  /** Muted text after the label (for example the shortcut or the case title). */
  hint?: string;
  run: () => void;
}

export interface NavigationCommandInput {
  context: NavContext;
  navigate: (href: string) => void;
}

/** One "Go to ..." command per destination, with the `g x` shortcut as a hint. */
export function buildNavigationCommands({
  context,
  navigate,
}: NavigationCommandInput): PaletteCommand[] {
  return NAV_ITEMS.map((item) => {
    const needsCase = item.scope === 'case' && !context.caseId;
    return {
      id: `go:${item.id}`,
      label: `Go to ${item.label}`,
      group: 'Navigate',
      keywords: `${item.description} ${item.id}`,
      hint: needsCase ? 'choose a case first' : `G then ${item.shortcutKey.toUpperCase()}`,
      run: () => navigate(item.href(context)),
    };
  });
}

export interface CaseCommandInput {
  cases: readonly CaseSummary[];
  /** Opens the case (keeps the current section when already on a case page). */
  openCase: (caseId: string) => void;
}

export function buildCaseCommands({ cases, openCase }: CaseCommandInput): PaletteCommand[] {
  return cases.map((c) => ({
    id: `case:${c.id}`,
    label: `Switch to ${c.reference}`,
    group: 'Cases',
    keywords: `${c.title} ${c.product} ${c.workload} ${c.customerAlias}`,
    hint: c.title,
    run: () => openCase(c.id),
  }));
}

export interface PersonaCommandInput {
  personas: readonly Persona[];
  currentPersonaId: string | null;
  selectPersona: (personaId: string) => void;
}

export function buildPersonaCommands({
  personas,
  currentPersonaId,
  selectPersona,
}: PersonaCommandInput): PaletteCommand[] {
  return personas
    .filter((p) => p.id !== currentPersonaId)
    .map((p) => ({
      id: `persona:${p.id}`,
      label: `Switch persona to ${p.displayName}`,
      group: 'Identity',
      keywords: `${ROLE_LABELS[p.role]} ${p.role} development identity ${p.description}`,
      hint: ROLE_LABELS[p.role],
      run: () => selectPersona(p.id),
    }));
}
