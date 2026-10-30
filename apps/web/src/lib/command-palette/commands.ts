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
  /** Shows the `g x` shortcut as a hint (default true); false while single-key shortcuts are turned off. */
  showShortcuts?: boolean;
}

/** One "Go to ..." command per destination, with the `g x` shortcut as a hint. */
export function buildNavigationCommands({
  context,
  navigate,
  showShortcuts = true,
}: NavigationCommandInput): PaletteCommand[] {
  return NAV_ITEMS.map((item) => {
    const needsCase = item.scope === 'case' && !context.caseId;
    const hint = needsCase
      ? 'choose a case first'
      : showShortcuts
        ? `G then ${item.shortcutKey.toUpperCase()}`
        : null;
    return {
      id: `go:${item.id}`,
      label: `Go to ${item.label}`,
      group: 'Navigate',
      keywords: `${item.description} ${item.id}`,
      ...(hint === null ? {} : { hint }),
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

export interface PageCommandInput {
  context: NavContext;
  navigate: (href: string) => void;
}

/**
 * Entries for pages and sections the 12 destinations do not reach by themselves: the portfolio analytics (the Quality
 * Review item opens the case review while a case is open), the Governance sections, the AI provider and the ingestion
 * wizard. Labels avoid a "Go to" prefix so they never outrank the destination commands.
 */
export function buildPageCommands({ context, navigate }: PageCommandInput): PaletteCommand[] {
  const entry = (
    id: string,
    label: string,
    href: string,
    keywords: string,
    group: CommandGroup = 'Navigate',
  ): PaletteCommand => ({ id, label, group, keywords, hint: href, run: () => navigate(href) });
  const commands = [
    entry(
      'page:quality-portfolio',
      'Quality Review: portfolio analytics',
      '/quality',
      'analytics trends all cases cohort adoption responsible use',
    ),
    entry(
      'page:new-case',
      'Ingest a new case',
      '/cases/new',
      'upload import sample wizard paste',
      'Cases',
    ),
    entry(
      'page:governance-audit',
      'Governance: audit log',
      '/governance?tab=audit',
      'audit hash chain verify events who did what',
    ),
    entry(
      'page:governance-roles',
      'Governance: roles',
      '/governance?tab=roles',
      'users permissions assign entra',
    ),
    entry(
      'page:governance-redaction',
      'Governance: redaction',
      '/governance?tab=redaction',
      'secrets pii patterns custom regex',
    ),
    entry(
      'page:governance-model',
      'Governance: model configuration',
      '/governance?tab=model',
      'tokens limits budgets cost routing',
    ),
    entry(
      'page:governance-export',
      'Governance: export data',
      '/governance?tab=export',
      'download json controls',
    ),
    entry(
      'page:governance-reviews',
      'Governance: reviewer decisions',
      '/governance?tab=reviews',
      'confirm correct reject override',
    ),
    entry(
      'page:system-provider',
      'System Health: AI provider',
      '/system',
      'azure openai deterministic validation simulated stand-ins dependencies',
    ),
  ];
  if (context.caseId) {
    commands.push(
      entry(
        'page:case-overview',
        'Open the active case overview',
        `/cases/${encodeURIComponent(context.caseId)}`,
        'digital twin summary analysis status',
        'Cases',
      ),
    );
  }
  return commands;
}
