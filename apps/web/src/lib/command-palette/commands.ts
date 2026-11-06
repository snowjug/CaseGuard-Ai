import type { Persona, CaseSummary } from '@caseguard/schemas';
import { ROLE_LABELS } from '@caseguard/schemas';
import {
  ActivityIcon,
  ChartLineIcon,
  FileTextIcon,
  FolderOpenIcon,
  GaugeIcon,
  PlusIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  UserRoundIcon,
  UsersRoundIcon,
  type LucideIcon,
} from 'lucide-react';
import { ADD_CASE_HREF, NAV_ITEMS, SAMPLE_CASE_HREF, type NavContext } from '../nav';

export type CommandGroup = 'Actions' | 'Go to' | 'Cases' | 'Preferences' | 'Advanced' | 'Account';
export const COMMAND_GROUP_ORDER: readonly CommandGroup[] = [
  'Actions',
  'Go to',
  'Cases',
  'Preferences',
  'Advanced',
  'Account',
];

export interface PaletteCommand {
  id: string;
  label: string;
  group: CommandGroup;
  icon?: LucideIcon;
  /** Extra words that match the search but are not shown. */
  keywords?: string;
  /** Muted text after the label (for example the shortcut or the case title). */
  hint?: string;
  /** False keeps the command out of the short list shown before anything is typed; typing still finds it. */
  featured?: boolean;
  run: () => void;
}

/** Destinations that live under the Advanced page; they are listed in that group. */
const ADVANCED_NAV_IDS: ReadonlySet<string> = new Set([
  'efficiency',
  'governance',
  'system',
  'demo',
]);

export interface NavigationCommandInput {
  context: NavContext;
  navigate: (href: string) => void;
  /** Shows the `g x` shortcut as a hint (default true); false while single-key shortcuts are turned off. */
  showShortcuts?: boolean;
  /** True once the case list loaded and is empty: case destinations then say to add a case, not to choose one. */
  noCases?: boolean;
}

/** One "Go to ..." command per destination, with the `g x` shortcut as a hint. */
export function buildNavigationCommands({
  context,
  navigate,
  showShortcuts = true,
  noCases = false,
}: NavigationCommandInput): PaletteCommand[] {
  return NAV_ITEMS.map((item) => {
    const needsCase = item.scope === 'case' && !context.caseId;
    const hint = needsCase
      ? noCases
        ? 'add a case first'
        : 'choose a case first'
      : showShortcuts
        ? `G then ${item.shortcutKey.toUpperCase()}`
        : null;
    return {
      id: `go:${item.id}`,
      label: `Go to ${item.label}`,
      group: ADVANCED_NAV_IDS.has(item.id) ? 'Advanced' : 'Go to',
      icon: item.icon,
      keywords: `${item.description} ${item.id}`,
      ...(hint === null ? {} : { hint }),
      // Case destinations without an open case only lead to the case list, so the short list leaves them out.
      featured: !needsCase,
      run: () => navigate(item.href(context)),
    };
  });
}

export interface CaseCommandInput {
  cases: readonly CaseSummary[];
  /** Opens the case (keeps the current section when already on a case page). */
  openCase: (caseId: string) => void;
}

/** How many cases the short list shows; typing searches all that were loaded. */
const FEATURED_CASES = 5;

export function buildCaseCommands({ cases, openCase }: CaseCommandInput): PaletteCommand[] {
  return cases.map((c, index) => ({
    id: `case:${c.id}`,
    label: `Open ${c.reference}`,
    group: 'Cases',
    icon: FolderOpenIcon,
    keywords: `${c.title} ${c.product} ${c.workload} ${c.customerAlias}`,
    hint: c.title,
    featured: index < FEATURED_CASES,
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
      group: 'Account',
      icon: UserRoundIcon,
      keywords: `${ROLE_LABELS[p.role]} ${p.role} development identity ${p.description}`,
      hint: ROLE_LABELS[p.role],
      featured: false,
      run: () => selectPersona(p.id),
    }));
}

export interface PageCommandInput {
  context: NavContext;
  navigate: (href: string) => void;
}

/**
 * Entries that the destinations do not reach by themselves: adding a case, the sample case, the portfolio view of
 * quality, the sections of Settings and audit, the AI provider and the report of the open case. Labels avoid a "Go to"
 * prefix so they never outrank the destination commands.
 */
export function buildPageCommands({ context, navigate }: PageCommandInput): PaletteCommand[] {
  const entry = (
    id: string,
    label: string,
    href: string,
    keywords: string,
    options: {
      group?: CommandGroup;
      icon?: LucideIcon;
      featured?: boolean;
      showHref?: boolean;
    } = {},
  ): PaletteCommand => ({
    id,
    label,
    group: options.group ?? 'Advanced',
    keywords,
    featured: options.featured ?? false,
    ...(options.showHref === false ? {} : { hint: href }),
    ...(options.icon ? { icon: options.icon } : {}),
    run: () => navigate(href),
  });
  const commands = [
    entry(
      'page:new-case',
      'Add a case',
      ADD_CASE_HREF,
      'new upload import paste create ingest wizard',
      {
        group: 'Actions',
        icon: PlusIcon,
        featured: true,
        showHref: false,
      },
    ),
    entry(
      'page:sample-case',
      'Try a sample case',
      SAMPLE_CASE_HREF,
      'demo example sample data first review',
      { group: 'Actions', icon: SparklesIcon, featured: true, showHref: false },
    ),
    entry(
      'page:quality-portfolio',
      'Quality across all cases',
      '/quality',
      'analytics trends cohort adoption responsible use portfolio',
      { group: 'Go to', icon: ChartLineIcon },
    ),
    entry(
      'page:governance-audit',
      'Settings and audit: audit log',
      '/governance?tab=audit',
      'audit hash chain verify events who did what governance',
      { icon: ScrollTextIcon },
    ),
    entry(
      'page:governance-roles',
      'Settings and audit: roles',
      '/governance?tab=roles',
      'users permissions assign entra governance',
      { icon: UsersRoundIcon },
    ),
    entry(
      'page:governance-redaction',
      'Settings and audit: redaction',
      '/governance?tab=redaction',
      'secrets pii patterns custom regex governance',
      { icon: ShieldCheckIcon },
    ),
    entry(
      'page:governance-model',
      'Settings and audit: model configuration',
      '/governance?tab=model',
      'tokens limits budgets cost routing governance',
      { icon: Settings2Icon },
    ),
    entry(
      'page:governance-export',
      'Settings and audit: export data',
      '/governance?tab=export',
      'download json controls governance',
      { icon: Settings2Icon },
    ),
    entry(
      'page:governance-reviews',
      'Settings and audit: reviewer decisions',
      '/governance?tab=reviews',
      'confirm correct reject override governance',
      { icon: Settings2Icon },
    ),
    entry(
      'page:efficiency-cost',
      'Usage and cost: model spend',
      '/efficiency',
      'tokens budget spend efficiency estimates',
      { icon: GaugeIcon },
    ),
    entry(
      'page:system-provider',
      'System status: AI provider',
      '/system',
      'azure openai deterministic validation simulated stand-ins dependencies health',
      { icon: ActivityIcon },
    ),
  ];
  if (context.caseId) {
    const base = `/cases/${encodeURIComponent(context.caseId)}`;
    commands.push(
      entry(
        'page:case-overview',
        'Open case details',
        base,
        'digital twin summary facts analysis status',
        {
          group: 'Cases',
          icon: FolderOpenIcon,
          featured: true,
        },
      ),
      entry(
        'page:case-report',
        'Open the report',
        `${base}/report`,
        'print share export document',
        {
          group: 'Cases',
          icon: FileTextIcon,
          featured: true,
        },
      ),
    );
  }
  return commands;
}

export interface ActionCommandInput {
  refresh: () => void;
}

export function buildActionCommands({ refresh }: ActionCommandInput): PaletteCommand[] {
  return [
    {
      id: 'refresh',
      label: 'Refresh data on this page',
      group: 'Actions',
      icon: RefreshCwIcon,
      keywords: 'reload invalidate',
      featured: false,
      run: refresh,
    },
  ];
}
