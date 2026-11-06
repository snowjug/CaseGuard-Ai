# CaseGuard AI: UI redesign spec

Status: Phase 1 (spec), written before any UI code. Source of truth for every later phase; deviations are logged in
`PROGRESS.md` with the reason.

**What the product does, in one sentence (the sentence the UI must make obvious):** CaseGuard checks how a support case
was handled and tells you what slowed it down and what to fix first.

**Feel:** cinematic dark with depth and a soft glow (getlayers.ai), built from 21st.dev / Magic UI quality parts: bento
layouts, command palette, blur-fade, number tickers, glint button, animated lists. A matching light theme.

**Acceptance test:** a support engineer who has never seen the app knows what it does and what to click within five
seconds, and it looks like a funded product.

## 0. Stack and how the brief is adapted to it

| Topic         | Decision                                                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework     | Keep Next.js 16 (App Router), React 19, TanStack Query, react-hook-form. No framework migration. Routes do not change (deep links, e2e and docs depend on them); `/advanced` is the only new route.                                                                                                             |
| Styling       | Keep Fluent UI v9 + Griffel `makeStyles` and the `@caseguard/ui` package. **No Tailwind, shadcn or Radix**: they are not in use, and a second styling system would fork the tokens. So `class-variance-authority`, `clsx` and `tailwind-merge` are not added either (Griffel `mergeClasses` covers variants).   |
| Tokens        | One TypeScript palette (`packages/ui/src/tokens`) -> CSS variables (`--cg*`) and the Fluent theme. Components use typed `cg.*` refs and Fluent `tokens.*`; nothing hard-codes a colour, radius or space. `globals.css` only holds static tokens and the pre-hydration canvas, kept in sync by an existing test. |
| Fluent's role | Behaviour layer for overlays and the few controls the kit does not replace (Dialog, Drawer, Popover, Tooltip, Menu, Checkbox, Radio, Switch): accessible by construction, restyled by the theme and thin kit wrappers. Everything the user sees as "the product" is a kit component.                            |
| New deps      | `motion` (MIT), `lucide-react` (ISC), `cmdk` (MIT), `@fontsource-variable/geist` and `geist-mono` (OFL-1.1). Nothing else.                                                                                                                                                                                      |
| Font          | **Geist** variable, self-hosted. General Sans is not used: the Fontshare licence is not clearly compatible with committing the font files to a repository.                                                                                                                                                      |
| Icons         | **lucide only**, stroke 1.75, sizes 16 / 20 / 24, through one `Icon` helper. All `@fluentui/react-icons` imports are migrated (102 icon components, 311 import sites).                                                                                                                                          |
| 21st.dev      | Not used (CLI/MCP not required; free tier is limited). All components are written by hand.                                                                                                                                                                                                                      |

## 1. Inventory

### 1.1 Routes and screens (today)

| Route                          | Screen today                  | What it is for (one line)                                                                           |
| ------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `/`                            | Command Center                | Quality picture of the active case: seven metrics, warnings, missing evidence, recent cases.        |
| `/cases`                       | Cases                         | List, filter, sort and open cases; start ingestion; delete a case.                                  |
| `/cases/new`                   | Ingest a case                 | Four-step wizard: choose a source, review the safety check, confirm, create and analyse.            |
| `/cases/[id]`                  | Case overview                 | Case facts, analysis status, the structured "digital twin", time cursor, manage (re-run, delete).   |
| `/cases/[id]/review`           | Guided Review                 | Verdict, chronology, what went wrong, better path, next actions, learning, share, method.           |
| `/cases/[id]/report`           | Report                        | One printable, copyable, downloadable document of the guided review.                                |
| `/cases/[id]/timeline`         | Case Timeline                 | Events, delays and repeats, hypothesis-confidence chart, "what was known when".                     |
| `/cases/[id]/evidence`         | Evidence Ledger               | Every claim classified into eight evidence categories; reviewer can correct a classification.       |
| `/cases/[id]/hypotheses`       | Hypothesis Arena              | Competing explanations with confidence, evidence for and against, ranked next actions and override. |
| `/cases/[id]/counterfactual`   | Counterfactual Lab            | From a decision moment, simulate safer paths, compare with what happened, review, extract a skill.  |
| `/cases/[id]/quality`          | Case Quality Review           | Quality index and its dimensions, effort metrics, warnings, skill matches, coaching, case compare.  |
| `/quality`                     | Quality Review (portfolio)    | Aggregate quality, evidence gaps, effort patterns, skill adoption over all analysed cases.          |
| `/skills`                      | SkillDNA Library              | Find governed, reusable investigation skills.                                                       |
| `/skills/[id]`                 | Skill detail                  | Lifecycle, definition, approvals, versions, validation and the cases a skill was applied to.        |
| `/efficiency`                  | Efficiency Monitor            | Model token, time and cost estimates, savings, budgets, circuit breakers, executions.               |
| `/governance`                  | Governance                    | Eleven admin sections: model, prompts, scoring, retention, redaction, flags, export, roles, audit.  |
| `/system`                      | System Health                 | Dependencies, migrations, provider validation, in-process metrics.                                  |
| `/demo`                        | Demo Guide                    | The 13-step synthetic story with presenter notes, seed and reset controls.                          |
| `/design-lab`                  | Design lab (development only) | Component gallery; returns 404 in production.                                                       |
| not found, error, global error | Status pages                  | Safe message, retry, way back.                                                                      |

### 1.2 Global chrome, overlays and actions (today)

- **Header:** brand link, global search (`/`), active-case selector, "Commands" (Ctrl/Cmd+K), theme menu, presentation
  toggle, account/persona menu. **Notices:** synthetic-data bar, development-identity chip, footer with responsible-use text.
- **Side nav:** 13 destinations in four groups (Overview, Investigate, Improve, Operate), badges, icon rail, mobile drawer.
  Case-scoped destinations depend on a remembered "active case" (cookie `cg-case`).
- **Overlays:** command palette, shortcuts dialog (`?`), persona picker, evidence drawer (review), event-detail drawer
  (timeline), claim-detail drawer (evidence), presenter strip (presentation mode), toasts.
- **Confirm dialogs:** delete case, re-run analysis, dismiss warning, change roles, reset demo, seed demo, classification
  change, action-value override, generate paths, accept or reject a path, extract or adopt a skill, skill transitions.
- **Keyboard:** `g` then a letter for every destination, `/` search, `?` help, `]` `[` governance sections, `n` next demo
  step, `r` refresh system health. Single-key shortcuts can be switched off.

### 1.3 Capabilities that must survive (presentation changes, behaviour does not)

Case quality review (index, dimensions, penalties, improvements, coaching, compare), counterfactual analysis (forks,
temporal boundary and leak check, strategies, accept/reject, graph with accessible tables, hindsight), evidence ledger
(categories, claim detail, reviewer classification with reason, missing evidence, record findings), skill reuse
(library, lifecycle, independent approvals, simulation test, apply, precedent), "what was known then" time cursor
(`?asOf=`), evidence drawer with verified quotations, report (print, copy summary, download HTML), ingestion preview with
redaction and prompt-injection screening, job progress, role and permission gates, audit log, demo story and
presentation mode, honest "synthetic" and "estimate" labelling, per-section error isolation, URL-backed filters,
skip link, focusable `main`, live regions, keyboard shortcuts.

## 2. What confuses a new user today

Observed in `before/` (every item is visible in the screenshots):

1. **No answer, no next step.** `/` opens with a title, a case selector and four caveat banners; the only action is
   "Open case". Nothing says what the product does or where to start.
2. **Four stacked info banners** (synthetic, estimates, trend arrows, simulated AI) push the content below the fold on
   Home, Skills, Skill detail and Governance. The same "Estimated" and "Synthetic" badges repeat on every card.
3. **13 navigation items in four groups** with internal vocabulary: Command Center, Guided Review, Hypothesis Arena,
   Counterfactual Lab, SkillDNA Library, Efficiency Monitor, "Operate". Five of them say "Needs a case".
4. **A hidden "active case"** (header select, cookie) decides where case-scoped links go. The header has seven controls
   (search, case select, Commands, theme, Present, persona, two badges) and takes about 170 px on a phone.
5. **The review has no verdict-first layout.** A small ring and paragraphs sit in nested bordered boxes, seven section
   pills precede them, and no list of "what to fix first" exists. The one coloured button ("See what went wrong") is
   inside a side card.
6. **Every case page opens with the same machinery:** breadcrumb, title, help icon, two buttons, description, badges,
   a "What was known" time-cursor panel. Power features sit in front of results on five pages.
7. **Intake is a four-step "Ingest a case" wizard** with a schema-download sidebar; the first button says "Validate and
   preview". "Ingest" is jargon; no obvious "paste or upload" hero.
8. **Dense, low-hierarchy typography:** 14 px body, many 12 px captions, grey on white, every block in a 1 px box
   (boxes inside boxes inside boxes). Nothing is visually dominant.
9. **Filters before content:** Cases shows six controls before one row of data; Evidence shows eight category tiles
   before the first claim; Counterfactual shows a fork list, a notice, a selector and five tabs.
10. **Admin walls of text** (Governance, Efficiency, System, Demo): nested banners, forms with 8 fields, bullet essays.
11. **Phone layout:** filters expand to full height, tables overflow, the first screen is header and banners.
12. **First visit:** a tiny "Choose persona" button on an empty Command Center; no product explanation.
13. **Status uses a rainbow of tones** (blue, purple, magenta, teal, navy) for non-status concepts, which dilutes the
    meaning of green, amber and red.

## 3. Information architecture

### 3.1 Flow (three steps, always visible on Home and in the empty states)

**1. Add a case -> 2. See the review -> 3. Fix what matters.**

### 3.2 Navigation (five items)

| Item         | Route(s) it covers                                            | Why                                                            |
| ------------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| **Home**     | `/`                                                           | What needs attention now; start a case.                        |
| **Cases**    | `/cases`, `/cases/new`, `/cases/[id]/*`                       | List, add, and the case workspace (tabs, below).               |
| **Quality**  | `/quality`                                                    | How quality trends across all analysed cases.                  |
| **Skills**   | `/skills`, `/skills/[id]`                                     | Reuse fixes that worked on earlier cases.                      |
| **Advanced** | `/advanced`, `/governance`, `/efficiency`, `/system`, `/demo` | Settings, audit and developer views. One hub page, four views. |

Desktop: slim sidebar (logo, five items, demo-data pill, account). Tablet: icon rail. Phone: bottom bar with the same five.
The remembered case only feeds a "Continue with CG-SYN-1001" card on Home and the command palette; it no longer changes
what a navigation item opens. The header case selector is removed; Home keeps a small case switcher.

### 3.3 Case workspace (all `/cases/[id]/*`)

One header (back to Cases, case title, reference, status and score badges, one primary action, "More" menu) and tabs
that are real links (`aria-current`): **Review** (default landing, `/review`), **Score** (`/quality`), **Evidence**,
**What if** (`/counterfactual`), **Timeline**, **More** (Possible causes `/hypotheses`, Case details `/`, Report
`/report`). The case row on `/cases` opens **Review**. "More" (the three-dot menu) holds Refresh, Re-run the review and Delete.

### 3.4 Advanced hub (`/advanced`)

Cards: Settings and audit (`/governance`), Usage and cost (`/efficiency`), System status (`/system`), Guided demo
(`/demo`), Appearance (theme, reduced motion, single-key shortcuts), Keyboard shortcuts (opens the dialog), Presentation
mode (toggle), Design lab (development only). Breadcrumb on the four views: Advanced > Settings and audit.

### 3.5 Global chrome rules

- One `h1` per page, from `PageHeader`; one primary button per screen, in the header; at most one inline notice per
  screen, and only when it changes what the person should do. Provenance sentences live in badges' tooltips.
- "Synthetic demo data" and "Development identity" become two small pills (sidebar foot / account menu) with tooltips.
  The responsible-use line stays as one caption row at the bottom of the content.
- Command palette (cmdk, Ctrl/Cmd+K, hint pill in the top bar): Actions (Add a case, Try a sample case), Go to (five
  items plus the open case's tabs), Cases (search and open), Preferences (theme, reduced motion, presentation mode,
  shortcuts), Advanced views, and global search results (debounced, grouped as today).
- Page title `"<Page> · CaseGuard AI"`, new favicon, one meta description, theme-color per theme.

## 4. Screen blueprints

Shared state patterns (a screen only lists what differs):

- **Loading:** skeletons shaped like the final layout (hero, cards, rows), region `aria-busy`, no page-level spinner.
- **Empty:** icon in a soft glow, what is empty, one line on why and what next, one primary action.
- **Error:** plain sentence (what happened), what to do, `Retry` (primary when the error is the whole screen) and a way out; reference id folded in "Details".
  Permission errors say which role grants access.
- **Success:** a toast of at most five seconds for background results (copied, saved, created); an inline success view
  when a flow finishes (analysis done: `Open review`).
- **Truncation and numbers:** long text clamps to 3 lines with "Show more"; numbers formatted with `formatNumber`; dates
  relative ("3 hours ago") with the exact UTC value in a tooltip.

| Screen                                                         | Purpose (one line)                                    | Primary action                             | Hero element                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Home `/`                                                       | Pick up where you left off and see what needs fixing. | **Add a case**                             | "Latest review" card: score ring, reason, "Open review".      |
| Cases `/cases`                                                 | Find a case and open its review.                      | **Add a case**                             | The clean table (card list on phones).                        |
| Add a case `/cases/new`                                        | Paste, upload or try a sample, then get the review.   | **Check case**, then **Create and review** | One large paste / drop area with a sample shortcut.           |
| Review                                                         | See how the case went and what to fix first.          | **Copy fix list**                          | Verdict (big score) beside the top three fixes.               |
| Score                                                          | See how the score was built and what would raise it.  | none (links back to Review)                | Score with its six dimensions as meters.                      |
| Evidence                                                       | Check what each claim is based on.                    | none (review in the drawer)                | Coverage bar of the eight categories, with the missing count. |
| What if                                                        | See how a safer path would have gone.                 | **Generate paths** (only when none exist)  | "What happened vs what could have happened" comparison.       |
| Timeline                                                       | See what happened and when.                           | none                                       | Event list with delay markers and the confidence chart.       |
| Possible causes                                                | Compare explanations and decide what to test next.    | none                                       | Leading cause with confidence; others as ranked rows.         |
| Case details                                                   | Read the facts and structure of the case.             | none                                       | Key facts card.                                               |
| Report                                                         | Share the review.                                     | **Print**                                  | The document.                                                 |
| Quality `/quality`                                             | See quality trends across all cases.                  | none                                       | Three stat cards and the quality-over-time chart.             |
| Skills `/skills`                                               | Reuse fixes that worked before.                       | none                                       | Skill card grid.                                              |
| Skill detail                                                   | Understand, trust and apply one skill.                | **Apply to a case** (when allowed)         | Lifecycle stepper and expected benefit.                       |
| Advanced `/advanced`                                           | Reach settings, audit and developer views.            | none                                       | Bento of six cards.                                           |
| Settings and audit, Usage and cost, System status, Guided demo | Admin and developer views.                            | per view (one at most)                     | A status summary card, then collapsed sections.               |

### 4.1 Home `/`

- **Order:** hero (2/3) "Latest review" of the active case: `ScoreRing` (Case Quality Index, ticker), band badge, one-line
  reason (top warning or leading hypothesis), `Open review`; beside it "Fix first" (top three warnings and missing
  evidence, severity badges). Then three `StatCard`s (Avoidable effort, Evidence integrity, Reasoning efficiency). Then
  "Recent cases" (five rows) and "Skills you could reuse" (three).
- **Collapsed:** "All seven metrics" accordion (the existing metric cards, restyled, definitions in tooltips); system
  health becomes a chip only when something is not healthy.
- **States:** empty (no cases) shows the three-step flow with `Add a case` and `Try a sample case`; no active case shows
  a case picker and the newest case; error and loading as shared.

### 4.2 Cases

- **Order:** one row: search, `Filters` (popover: analysis state, case status, workload, data label; shows a count),
  sort. Then the table: Case (reference, title), Score, Status, Avoidable effort, Opened (relative), row menu. Estimate
  caveat moves into the Score header tooltip. "Load more" is a ghost button.
- **States:** empty `No cases yet` (`Add a case`, `Try a sample case`); filtered-empty `No cases match` (`Clear filters`);
  delete confirms in a dialog and ends with a toast.

### 4.3 Add a case

- **Order:** three-dot progress (Add, Check, Review). Step 1: segmented control `Paste | Upload | Sample`; paste area
  (inline count and validation), drop zone, sample cards; "Details (optional)" folds title and workload; "More ways to
  add" folds the JSON bundle and the schema and example downloads. Step 2 "Check": what will be created plus three
  check rows (format, redaction, injection screening) with expandable detail; `Create and review`. Step 3: job progress,
  then success with `Open review` and `Add another case`.
- **States:** inline validation messages, refusal and retry-countdown states kept (existing logic), permission notice
  as the page's one notice.

### 4.4 Review

- **Order:** hero bento (Verdict 5/12, Top fixes 7/12), then Evidence summary, What would have changed the outcome
  (actual vs best alternative, time saved), Timeline strip. Fixes are an `AnimatedList` of at most three, each with a
  priority badge, one-line reason, expected gain, evidence chips (open the evidence drawer) and a copy button;
  "Show all N" expands.
- **Collapsed:** What went wrong (decision points), Reusable skills, Share (report actions), How this was calculated.
- **States:** not analysed shows `Run the review` (when permitted); a failing section shows a small inline error without
  breaking the others (existing isolation kept).

### 4.5 Score

- **Order:** score ring, band, one-line reason, "if every improvement were applied" chip; six dimension meters; what
  lowered the score; what would raise it. Secondary tabs: Effort and metrics, Warnings, Skills, Coaching, Compare.
  "What was known then" is a collapsed bar at the top (`?asOf=` kept).

### 4.6 Evidence

- **Order:** category coverage bar (click to filter), missing-evidence count; one row of search plus filters; clean
  claim rows (category badge, claim, source, review state); detail in a drawer (bottom sheet on phones); collapsed
  "What is still missing" and "What the record itself shows".

### 4.7 What if

- **Order:** persistent `Simulation, not history` badge (no banner); decision-moment picker (chips, earliest marked);
  comparison hero; strategy segmented control; tabs Compare, Evidence per step, Decision moment, Graph, Review; the
  no-hindsight check and the hindsight panel are collapsed. Graph keeps its accessible tables.

### 4.8 Timeline, Possible causes, Case details, Report

- **Timeline:** compact confidence chart above a virtualised event list; filters in one row plus a popover; event detail
  in a drawer. **Possible causes:** leading cause card, ranked rows with confidence meters, detail drawer, action ranking
  in an accordion. **Case details:** key facts first, digital-twin sections as accordions, manage actions in "More".
  **Report:** the printable document unchanged in content; toolbar restyled (Print primary).

### 4.9 Quality, Skills, Skill detail

- **Quality:** three stat cards (cases analysed, average score, avoidable effort) and the trend chart; the other panels
  in a bento below with tables folded; the case picker stays (and works without portfolio permission, as today).
- **Skills:** one row (search, status filter); card grid with status badge, success estimate and "used on N cases".
  **Skill detail:** lifecycle stepper on top, tabs Overview, Cases, Validation, Versions, Governance; the four banners
  become badges and tooltips.

### 4.10 Advanced and its views

- Hub as above. Each view gets `PageHeader` (breadcrumb Advanced >), a status summary card, then sections as
  accordions; long explanations move to tooltips; tables become borderless `DataTable`s; Governance keeps its section
  navigation (a segmented list on desktop, a select on phones) and every permission rule.

### 4.11 Status and first-visit screens

- **First visit (development identity):** product promise, the three steps, and five persona cards (name, role, one
  line); production shows `Sign in` instead. **Not found / error:** centered card with glow, `Go home` primary, `Browse
cases` secondary, error reference folded.

## 5. Plain language (technical terms only in tooltips)

| Today                                | New wording                                   | Tooltip (technical)                                              |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| Command Center                       | Home                                          |                                                                  |
| Ingest a case / Validate and preview | Add a case / Check case                       | Ingestion previews validation, redaction and injection screening |
| Guided Review                        | Review                                        |                                                                  |
| Case Quality Review (per case)       | Score                                         | Case Quality Index and its dimensions                            |
| Quality Review (portfolio)           | Quality                                       |                                                                  |
| Evidence Ledger                      | Evidence                                      | Claims classified into eight evidence categories                 |
| Counterfactual Lab / analysis        | What if / What would have changed the outcome | A simulated path using only what was known at the decision       |
| Hypothesis Arena                     | Possible causes                               | Competing hypotheses with model-estimated confidence             |
| Case Timeline                        | Timeline                                      |                                                                  |
| Digital twin                         | Case details                                  | Structured reconstruction of the case, traced to its sources     |
| SkillDNA Library / skill             | Skills / reusable fix                         | SkillDNA: a governed, reusable investigation plan                |
| Efficiency Monitor                   | Usage and cost                                | Token and compute estimates                                      |
| Governance                           | Settings and audit                            |                                                                  |
| System Health                        | System status                                 |                                                                  |
| Demo Guide                           | Guided demo                                   |                                                                  |
| Avoidable Support Effort             | Time that could have been saved               | Share of effort a better step would have avoided (estimate)      |
| Decision fork / decision point       | Key decision                                  | A moment where a better-supported step existed                   |
| Hindsight                            | Known only later                              |                                                                  |
| "What was known" time cursor / as-of | What was known then                           | Replays the case as it stood at an earlier moment                |
| Leak check                           | No-hindsight check                            | Proves the simulation used nothing from after the decision       |
| Provenance                           | Source                                        |                                                                  |
| Lifecycle state                      | Status                                        | Discovered, draft, tested, reviewed, pilot, validated, published |
| Persona / active case                | Signed in as / (removed)                      |                                                                  |
| Cohort                               | Cases in this view                            |                                                                  |
| Circuit breaker                      | Safety limit                                  | Stops model calls after repeated failures                        |
| Estimated / Synthetic                | Estimate / Demo data                          | Model estimate with a range, not a measurement / fictional data  |

Copy rules: sentence case, no exclamation marks, buttons are verbs of at most three words, no placeholder text, errors say
what happened and what to do, empty states say why and what next.

## 6. Design system

### 6.1 Colour tokens (single source: `tokens/palette.ts`; both themes verified by `contrast.test.ts`)

| Token (CSS var)              | Dark                              | Light                             | Use                                          |
| ---------------------------- | --------------------------------- | --------------------------------- | -------------------------------------------- |
| `cgCanvas`                   | `#131218`                         | `#F6F5FA`                         | page background                              |
| `cgSurface`                  | `#1B1B22`                         | `#FFFFFF`                         | cards                                        |
| `cgSurfaceRaised`            | `#23232C`                         | `#FFFFFF` + soft shadow           | popovers, hover, nested                      |
| `cgSurfaceSunken`            | `#0E0D12`                         | `#EEEDF4`                         | inputs, table header                         |
| `cgText` / Secondary / Muted | `#F5F4F7` / `#C9C7D2` / `#A3A1AD` | `#17151F` / `#454253` / `#5F5C6E` | text                                         |
| `cgBorderSubtle`             | `rgba(245,244,247,.08)`           | `rgba(23,21,31,.10)`              | card and divider lines                       |
| `cgBorderControl`            | `#7B7888`                         | `#7C7990`                         | input and button outlines (3:1, WCAG 1.4.11) |
| Accent (`cgToneBrand*`)      | solid `#7060E8`, fg `#B9AFFF`     | solid `#5B46D6`, fg `#4A36C4`     | the one accent: actions, focus, glow         |
| Glow (`cgGlow`)              | `rgba(112,96,232,.35)`            | `rgba(91,70,214,.18)`             | soft radial behind hero and primary button   |
| Glass (`cgGlass`)            | `rgba(27,27,34,.72)` + blur 12    | `rgba(255,255,255,.78)` + blur 12 | cards, header, dialogs                       |
| Success / Warning / Danger   | `#35B277` / `#DCAA3F` / `#D43A40` | `#1A8052` / `#B97E0B` / `#D13C42` | **status only**                              |

The twelve existing tone names stay (call sites keep compiling) but are remapped: `brand`, `fork`, `hypothesis`,
`simulated`, `skill` use the accent; `evidence`, `missing`, `actual`, `neutral` use neutrals; `productive`, `uncertain`,
`unsupported` use green, amber, red. Chart series use accent and neutral steps only, always with a dash or marker.

### 6.2 Type, space, radius, depth, layout

| Group  | Tokens                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type   | Geist Variable, Geist Mono. Display 48/1.05, h1 30/1.15, h2 22/1.25, h3 18/1.3, body 15/1.55, caption 13/1.4. Headings tracking -0.02em; scores `tabular-nums`.                        |
| Space  | 8 px grid: 4 (half step), 8, 12 (half step), 16, 24, 32, 40, 48, 64. Page padding 32 desktop, 16 phone. Card padding 32 hero, 24 default, 16 compact.                                  |
| Radius | 8 (chips, small controls), 12 (buttons, inputs), 16 (cards), 24 (hero, dialogs); pill only for badges and avatars.                                                                     |
| Depth  | Glass cards (translucent surface, 1 px subtle border, 12 px blur, 1 px inner top highlight), a soft accent glow behind the hero and the key result; no heavy shadow; no table borders. |
| Layout | Sidebar 208, rail 72, bottom bar 64 (+ safe area), top bar 56, content max 1200, bento 12 columns, gap 16 (24 on wide).                                                                |
| Icons  | lucide, stroke 1.75, 16 / 20 / 24, `aria-hidden` unless alone (then a label).                                                                                                          |

### 6.3 Motion (Motion library plus CSS; every item is off under reduced motion)

| Motion                           | Where                      | Duration / easing                      | Rules                                                              |
| -------------------------------- | -------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Blur-fade on load                | page sections, bento cards | 250 ms ease-out, 40 ms stagger (max 6) | CSS keyframes (visible without JS); opacity, 8 px rise, 6 px blur. |
| Number ticker                    | scores, stat values        | 300 ms ease-out, once on first view    | Final value is in the DOM; reduced motion shows it immediately.    |
| Glint                            | the single primary button  | one 300 ms sweep on hover or focus     | Never loops; no other element has it.                              |
| Score ring draw                  | `ScoreRing`                | 300 ms ease-out                        | Stroke only.                                                       |
| Hover lift                       | interactive cards          | 150 ms, -2 px and a brighter border    | Non-interactive cards do not lift.                                 |
| List add, remove, reorder        | `AnimatedList`             | 200 ms ease-out                        | Layout animation only; no bounce.                                  |
| Tabs indicator                   | `Tabs`, `TabNav`           | 200 ms ease-out                        |                                                                    |
| Accordion, drawer, dialog, toast | overlays                   | 200 ms ease-out                        | Fluent's own motion tokens are set to the same durations.          |
| Skeleton shimmer                 | loading placeholders only  | gentle, ends with the request          | The one allowed repeat; never on content.                          |

Nothing blocks a task, nothing loops on content, nothing is longer than 300 ms (the skeleton is the exception above).
Reduced motion (OS setting or the in-app override) removes every item and shows final states.

### 6.4 Components

| Component                                              | Lives in                   | Built on                                          | Notes                                                                               |
| ------------------------------------------------------ | -------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Button (primary, secondary, ghost, danger), IconButton | `ui/kit`                   | native button + Griffel                           | sm / md / lg, loading; 44 px target on coarse pointers; `IconButton` needs a label. |
| Card, BentoGrid                                        | `ui/kit`                   | div, CSS grid                                     | glass; `interactive` lifts; 12 columns, spans collapse at 900 and 600 px.           |
| StatCard, ScoreRing (verdict)                          | `ui/kit`, `ui/charts`      | SVG, NumberTicker                                 | status colour plus icon plus word; text alternative.                                |
| Badge (+ `StatusBadge`, `ProvenanceBadge`)             | `ui/kit`, `ui/primitives`  | span                                              | tones: neutral, accent, success, warning, danger; always icon plus label.           |
| Tabs, TabNav, SegmentedControl                         | `ui/kit`                   | ARIA tabs with roving tabindex; links; radiogroup | `TabNav` uses real links.                                                           |
| Accordion                                              | `ui/kit`                   | button + region + Motion height                   |                                                                                     |
| Dialog, Drawer                                         | `ui/kit`                   | Fluent Dialog, OverlayDrawer                      | glass surface; focus trap and return come from Fluent.                              |
| Tooltip, InfoTip                                       | `ui/kit`                   | Fluent Tooltip, Popover                           | the only place technical terms live.                                                |
| Toast                                                  | `web/lib/toast` (restyled) | existing provider                                 | polite for success, assertive for errors.                                           |
| Skeleton, EmptyState, ErrorState                       | `ui/kit`, `ui/primitives`  | span, div                                         | existing APIs kept.                                                                 |
| CommandPalette                                         | `web/lib/command-palette`  | cmdk in a Dialog                                  | keeps the existing command registry and tests' intent.                              |
| AnimatedList, BlurFade, NumberTicker                   | `ui/motion`                | Motion, CSS                                       | reduced-motion aware.                                                               |
| DataTable                                              | `ui/primitives`            | Fluent Table                                      | borderless, sticky header, row hover; API kept.                                     |
| Input, Select, Textarea, Field                         | `ui/kit`                   | native elements in one frame                      | radius 12, 44 px on coarse pointers; `Field` wires label, hint and error.           |
| ThemeToggle, Logo                                      | `ui/kit`                   | `useThemeMode`, SVG                               | light, dark, system; persisted cookie, no flash (existing mechanism).               |
| AppShell, Sidebar, BottomBar, TopBar                   | `web/components/shell`     | kit parts                                         | five items; skip link and landmarks kept.                                           |
| PageHeader                                             | `ui/primitives`            | kit parts                                         | title, one-line purpose, one primary action, breadcrumb only where depth exists.    |

## 7. Quality gates

- WCAG 2.2 AA in both themes (existing pair test, extended), visible focus rings, `aria-label` on every icon-only control,
  heading order, 44 px touch targets on phones, reduced motion, keyboard-only traversal, axe clean (serious and critical).
- No horizontal scroll or overlap at 375, 768, 1024, 1440 and 1920; no layout shift on theme load.
- Unit tests change only where copy or structure changed and keep their strength; e2e flows are updated, not removed.
- Scores 1 to 10 per screen on clarity in five seconds, hierarchy, spacing, contrast, token consistency, mobile layout and
  polish; anything under 9 is fixed and re-shot, over at least two review passes (recorded in `PROGRESS.md`).

## 8. Out of scope (needs backend work; listed for the final report)

Per-fix "mark as done" that persists, case owners and assignment, shareable links with expiry, notifications, server-side
sort by score, per-user saved filters. The UI uses only existing endpoints: `samples.list` powers "Try a sample case".

## 9. As built (where the finished screens differ from the blueprint, and why)

**Flow and navigation.** As specified: Add a case, See the review, Fix what matters; five navigation items; one Advanced
hub. A case has the tabs Review, Score, Evidence, What if and Timeline, with Possible causes, Case details and Report under
"More". On a phone the tab strip scrolls on its own, brings the selected tab into view, and keeps "More" pinned at its end.

| Screen                              | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First visit                         | The promise, the three steps and the demo people as cards picked with one click (the dialog stays as a fallback). The sign-in button in the top bar is an icon button on a phone.                                                                                                                                                                                                                                                                                                                                      |
| Home                                | Latest review (ring, one-line reason, Open review) beside "Fix first", three key numbers, recent cases, skills you could reuse; every other metric folded under "All metrics". The ring uses the same band words as the Review and Score pages (Strong, Adequate, Poor). "Add a case" in the header is the primary action for people who can add one; for everyone else "Open review" is. The three steps are a row of three on a phone, so the score is on the first screen.                                          |
| Cases                               | One toolbar row (search, Filters popover with a count, sort), a borderless table with relative dates, a card list on phones.                                                                                                                                                                                                                                                                                                                                                                                           |
| Add a case                          | Three phases (Add, Check, Create) instead of four steps; the default source is Paste; `?source=sample` opens the sample choice (UI only); the check runs the same pipeline as the create.                                                                                                                                                                                                                                                                                                                              |
| Review                              | Verdict ring and one-line reason beside the first three fixes (6/6 columns: the 5/7 split of the blueprint made the ring wrap above its text); "Copy fix list" is the one primary action; What went wrong and What to learn start closed. In What happened the swim-lane strip is shown and its text alternative (the key events and waits in words) sits in a closed disclosure on wide screens, which keeps the page at about 5,400 px instead of 7,900; on a phone, where the strip is not drawn, the list is open. |
| Score                               | Ring, six meters with plain names, "What lowered the score" and "What would raise it" as short animated lists; five tabs underneath. The "What was known then" bar starts open only when `?asOf=` is set.                                                                                                                                                                                                                                                                                                              |
| Evidence, Timeline, Possible causes | A coverage bar, a chart hero and a "most likely cause" hero respectively; filters in one popover; details in a drawer; a shared collapsed "What was known then" bar. Exact UTC date-times stay on the Timeline (a timeline needs the time of day).                                                                                                                                                                                                                                                                     |
| What if                             | The outcome in one number (time that could have been saved, with its range, Estimated and Simulated), a key decision picker, strategies as a segmented choice, kit tabs for the detail; the no-hindsight check and "Known only later" are folded.                                                                                                                                                                                                                                                                      |
| Report, Case details                | The report document and its print rules are unchanged (a sheet on screen, Print is the primary action); Case details opens on the key facts, with refresh, re-run and delete behind one "Manage case" menu.                                                                                                                                                                                                                                                                                                            |
| Quality, Skills                     | Three stat cards, the trend chart and folded tables; a card grid for skills, and a skill page with its status, benefit and one action.                                                                                                                                                                                                                                                                                                                                                                                 |
| Advanced views                      | A summary card first (setup, spend, system status, demo progress) and folded sections after it; tables become card lists on phones. Nothing the old pages could do was removed.                                                                                                                                                                                                                                                                                                                                        |

**Data the API does not have (UI shows an honest gap, nothing was added).** The portfolio has no avoidable-effort figure, so
the third Quality stat card uses the average of the waiting-time pattern and shows a dash when it is absent. A skill's success
has no confidence range, so none is drawn. Fixes cannot be marked as done or assigned (section 8).

**One word left as it was.** The Review and the Report say "decision point" (their own plain word, also in the printed
document and in about sixty assertions); the other case pages say "key decision". Both are plain language and the
Review links name their destination, so nothing was renamed in the document that people print and keep.

**Kit gaps worked around.** `DataTable` ignores column widths in a fixed layout; `BarChart` picks half-step ticks for tiny
integer ranges (the page formats counts itself); there is no vertical tab list, filter popover or toggle chip in the kit (the
Evidence filter popover is local and Timeline reuses it); a menu and a checkbox are the Fluent ones.

**Rules that are now enforced by a test** (`apps/web/src/design-tokens.test.ts`): no colour literal outside the token files
(the printed report keeps one paper palette), the pre-hydration page colours in `globals.css` equal the palette, and no fixed
gap, padding, margin or corner radius in any component (the investigation graph is laid out in SVG units and is exempt).

**Touch and keyboard.** Controls on a coarse pointer are at least 44 px (links, summaries, chips, switches, checkbox rows,
"Show more" and the report's contents included); a form control fills its whole frame (46 px on a touch screen, so the field
inside it is 44) and a tap anywhere in it focuses the field; the top-bar search button takes its name from its visible text
and carries `aria-keyshortcuts`. The one exception is the small event marks that the Timeline chart draws (24 by 17 px):
each event also has a full-size row, which is the equivalent control.

**Reflow.** No page scrolls sideways from 320 to 1920 px. At 320 px the page header's actions can shrink to their row, the top
bar tightens its padding and gaps, and the "Demo data" pill reads "Demo" (its accessible name is unchanged). Home's delta arrows
point the way the number moved (the colour says whether that is good), so an arrow never contradicts the words beside it.

**Small differences kept on purpose.** The guided review's inline disclosures ("Assumptions", "The simulated steps") are native
`details` elements with a triangle, beside the kit accordions with a chevron; four "shorten and expand" text components from
separate features (line clamp and character limit) have not been merged; a few small buttons are still Fluent's. They are
listed so that a later change can merge them.
