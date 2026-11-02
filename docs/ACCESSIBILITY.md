# Accessibility

What was done to check that CaseGuard AI can be used without a mouse, with assistive technology and in both themes, what is
automated, what is not, and what is still open. Every count below comes from the run described in [TESTING.md](TESTING.md#2-the-last-full-run);
nothing here is a conformance claim.

**Position, stated plainly: the automated checks pass; this is not a certification.** The target is WCAG 2.1 level AA
(requirement NFR-A11Y-01). Automated rules (axe-core) report **zero violations** on every page and state listed in section 3, in
the light and the dark theme, at 1440x900 and (for the key pages) at 390x844. **No screen reader was run, no person who uses
assistive technology was involved, and no accessibility audit by a specialist was done.** Automated rules can only judge part of
WCAG; the rest (meaningful names and text alternatives, sensible reading and focus order, clear language, cognitive load) needs a
human. Treat the result as a floor, not as proof of conformance.

Related: [apps/web/README.md](../apps/web/README.md#accessibility-checklist-every-page) (the checklist every page follows),
[TESTING.md](TESTING.md), [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 1. What is automated

All of it lives in `e2e/a11y.spec.ts` (and the `mobile`, `theme` and per-page specs for the related behaviour) and runs in
`pnpm test:e2e` against the **production build** of the web app, in Microsoft Edge (Chromium) locally and the bundled Chromium in CI.
**The guided review and the report** have their own scans in `e2e/pages/review.spec.ts`, added with them: both pages in the light and
the dark theme, each at 1440x900 and then at 390x844 (eight scans), the evidence drawer open on a verified quotation (with a Tab
loop that must stay inside it and Escape to close), and the keyboard path from a recommendation to the source passage and back.
`e2e/mobile.spec.ts` checks that neither page, nor the review of the second case, scrolls sideways at 390x844.

| Check                        | How                                                                                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules                        | `@axe-core/playwright` 4.14.0 (axe-core 4.14.0) with the tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `best-practice`. Only `violations` are asserted: the list must be empty                                   |
| Pages                        | Sixteen views (the twelve pages, the ingestion wizard, the case overview, the portfolio quality page and the skill detail), each as the persona that normally uses it, at 1440x900, in the light and in the dark theme |
| Phones                       | The six key pages (Command Center, Cases, Case Timeline, Counterfactual Lab, Efficiency Monitor, Demo Guide) at 390x844 with touch, in both themes                                                                     |
| States behind a click or URL | Every tab or section of the pages that have them, an open side panel, an earlier moment with an event open, the wizard's preview step, Presentation Mode, the no-identity, not-found and missing-permission states     |
| Open overlays                | The command palette, the keyboard shortcuts dialog, the persona picker and the phone navigation drawer                                                                                                                 |
| Keyboard, no pointer         | Section 2                                                                                                                                                                                                              |
| Motion                       | The system preference `prefers-reduced-motion` and the in-app "Reduce motion" setting, section 2                                                                                                                       |

**The only exclusion** is `[data-tabster-dummy]`: Fluent UI's focus-trap sentinels, inert `<i tabindex="0" aria-hidden="true">`
elements that redirect focus when a dialog or popover traps it. axe reports them as hidden-but-focusable, nobody can operate them,
and they are not content. Nothing else is excluded, no rule is disabled and no page is skipped.

**What the scans do not look at.** `incomplete` results ("needs review": for example colour contrast over a background that axe
cannot compute) are not asserted and were not reviewed one by one. Content that appears only after an interaction that no test
performs is not scanned.

## 2. What was checked with the keyboard

These are tests, not a manual walk-through; each one drives the real page with `page.keyboard` only.

| Path                                                                                                                                                                                                      | Result                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| The first Tab lands on "Skip to main content", the link is visibly focused, Enter moves focus to `#main-content`                                                                                          | passes (`a11y.spec.ts`)             |
| Tab walks the header and the navigation (14 stops) in a sensible order and **every stop changes the pixels around it** (a visible focus indicator, measured, not assumed)                                 | passes                              |
| A navigation link is operable by keyboard and focus lands in the new page                                                                                                                                 | passes                              |
| The command palette opens with Ctrl+K, takes focus into its search, closes with Escape and returns focus to the control that had it; a command navigates                                                  | passes                              |
| `g` then a letter navigates, `?` opens the shortcuts, and the shortcuts stay quiet while typing in a field                                                                                                | passes                              |
| A dialog traps focus for 12 consecutive Tab presses and gives focus back when it closes (the persona picker; the focus-return defect this test found is in section 5)                                     | passes                              |
| The Counterfactual Lab tabs: arrow keys move, Enter selects                                                                                                                                               | passes                              |
| The investigation graph: one Tab stop enters it, arrow keys move between nodes, Enter selects, Escape clears; every node has an accessible name; the same graph is available as tables without the canvas | passes                              |
| The Case Timeline slider moves with Home and End, and the page names the moment it shows                                                                                                                  | passes (`pages/timeline.spec.ts`)   |
| Governance sections move with `]` and `[`                                                                                                                                                                 | passes (`pages/governance.spec.ts`) |
| The phone navigation drawer: scanned open; Escape closes it and focus returns to its button                                                                                                               | passes                              |
| `prefers-reduced-motion: reduce` cuts an infinite animation to one run, and leaves it alone otherwise; the "Reduce motion" setting does the same and survives a reload                                    | passes                              |

Other behaviours that matter to assistive technology and are asserted in the page specs (by role and accessible name, never by
CSS): live regions announce results (`role="status"`), errors are `role="alert"` and carry the request id, a disabled-but-
focusable control explains the missing permission when focused, and tables, charts and the graph have names and text
alternatives.

## 3. What was scanned, with the numbers

From the second full run (production build, Microsoft Edge 156, one worker; [TESTING.md](TESTING.md#2-the-last-full-run)): the
whole of `a11y.spec.ts` ran in 14 minutes and **all 128 tests passed**.

| Group                                      |   Tests | axe analyses | Violations |
| ------------------------------------------ | ------: | -----------: | ---------: |
| The sixteen views, 1440x900, light theme   |      16 |           16 |          0 |
| The sixteen views, 1440x900, dark theme    |      16 |           16 |          0 |
| The six key pages, 390x844, light theme    |       6 |            6 |          0 |
| The six key pages, 390x844, dark theme     |       6 |            6 |          0 |
| 36 states behind a click or URL, light     |      36 |           36 |          0 |
| 36 states behind a click or URL, dark      |      36 |           36 |          0 |
| Open overlays (palette, shortcuts, picker) |       1 |            3 |          0 |
| The open phone navigation drawer           |       1 |            1 |          0 |
| Keyboard-only paths (section 2)            |       8 |            - |          - |
| Reduced motion (section 2)                 |       2 |            - |          - |
| **Total**                                  | **128** |      **120** |      **0** |

**What axe could not decide.** A separate, one-off run of the same rules over the sixteen views in both themes (32 scans; a
throw-away script, not part of the suite) counted the "incomplete" results that the suite does not assert. There were 0 violations
again and **454 incomplete nodes, all of the rule `color-contrast`**: text that axe cannot measure because it sits on a chart, a
hatched range or an overlapping graphic. They are on six views and are the same in both themes: Case Timeline 21, Hypothesis Arena
26, Counterfactual Lab 125, Case Quality Review 2, Quality Review (portfolio) 49 and Efficiency Monitor 4 nodes per theme. Nobody
has measured those 227 nodes per theme by hand; the colour pairs of the design tokens are unit-tested for WCAG AA in both themes
([apps/web/README.md](../apps/web/README.md#testing)), which covers text drawn in token colours but not what it is drawn over.

## 4. What was not done

Said plainly, so that nobody reads the result as more than it is.

- **No screen reader.** NVDA, JAWS, Narrator, VoiceOver and TalkBack were not run. Names, roles and live regions are checked by
  Playwright's accessibility tree and axe, which is not the same as listening to the page.
- **No real users.** Nobody who relies on assistive technology tried the product.
- **No audit by an accessibility specialist** and no VPAT or conformance report.
- **Not tested:** WCAG 2.2 (target size 2.5.8, dragging 2.5.7, consistent help 3.2.6 and the rest), 320 CSS px reflow and 400 %
  zoom (the phone checks use 390 px), text-spacing overrides, Windows forced-colours (high contrast) mode, voice control, switch
  access, and printing (apart from the report's print stylesheet, which is checked in Chromium's print emulation and a PDF render:
  no application chrome, page breaks, the address of every link, not a printed page).
- **Engines:** only Chromium (Microsoft Edge locally, the bundled Chromium in CI). Firefox and Safari were not run.
- **The development identity picker** is a local-only control; it was scanned and its keyboard behaviour tested, but the production
  sign-in (Microsoft Entra, a redirect flow outside the product) was not.
- **Content correctness** is not judged: that an explanation is understandable, or that a chart's text alternative says the right
  thing, is a human review.

## 5. Findings

The accessibility work found real defects. Each fix is small, local and covered by a unit test; the end-to-end test that found it
passes against the fix.

| Finding                                                                                                                                                                                                                                                                                       | WCAG                             | Status                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focus was lost (it fell to the page body) after closing a controlled dialog: the command palette, the keyboard shortcuts, the phone navigation drawer and the persona picker. Fluent restores focus only to a trigger it renders, and a dialog opened from a menu item or a shortcut has none | 2.4.3 Focus Order                | **Fixed.** `apps/web/src/lib/use-overlay-state.ts` remembers the opener and falls back to the account button, then the main region; unit test `use-overlay-state.test.tsx`                                                                                                                                                                                                                                          |
| In the persona picker the muted lines of the chosen option had a contrast of 1.4:1 against the selected background                                                                                                                                                                            | 1.4.3 Contrast                   | **Fixed.** `apps/web/src/lib/auth/dev-persona.tsx` (the lines inherit the on-brand colour); a unit test guards it                                                                                                                                                                                                                                                                                                   |
| The Command Center metric cards read the trend twice ("+63.1 +63.1 points compared with ..."), noise for a screen-reader user                                                                                                                                                                 | 1.3.1 / readability              | **Fixed in the component.** `packages/ui/src/primitives/MetricCard.tsx` (`trendText`) drops a repeated delta; unit test `metric-trend.test.tsx`. The API still embeds the delta in its label, see [TESTING.md](TESTING.md#7-findings)                                                                                                                                                                               |
| An unknown case id on the Case Timeline and the Evidence Ledger showed an error alert **and** a loading skeleton that stayed `aria-busy` for ever, while the Overview and Quality pages showed a proper "not found"                                                                           | 4.1.3 / 3.3.1                    | **Fixed.** `apps/web/src/components/case/CaseNotFoundState.tsx` (new) is returned by `TimelinePage.tsx` and `EvidenceLedgerPage.tsx` when the case is not found; unit tests in `timeline.test.tsx` and `evidence.test.tsx` (both fail without the fix). The Hypothesis Arena and the Counterfactual Lab still show a generic error with a Retry that cannot succeed (open, see [TESTING.md](TESTING.md#7-findings)) |
| The URL-synced search fields (Cases, SkillDNA Library and others that keep their text in the address) can drop characters typed with no pause between them (dictation, assistive input)                                                                                                       | 2.1.1 / 3.3.x                    | **Open.** Reproduction in [TESTING.md](TESTING.md#7-findings)                                                                                                                                                                                                                                                                                                                                                       |
| The decision-marker circles on the timeline and hypothesis charts overlap slightly where two decisions are close                                                                                                                                                                              | 1.4.11 (cosmetic)                | **Open**, visual only; the markers are also listed as text                                                                                                                                                                                                                                                                                                                                                          |
| The "and N more" evidence chip and the link at a decision point of the guided review were named by a sentence that did not begin with the words on the control, so a voice command that says what is shown ("and 11 more") did not match                                                      | 2.5.3 Label in Name              | **Fixed.** `evidence/EvidenceChips.tsx` and `sections/DecisionsSection.tsx` name them "and 11 more: show the other evidence for ..." and "Open in the Counterfactual Lab: decision point 1"; found by the axe scan of the review                                                                                                                                                                                    |
| The chronology strip of the report scrolls sideways on a phone but could not be reached from the keyboard                                                                                                                                                                                     | 2.1.1 Keyboard                   | **Fixed.** `report/ReportDocument.tsx` makes it a named, focusable region ("Chronology strip, scrollable") with a visible focus outline; found by the axe scan of the report at 390 px                                                                                                                                                                                                                              |
| The score ring of the verdict said "Needs attention" while the badge beside it said "Poor", two words for one quality band                                                                                                                                                                    | readability (not a WCAG failure) | **Fixed.** `ScoreRing` takes the page's own word (`statusLabel`) and the verdict passes the band's                                                                                                                                                                                                                                                                                                                  |

## 6. Run it

```powershell
pnpm.cmd test:e2e                                   # the whole suite, accessibility included
pnpm.cmd exec playwright test e2e/a11y.spec.ts --project=desktop              # every scan and keyboard path
pnpm.cmd exec playwright test e2e/a11y.spec.ts --project=desktop -g "dark . 1440x900 . Governance"
pnpm.cmd exec playwright test e2e/mobile.spec.ts --project=mobile             # 390x844: no horizontal overflow, drawer, tables
```

To cover a new page or state, add it to `PAGES` or `STATES` in `e2e/a11y.spec.ts`. A failing scan prints the rule, its impact, the
selector of up to four nodes and axe's own failure summary. Fix the product, never the rule set; if a justified exclusion is ever
needed, add it to the single `exclude` call and to section 1 above.
