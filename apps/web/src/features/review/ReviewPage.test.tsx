import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations, renderApp } from '../../../test/harness';
import { installMatchMedia } from '../../../test/media';
import { CASE_ONE, CASE_TWO } from '../../../test/review-fixtures';
import { calledRoutes, reviewApi, type ReviewApiOptions } from '../../../test/review-support';
import { ApiError } from '../../lib/api/errors';
import { ReviewPage } from './ReviewPage';

const SECTIONS = [
  'Verdict',
  'Chronology',
  'What went wrong',
  'What should have happened',
  'Next actions',
  'Learning',
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

describe('[REV-PAGE-01] one page of sections', () => {
  it('shows the seven sections in the order a person decides, each a named region, and no axe violations', async () => {
    installMatchMedia();
    const { container } = renderReview();
    expect(await screen.findByRole('heading', { level: 1, name: 'Guided review' })).toBeVisible();
    expect(
      await screen.findByText(`${CASE_ONE.detail.reference} · ${CASE_ONE.detail.title}`),
    ).toBeVisible();

    const nav = await screen.findByRole('navigation', { name: 'Sections of the guided review' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([...SECTIONS]);
    for (const name of SECTIONS) {
      expect(await region(name)).toBeVisible();
    }
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([...SECTIONS]);

    // The page says what kind of figures it shows.
    expect(screen.getAllByText('Estimated').length).toBeGreaterThan(0);
    expect(screen.getByText('Demo data')).toBeVisible();
    await screen.findByText(/about 36 out of 100/);
    await expectNoAxeViolations(container);
  });

  it('has a "How this was calculated" disclosure in every section and one for the whole review', async () => {
    installMatchMedia();
    renderReview();
    for (const name of [
      'Verdict',
      'Chronology',
      'What went wrong',
      'What should have happened',
      'Next actions',
      'Learning',
    ]) {
      const section = within(await region(name));
      expect(section.getByText('How this was calculated')).toBeVisible();
    }
    expect(screen.getByText('How this whole review was calculated')).toBeVisible();
  });

  it('opens the report from the header and from the share section', async () => {
    installMatchMedia();
    renderReview();
    const share = within(await region('Share'));
    expect(await share.findByRole('link', { name: 'Open the report' })).toHaveAttribute(
      'href',
      `/cases/${CASE_ONE.detail.id}/report`,
    );
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute(
      'href',
      `/cases/${CASE_ONE.detail.id}/report`,
    );
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
    expect(verdict.getAllByText('The earliest important missed moment')[0]).toBeVisible();
    expect(
      verdict.getByText('Heavy customer request when a lighter ask was available'),
    ).toBeVisible();
    expect(verdict.getByText('What was done')).toBeVisible();
    expect(verdict.getByText('What was already known')).toBeVisible();
    expect(verdict.getByText(/Avoidable support effort:/)).toBeVisible();
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
    const learning = within(await region('Learning'));
    expect(await learning.findByText(/This resembles/)).toBeVisible();
    const chronology = within(await region('Chronology'));
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
    const actions = within(await region('Next actions'));
    expect(await actions.findByRole('list', { name: 'Ranked recommendations' })).toBeVisible();

    await user.click(verdict.getByRole('button', { name: /Retry/ }));
    expect(await verdict.findByText(/about 36 out of 100/)).toBeVisible();
    expect(attempts).toBe(2);
  });

  it('shows the not-analysed state instead of seven empty sections', async () => {
    installMatchMedia();
    renderReview({
      fixture: {
        ...CASE_ONE,
        detail: { ...CASE_ONE.detail, analysisState: 'not_analyzed' },
      },
    });
    expect(await screen.findByText('This case has not been analysed yet')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Verdict' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Guided review' })).toBeVisible();
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
  it('moves keyboard focus to the section it links to', async () => {
    installMatchMedia();
    const user = userEvent.setup();
    renderReview();
    await region('Learning');
    const nav = screen.getByRole('navigation', { name: 'Sections of the guided review' });
    await user.click(within(nav).getByRole('link', { name: 'Learning' }));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Learning' })).toHaveFocus());
    expect(within(nav).getByRole('link', { name: 'Learning' })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });
});
