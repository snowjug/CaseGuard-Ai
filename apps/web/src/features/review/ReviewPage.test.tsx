import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { installMatchMedia } from '../../../test/media';
import { CASE_ONE, CASE_TWO } from '../../../test/review-fixtures';
import { calledRoutes, reviewApi, type ReviewApiOptions } from '../../../test/review-support';
import { ApiError } from '../../lib/api/errors';
import { ReviewPage } from './ReviewPage';

const SECTIONS = [
  'Verdict',
  'Fix first',
  'Evidence',
  'What would have changed the outcome',
  'What happened',
  'What went wrong',
  'What to learn',
  'Share',
] as const;

/** What the section navigation calls each section (the full title is the link's tooltip). */
const NAV_LABELS = [
  'Verdict',
  'Fix first',
  'Evidence',
  'What if',
  'What happened',
  'What went wrong',
  'What to learn',
  'Share',
] as const;

configure({ asyncUtilTimeout: 5000 });

function renderReview(options: ReviewApiOptions = {}) {
  const fixture = options.fixture ?? CASE_ONE;
  const api = reviewApi(options);
  const view = renderApp(<ReviewPage caseId={fixture.detail.id} />, { api });
  return { api, ...view };
}

const region = (name: string) => screen.findByRole('region', { name });

/** Opens a section that starts closed, the way a person does: with the button that is its heading. */
async function openSection(name: string) {
  const user = userEvent.setup();
  const section = within(await region(name));
  const toggle = section.getByRole('button', { name });
  if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
  return section;
}

describe('[REV-PAGE-01] one page of sections', () => {
  it('shows the sections in the order a person decides, each a named region, and no axe violations', async () => {
    installMatchMedia();
    const { container } = renderReview();
    expect(await screen.findByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
    expect(await screen.findByText('Demo data')).toBeVisible();

    const nav = await screen.findByRole('navigation', { name: 'Sections of the review' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([...NAV_LABELS]);
    for (const name of SECTIONS) {
      expect(await region(name)).toBeVisible();
    }
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([...SECTIONS]);

    // The page says what kind of figures it shows.
    expect(screen.getAllByText('Estimated').length).toBeGreaterThan(0);
    await screen.findByText(/about 36 out of 100/);
    await expectNoAxeViolations(container);
  });

  it('keeps the detail on demand: what went wrong and what to learn start closed, the rest is open', async () => {
    installMatchMedia();
    renderReview();
    for (const name of ['What went wrong', 'What to learn']) {
      const toggle = within(await region(name)).getByRole('button', { name });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    }
    for (const name of ['Verdict', 'Fix first', 'Evidence', 'What happened', 'Share']) {
      expect(within(await region(name)).queryByRole('button', { name })).toBeNull();
    }
  });

  it('has a "How this was calculated" disclosure in every section and one for the whole review', async () => {
    installMatchMedia();
    renderReview();
    for (const name of [
      'Verdict',
      'What happened',
      'What would have changed the outcome',
      'Fix first',
    ]) {
      const section = within(await region(name));
      expect(section.getByText('How this was calculated')).toBeVisible();
    }
    for (const name of ['What went wrong', 'What to learn']) {
      const section = await openSection(name);
      expect(section.getByText('How this was calculated')).toBeVisible();
    }
    expect(screen.getByText('How this whole review was calculated')).toBeVisible();
  });

  it('opens the report from the share section', async () => {
    installMatchMedia();
    renderReview();
    const share = within(await region('Share'));
    expect(await share.findByRole('link', { name: 'Open the report' })).toHaveAttribute(
      'href',
      `/cases/${CASE_ONE.detail.id}/report`,
    );
  });

  it('has one primary action, the fix list, and copies it as plain text with the ranked fixes', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderReview();
    await region('Fix first');
    await user.click(await screen.findByRole('button', { name: 'Copy fix list' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = String(writeText.mock.calls[0]?.[0]);
    expect(text.split('\n')[0]).toBe(
      `CaseGuard fix list: ${CASE_ONE.detail.reference}, ${CASE_ONE.detail.title}`,
    );
    expect(text).toContain('1. Write causes as hypotheses until evidence supports them (critical)');
    expect(await screen.findByText('Fix list copied')).toBeVisible();
  });
});

describe('[REV-PAGE-02] the verdict', () => {
  it('states the quality band with its range as an estimate and the earliest missed moment', async () => {
    installMatchMedia();
    renderReview();
    const verdict = within(await region('Verdict'));
    expect(
      await verdict.findByText(
        'Case quality is poor: about 36 out of 100 (plausible range 32 to 39). This is an estimate.',
      ),
    ).toBeVisible();
    // The ring, its table and the badge name the band in one word; the generic word of the ring is not used beside it.
    expect(
      verdict.getByRole('img', {
        name: 'Case quality: 36 out of 100, Poor, estimated range 32 to 39',
      }),
    ).toBeVisible();
    expect(verdict.getAllByText('Poor').length).toBeGreaterThanOrEqual(2);
    expect(verdict.queryByText('Needs attention')).toBeNull();
    expect(
      verdict.getByText('Many steps were not well supported by what was on record.'),
    ).toBeVisible();
    expect(verdict.getByText('Earliest missed moment')).toBeVisible();
    expect(
      verdict.getByText('Heavy customer request when a lighter ask was available'),
    ).toBeVisible();
    expect(verdict.getByText('What was done')).toBeVisible();
    expect(verdict.getByText('What was already known')).toBeVisible();
    expect(verdict.getByText(/Time that could have been saved:/)).toBeVisible();
  });

  it('keeps the score’s detail one click away: the range, how certain it is and what the coach said', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    renderReview();
    const verdict = within(await region('Verdict'));
    const toggle = await verdict.findByRole('button', { name: 'About this score' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(await verdict.findByText('How certain is this?')).toBeVisible();
    expect(verdict.getByText('In the coach’s words')).toBeVisible();
    expect(
      verdict.getByText(/The case is resolved, so this reviews the whole record/),
    ).toBeVisible();
  });

  it('reads a strong case with no decision point as good news, not as missing data', async () => {
    installMatchMedia();
    const { container } = renderReview({ fixture: CASE_TWO });
    const verdict = within(await region('Verdict'));
    expect(
      await verdict.findByRole('img', {
        name: /^Case quality: 99 out of 100, Strong, estimated range /,
      }),
    ).toBeVisible();
    expect(verdict.getAllByText('Strong').length).toBeGreaterThanOrEqual(2);
    expect(verdict.queryByText('Good')).toBeNull();
    expect(await verdict.findByText('No decision point stood out')).toBeVisible();
    expect(verdict.getByText(/That is a good sign for this case, not an error/)).toBeVisible();
    await expectNoAxeViolations(container);
  });
});

describe('[REV-PAGE-03] a part that cannot be read does not take the page with it', () => {
  it('shows a skill curator everything except case quality, which it explains instead of requesting', async () => {
    installMatchMedia();
    const { api, container } = renderReview({ role: 'skill_curator' });
    const verdict = within(await region('Verdict'));
    expect(await verdict.findByText('Not shown')).toBeVisible();
    expect(
      verdict.getByText(
        /does not include the “quality:read” permission, so the case quality result/,
      ),
    ).toBeVisible();
    // What the curator may read is still there.
    expect(
      await verdict.findByText('Heavy customer request when a lighter ask was available'),
    ).toBeVisible();
    const learning = await openSection('What to learn');
    expect(await learning.findByText(/This resembles/)).toBeVisible();
    const chronology = within(await region('What happened'));
    expect(await chronology.findByRole('list', { name: /Key events and waits/ })).toBeVisible();

    const routes = calledRoutes(api);
    expect(routes).not.toContain('quality.get');
    expect(routes).not.toContain('coaching.get');
    expect(routes).not.toContain('metrics.get');
    expect(routes).toContain('forks.list');
    await expectNoAxeViolations(container);
  });

  it('keeps the other sections when one read fails, and the failed one can be retried', async () => {
    installMatchMedia();
    let attempts = 0;
    const user = userEvent.setup();
    renderReview({
      handlers: {
        'quality.get': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal_error',
              title: 'Server error',
              message: 'The server could not answer.',
            });
          return CASE_ONE.quality;
        },
      },
    });
    const verdict = within(await region('Verdict'));
    expect(await verdict.findByRole('button', { name: /Retry/ })).toBeVisible();
    expect(
      await verdict.findByText('Heavy customer request when a lighter ask was available'),
    ).toBeVisible();
    const actions = within(await region('Fix first'));
    expect(await actions.findByRole('list', { name: 'Ranked recommendations' })).toBeVisible();

    await user.click(verdict.getByRole('button', { name: /Retry/ }));
    expect(await verdict.findByText(/about 36 out of 100/)).toBeVisible();
    expect(attempts).toBe(2);
  });

  it('shows the not-analysed state instead of empty sections', async () => {
    installMatchMedia();
    renderReview({
      fixture: {
        ...CASE_ONE,
        detail: { ...CASE_ONE.detail, analysisState: 'not_analyzed' },
      },
    });
    expect(await screen.findByText('This case has not been analysed yet')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Verdict' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy fix list' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Review' })).toBeVisible();
  });

  it('says the case was not found when it does not exist', async () => {
    installMatchMedia();
    renderReview({
      handlers: {
        'cases.get': () => {
          throw new ApiError({
            status: 404,
            code: 'not_found',
            title: 'Not found',
            message: 'No such case',
          });
        },
      },
    });
    await waitFor(() => expect(screen.getByText('We could not find that case')).toBeVisible());
  });
});

describe('[REV-PAGE-04] the section navigation', () => {
  it('moves keyboard focus to the section it links to, and opens it when it starts closed', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    renderReview();
    await region('What to learn');
    const nav = screen.getByRole('navigation', { name: 'Sections of the review' });
    const toggle = within(screen.getByRole('region', { name: 'What to learn' })).getByRole(
      'button',
      { name: 'What to learn' },
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(nav).getByRole('link', { name: 'What to learn' }));
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'What to learn' })).toHaveFocus(),
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'What to learn' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });
});
