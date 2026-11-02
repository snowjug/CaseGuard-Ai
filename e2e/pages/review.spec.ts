import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { listCases } from '../support/api';
import { expect, test, type ThemeMode } from '../support/fixtures';
import { toast } from '../support/flows';
import { mainRegion, navLink, openPage, primaryNav, settle } from '../support/ui';

/**
 * The guided review (`/cases/[caseId]/review`) and the report (`/cases/[caseId]/report`): one journey from the verdict to
 * what to do next, evidence one interaction away, sections that degrade on their own, and a report that reads, prints,
 * copies and downloads. Every figure is compared with what the API says for the seeded demo (Case One is the costly
 * investigation with nine decision points, Case Two the efficient one).
 */

interface Fork {
  id: string;
  title: string;
  isEarliestMeaningful: boolean;
}

interface Quality {
  compositeScore: number;
  compositeLow: number;
  compositeHigh: number;
}

const SECTIONS = [
  'Verdict',
  'Chronology',
  'What went wrong',
  'What should have happened',
  'Next actions',
  'Learning',
  'Share',
] as const;

const REPORT_SECTIONS = [
  'Verdict',
  'Chronology',
  'The earliest important missed moment',
  'The recorded path',
  'The better-supported path',
  'Recommendations backed by evidence',
  'Reusable learning',
  'Uncertainty and how this was calculated',
  'Review and approval',
] as const;

const section = (page: Page, name: string | RegExp) =>
  // A string name is a substring match by default, and "Chronology" is also part of "Chronology strip, scrollable".
  page.getByRole('region', typeof name === 'string' ? { name, exact: true } : { name });

test.describe('[FR-REV-01] the guided review reads the case from the verdict to what to do next', () => {
  test('has seven named sections in reading order, with a section navigation that moves focus', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    await expect(page.getByRole('heading', { level: 1, name: 'Guided review' })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Sections of the guided review' });
    await expect(nav.getByRole('link')).toHaveText([...SECTIONS]);
    for (const name of SECTIONS) {
      await expect(section(page, name), name).toBeVisible();
    }
    await expect(mainRegion(page).getByRole('heading', { level: 2 })).toHaveText([...SECTIONS]);

    await nav.getByRole('link', { name: 'Learning' }).click();
    await expect(section(page, 'Learning')).toBeFocused();
    await expect(nav.getByRole('link', { name: 'Learning' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  test('the verdict equals the API: the band, the score with its range as an estimate, and the earliest missed moment', async ({
    page,
    demo,
    api,
  }) => {
    const engineer = api('engineer');
    const quality = await engineer.getOk<Quality>(`/cases/${demo.caseOneId}/quality`);
    const forks = await engineer.getOk<{ items: Fork[] }>(`/cases/${demo.caseOneId}/forks`);
    const earliest = forks.items.find((fork) => fork.isEarliestMeaningful);
    expect(earliest, 'Case One has an earliest important decision point').toBeDefined();

    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const verdict = section(page, 'Verdict');
    await expect(verdict).toContainText(
      `about ${Math.round(quality.compositeScore)} out of 100 (plausible range ${Math.round(quality.compositeLow)} to ${Math.round(quality.compositeHigh)})`,
    );
    await expect(verdict).toContainText('This is an estimate.');
    await expect(verdict.getByText('Estimated').first()).toBeVisible();
    await expect(
      verdict.getByRole('heading', { level: 3, name: 'The earliest important missed moment' }),
    ).toBeVisible();
    await expect(verdict).toContainText(earliest!.title);
    await expect(verdict).toContainText('What was done');
    await expect(verdict).toContainText('What was already known');
  });

  test('the chronology has a picture with a text alternative, the key events with their lanes and the waits in words', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const chronology = section(page, 'Chronology');
    await expect(chronology.getByRole('img', { name: /^Chronology strip\./ })).toBeVisible();
    const list = chronology.getByRole('list', { name: /^Key events and waits/ });
    await expect(list).toBeVisible();
    await expect(list.getByText(/^The (customer|engineer) waited .+ for /).first()).toBeVisible();
    await expect(list.getByRole('link', { name: /^Show in timeline:/ }).first()).toHaveAttribute(
      'href',
      new RegExp(`/cases/${demo.caseOneId}/timeline\\?sel=`),
    );
    await expect(chronology.getByRole('link', { name: 'Open the full timeline' })).toBeVisible();
  });

  test('what went wrong explains the first decision points and offers the rest', async ({
    page,
    demo,
    api,
  }) => {
    const forks = await api('engineer').getOk<{ items: Fork[] }>(`/cases/${demo.caseOneId}/forks`);
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const wrong = section(page, 'What went wrong');
    const list = wrong.getByRole('list', { name: 'Decision points' });
    await expect(list.getByRole('article')).toHaveCount(3);
    const first = list.getByRole('article').first();
    for (const name of [
      'What was known then',
      'What was not yet known',
      'What was done',
      'A better-supported step',
    ]) {
      await expect(first.getByRole('heading', { level: 4, name }), name).toBeVisible();
    }
    const rest = forks.items.length - 3;
    await wrong.getByRole('button', { name: `Show ${rest} more decision points` }).click();
    await expect(list.getByRole('article')).toHaveCount(forks.items.length);
  });

  test('what should have happened is labelled a simulated estimate, with ranges, confidence and assumptions', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const paths = section(page, 'What should have happened');
    await expect(paths.getByText('Simulated estimate').first()).toBeVisible();
    await expect(
      paths.getByRole('table', {
        name: 'The recorded path and the better-supported path (simulated estimate)',
      }),
    ).toBeVisible();
    await expect(paths).toContainText(/(Low|Medium|High) confidence/);
    await expect(paths.getByText(/^Assumptions \(\d+\)$/)).toBeVisible();
    await expect(paths.getByRole('link', { name: 'Open in the Counterfactual Lab' })).toBeVisible();
  });

  test('next actions are one ranked list, each with its reason and either evidence or the general-guidance label', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const actions = section(page, 'Next actions');
    const list = actions.getByRole('list', { name: 'Ranked recommendations' });
    await expect(list.getByRole('article').first()).toBeVisible();
    await expect(list.getByRole('heading', { level: 3 }).first()).toBeVisible();
    await expect(
      list.getByRole('button', { name: /^(Statement|Message or event):/ }).first(),
    ).toBeVisible();
    await expect(actions).toContainText(/Warnings: \d+ open, \d+ resolved, \d+ dismissed\./);
  });

  test('case two says "General guidance" where there is no case-specific evidence, and that no decision point stood out', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseTwoId}/review`);
    await expect(section(page, 'What went wrong')).toContainText('No decision point stood out');
    await expect(section(page, 'What should have happened')).toContainText('Nothing to compare');
    await expect(section(page, 'Next actions')).toContainText(
      'General guidance — no case-specific evidence',
    );
  });

  test('learning shows the matching skill with the recorded and with-skill figures, and says skills stay drafts', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const learning = section(page, 'Learning');
    await expect(
      learning.getByRole('heading', { level: 3, name: /^This resembles / }),
    ).toBeVisible();
    await expect(
      learning.getByRole('table', {
        name: 'Recorded against with the skill (estimates worked out by the server)',
      }),
    ).toBeVisible();
    await expect(learning).toContainText('Skills stay drafts until a curator approves them.');
  });

  test('every section and the whole review have a "How this was calculated" note in plain language', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    for (const name of SECTIONS.filter((item) => item !== 'Share')) {
      await expect(section(page, name).getByText('How this was calculated'), name).toBeVisible();
    }
    const overall = page.getByText('How this whole review was calculated');
    await overall.click();
    // Every section carries a note of its own, closed until asked for: the one that opened is the one that shows.
    await expect(
      page
        .getByText(/decision support for a human review/i)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expect(mainRegion(page)).not.toContainText(/CQI|SkillDNA|claims ledger/);
  });
});

test.describe('[FR-REV-02] evidence is one interaction away, and checked against the stored message', () => {
  test('from a recommendation to the source passage, by keyboard, and back to where the person was', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const chip = section(page, 'Next actions')
      .getByRole('list', { name: 'Ranked recommendations' })
      .getByRole('button', { name: /^Statement:/ })
      .first();
    await chip.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Evidence' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Checked against the stored message').first()).toBeVisible();
    await expect(drawer.locator('blockquote mark').first()).toBeVisible();
    await expect(page).toHaveURL(/[?&]evidence=claim%3A/);

    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(chip).toBeFocused();
    await expect(page).not.toHaveURL(/evidence=/);
  });

  test('"Show in timeline" opens the event, and Back returns to the review with the drawer open', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    await section(page, 'Next actions')
      .getByRole('button', { name: /^Statement:/ })
      .first()
      .click();
    const drawer = page.getByRole('dialog', { name: 'Evidence' });
    await drawer.getByRole('link', { name: 'Show in timeline' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/cases/${demo.caseOneId}/timeline\\?sel=`));
    await settle(page);
    await page.goBack();
    await expect(page.getByRole('dialog', { name: 'Evidence' })).toBeVisible();
  });

  test('an address that names an item opens the drawer on it, and an address that names nothing real says so', async ({
    page,
    demo,
    api,
  }) => {
    const ledger = await api('engineer').getOk<{ items: { id: string }[] }>(
      `/cases/${demo.caseOneId}/evidence`,
      { query: { limit: 1 } },
    );
    const claim = ledger.items[0];
    expect(claim, 'Case One has claims').toBeDefined();
    await openPage(
      page,
      `/cases/${demo.caseOneId}/review?evidence=${encodeURIComponent(`claim:${claim!.id}`)}`,
    );
    await expect(page.getByRole('dialog', { name: 'Evidence' })).toBeVisible();
    await page.keyboard.press('Escape');

    await openPage(
      page,
      `/cases/${demo.caseOneId}/review?evidence=${encodeURIComponent('claim:clm_does_not_exist')}`,
    );
    const drawer = page.getByRole('dialog', { name: 'Evidence' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Not found')).toBeVisible();
  });
});

test.describe('[FR-REV-03] a section the role may not read degrades on its own', () => {
  test.use({ persona: 'curator' });

  test('a skill curator has no case quality: the verdict says so, nothing is requested, and the rest of the review works', async ({
    page,
    demo,
  }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(new URL(request.url()).pathname));
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const verdict = section(page, 'Verdict');
    await expect(verdict.getByText('Not shown').first()).toBeVisible();
    await expect(verdict).toContainText('does not include the “quality:read” permission');
    await expect(
      verdict.getByRole('heading', { level: 3, name: 'The earliest important missed moment' }),
    ).toBeVisible();
    await expect(
      section(page, 'Chronology').getByRole('list', { name: /^Key events and waits/ }),
    ).toBeVisible();
    await expect(section(page, 'Learning')).toContainText('This resembles');
    // The role is told what it lacks; the page does not provoke a refusal to find out.
    // The side navigation prefetches the Quality Review page, so only the API's own paths count here.
    expect(
      requested.filter((path) => /^\/api\/.+\/(quality|coaching|metrics)$/.test(path)),
    ).toEqual([]);
  });

  test('the report leaves out the verdict with an explicit note instead of failing', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/report`);
    const top = section(page, 'Left out of this report');
    await expect(top).toContainText('1 section could not be included');
    await expect(section(page, /Verdict/)).toContainText(
      'Left out of this report. Your role (Knowledge / Skill Curator)',
    );
    // The strip inside the chronology is a named region too, so the section is matched by its whole name.
    await expect(section(page, /^2\. Chronology$/)).toBeVisible();
  });
});

test.describe('[FR-REV-04] the case overview has one primary action, and the specialist pages stay one click away', () => {
  test('opens the guided review from the overview and lights the navigation item', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}`);
    await expect(page.getByRole('link', { name: /Open guided review/ })).toHaveCount(1);
    await expect(page.getByRole('link', { name: /Open the timeline/ })).toHaveCount(1);
    await page.getByRole('link', { name: /Open guided review/ }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${demo.caseOneId}/review$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Guided review' })).toBeVisible();
    await expect(navLink(page, 'Guided Review')).toHaveAttribute('aria-current', 'page');
  });

  test('lists the guided review first among the case pages, keeps the specialist pages, and has a shortcut', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}`);
    const investigate = primaryNav(page).getByRole('list', { name: 'Investigate' });
    await expect(investigate.getByRole('link')).toHaveText([
      /^Cases/,
      /^Guided Review/,
      /^Case Timeline/,
      /^Evidence Ledger/,
      /^Hypothesis Arena/,
      /^Counterfactual Lab/,
    ]);
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(new RegExp(`/cases/${demo.caseOneId}/review$`));
    await navLink(page, 'Case Timeline').click();
    await expect(page).toHaveURL(new RegExp(`/cases/${demo.caseOneId}/timeline$`));
  });
});

test.describe('[FR-REV-05] the review on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('does not scroll sideways, shows the events as a list instead of the picture, and keeps the section navigation within reach', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the page is not wider than the screen').toBeLessThanOrEqual(1);
    const chronology = section(page, 'Chronology');
    await expect(chronology.getByRole('img', { name: /^Chronology strip\./ })).toHaveCount(0);
    await expect(chronology.getByRole('list', { name: /^Key events and waits/ })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Sections of the guided review' }),
    ).toBeVisible();
  });
});

test.describe('[FR-REV-06] the report: read it, print it, copy it, download it', () => {
  test('has the nine sections of the brief, built from the same figures as the review', async ({
    page,
    demo,
    api,
  }) => {
    const quality = await api('engineer').getOk<Quality>(`/cases/${demo.caseOneId}/quality`);
    await openPage(page, `/cases/${demo.caseOneId}/report`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(['Report']);
    const headings = page.getByRole('heading', { level: 2 }).filter({ hasText: /^\d+\. / });
    await expect(headings).toHaveText(
      REPORT_SECTIONS.map((name, index) => `${index + 1}. ${name}`),
    );
    await expect(section(page, /Verdict/)).toContainText(
      `about ${Math.round(quality.compositeScore)} out of 100`,
    );
    await expect(section(page, /The better-supported path/)).toContainText('Simulated estimate');
    await expect(section(page, /Review and approval/)).toContainText(
      /Generated at .+ from analysis run /,
    );
    await expect(section(page, /Review and approval/)).toContainText('Accepted');
    for (const name of ['Print', 'Copy summary', 'Download HTML']) {
      await expect(page.getByRole('button', { name }), name).toBeEnabled();
    }
  });

  test('copies a short plain-text summary with the address of the report, and says so', async ({
    page,
    context,
    demo,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openPage(page, `/cases/${demo.caseOneId}/report`);
    await page.getByRole('button', { name: 'Copy summary' }).click();
    await expect(toast(page, 'Summary copied')).toBeVisible();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text.split('\n')[0]).toMatch(/^CaseGuard guided review: CG-SYN-1001, /);
    expect(text).toContain('This is an estimate.');
    expect(text).toMatch(
      new RegExp(`Full report: https?://[^\\s]+/cases/${demo.caseOneId}/report$`),
    );
  });

  test('downloads one self-contained HTML file named from the case reference: no scripts, a restrictive policy, escaped text', async ({
    page,
    demo,
    browser,
  }, testInfo) => {
    await openPage(page, `/cases/${demo.caseOneId}/report`);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download HTML' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('CG-SYN-1001-guided-review.html');
    // Playwright keeps a download under a name with no extension, which a browser opens as plain text: save it as the
    // file a person would have (its own name) before opening it.
    const path = testInfo.outputPath(file.suggestedFilename());
    await file.saveAs(path);
    const html = await readFile(path, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<(link|iframe|img|object|embed|base|form)[\s>]/i);

    // Opened on its own (no app, no network), it is a readable report and the browser raises no policy violation.
    const context = await browser.newContext();
    const reader = await context.newPage();
    const problems: string[] = [];
    reader.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text());
    });
    reader.on('pageerror', (error) => problems.push(error.message));
    await reader.goto(`file://${path}`);
    await expect(reader.getByRole('heading', { level: 1 })).toContainText('CG-SYN-1001');
    await expect(reader.getByRole('heading', { level: 2, name: '1. Verdict' })).toBeVisible();
    await expect(reader.getByRole('img', { name: /^Chronology strip\./ })).toBeVisible();
    expect(await reader.locator('script').count()).toBe(0);
    expect(problems).toEqual([]);
    await context.close();
  });

  test('prints without the application chrome, with page breaks and the address of every link, and makes a PDF', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/report`);
    await page.emulateMedia({ media: 'print' });
    await expect(primaryNav(page)).toBeHidden();
    await expect(page.getByRole('banner')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Print' })).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('CG-SYN-1001');
    const address = await page
      .getByRole('link', { name: 'Open the guided review in CaseGuard' })
      .evaluate((link) => getComputedStyle(link, '::after').content);
    expect(address).toMatch(/https?:\/\/.+\/review/);
    const pdf = await page.pdf({ format: 'A4' });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(20_000);
  });

  test('the report of the efficient case is good news, and still complete', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseTwoId}/report`);
    await expect(section(page, /The earliest important missed moment/)).toContainText(
      'No decision point stood out',
    );
    await expect(section(page, /The better-supported path/)).toContainText('Nothing to compare');
    await expect(section(page, /Recommendations backed by evidence/)).toContainText(
      'General guidance — no case-specific evidence',
    );
    await expect(section(page, /Review and approval/)).toContainText('steps followed');
  });

  test('reports a case nobody can find as not found, never as an empty report', async ({
    page,
    diagnostics,
  }) => {
    // The 404 of the unknown case is what this test provokes.
    diagnostics.allow(/status of 404/);
    await page.goto('/cases/case_does_not_exist/report');
    await expect(page.getByRole('heading', { name: 'We could not find that case' })).toBeVisible();
  });
});

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

async function violations(page: Page): Promise<string[]> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) =>
          animation.finished.then(
            () => undefined,
            () => undefined,
          ),
        ),
    ).then(() => undefined),
  );
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    .exclude('[data-tabster-dummy]')
    .analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'n/a'}): ${violation.help} :: ${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(' | ')}`,
  );
}

const THEMES = ['light', 'dark'] as const satisfies readonly ThemeMode[];

for (const theme of THEMES) {
  for (const path of ['review', 'report'] as const) {
    test.describe(`[NFR-A11Y-01] axe · ${theme} · ${path}`, () => {
      test.use({ theme });
      test('has no violations of WCAG 2.1 A/AA or best practice, on a desktop and on a phone', async ({
        page,
        demo,
      }) => {
        await openPage(page, `/cases/${demo.caseOneId}/${path}`);
        expect(await violations(page), `${path} (${theme})`).toEqual([]);
        await page.setViewportSize({ width: 390, height: 844 });
        await settle(page);
        expect(await violations(page), `${path} (${theme}, phone)`).toEqual([]);
      });
    });
  }
}

test.describe('[NFR-A11Y-01] the evidence drawer', () => {
  test('has no violations with a quotation showing, and Tab stays inside it until it is closed', async ({
    page,
    demo,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    await section(page, 'Next actions')
      .getByRole('button', { name: /^Statement:/ })
      .first()
      .click();
    const drawer = page.getByRole('dialog', { name: 'Evidence' });
    await expect(drawer.getByText('Checked against the stored message').first()).toBeVisible();
    expect(await violations(page)).toEqual([]);
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const active = document.activeElement;
        return active?.closest('[role="dialog"]') !== null;
      });
      expect(inside, `focus stayed in the drawer after ${step + 1} Tab presses`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });
});

test.describe('[FR-REV-07] a manager reads the review and the report but cannot change anything', () => {
  test.use({ persona: 'manager' });

  test('is told who can run a simulation, adopt a plan or extract a skill, instead of being offered a button', async ({
    page,
    demo,
    api,
  }) => {
    await openPage(page, `/cases/${demo.caseOneId}/review`);
    const learning = section(page, 'Learning');
    await expect(learning.getByRole('button', { name: /^Adopt this plan:/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(learning).toContainText('cannot extract skills');
    // The figures are the same ones the engineer sees.
    const cases = await listCases(api('manager'));
    const one = cases.find((item) => item.id === demo.caseOneId);
    await expect(section(page, 'Verdict')).toContainText(
      `about ${Math.round(one!.qualityIndex!)} out of 100`,
    );
  });
});
