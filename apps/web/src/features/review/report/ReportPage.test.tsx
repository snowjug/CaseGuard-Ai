import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations, renderApp } from '../../../../test/harness';
import { installMatchMedia } from '../../../../test/media';
import { CASE_ONE, CASE_TWO } from '../../../../test/review-fixtures';
import { calledRoutes, reviewApi, type ReviewApiOptions } from '../../../../test/review-support';
import { ApiError } from '../../../lib/api/errors';
import { REPORT_CSS } from './css';
import { REPORT_SECTIONS } from './model';
import { ReportPage } from './ReportPage';

configure({ asyncUtilTimeout: 5000 });

function renderReport(options: ReviewApiOptions = {}) {
  const fixture = options.fixture ?? CASE_ONE;
  const api = reviewApi(options);
  const view = renderApp(<ReportPage caseId={fixture.detail.id} />, { api });
  return { api, ...view };
}

const ready = () => screen.findByRole('heading', { level: 2, name: '1. Verdict' });

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[REV-REPORT-20] the report page', () => {
  it('shows the report with one h1, the nine sections, and the actions to print, copy and download', async () => {
    const { container } = renderReport();
    expect(screen.getByRole('button', { name: 'Print' })).toBeDisabled();
    await ready();
    expect(
      screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent),
    ).toEqual(['Report']);
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent)
      .filter((text) => /^\d+\. /.test(text ?? ''));
    expect(headings).toEqual(
      REPORT_SECTIONS.map((section, index) => `${index + 1}. ${section.title}`),
    );
    for (const name of ['Print', 'Copy summary', 'Download HTML']) {
      expect(screen.getByRole('button', { name })).toBeEnabled();
    }
    expect(screen.getByText(/choose Print and then “Save as PDF”/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to the guided review' })).toHaveAttribute(
      'href',
      `/cases/${CASE_ONE.detail.id}/review`,
    );
    await expectNoAxeViolations(container);
  });

  it('writes its stylesheet into the page as it is, including the print rules', async () => {
    renderReport();
    await ready();
    const sheets = Array.from(document.querySelectorAll('style')).map((style) => style.textContent);
    expect(sheets).toContain(REPORT_CSS);
  });

  it('prints the page with the browser’s own print dialog', async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    renderReport();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('copies a short plain-text summary with the address of the report, and says so', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderReport();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Copy summary' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const text = String(writeText.mock.calls[0]?.[0]);
    expect(text.split('\n')[0]).toBe(
      `CaseGuard guided review: ${CASE_ONE.detail.reference}, ${CASE_ONE.detail.title}`,
    );
    expect(text).toContain('This is an estimate.');
    expect(
      text.endsWith(`Full report: ${window.location.origin}/cases/${CASE_ONE.detail.id}/report`),
    ).toBe(true);
    expect(await screen.findByText('Summary copied')).toBeVisible();
  });

  it('downloads one HTML file named from the case reference', async () => {
    const user = userEvent.setup();
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      created.push(blob as Blob);
      return 'blob:report';
    });
    URL.revokeObjectURL = vi.fn();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    renderReport();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Download HTML' }));
    await waitFor(() => expect(names).toEqual(['CG-SYN-1001-guided-review.html']));
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('text/html;charset=utf-8');
    expect(created[0]?.size).toBeGreaterThan(10_000);
    expect(await screen.findByText('Report downloaded')).toBeVisible();
  });
});

describe('[REV-REPORT-21] sections the reader may not read are left out, and the report says so', () => {
  it('leaves out the verdict for a skill curator, with the explicit note, and never asks for it', async () => {
    const { api, container } = renderReport({ role: 'skill_curator' });
    const verdict = within(await screen.findByRole('region', { name: /Verdict/ }));
    expect(
      await verdict.findByText(/does not include the “quality:read” permission/),
    ).toBeVisible();
    expect(verdict.getByText(/Left out of this report\./)).toBeVisible();
    const top = screen.getByRole('region', { name: 'Left out of this report' });
    expect(within(top).getByText(/1 section could not be included/)).toBeVisible();
    // The sections the curator may read are all there.
    expect(screen.getByRole('region', { name: /^2\. Chronology$/ })).toBeVisible();
    expect(
      await screen.findByRole('list', { name: 'Skills that resemble this case' }),
    ).toBeVisible();
    const routes = calledRoutes(api);
    expect(routes).not.toContain('quality.get');
    expect(routes).not.toContain('coaching.get');
    expect(routes).not.toContain('metrics.get');
    await expectNoAxeViolations(container);
  });

  it('names what could not be read, and reads it again when asked', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderReport({
      handlers: {
        'forks.list': () => {
          attempts += 1;
          if (attempts === 1)
            throw new ApiError({
              status: 500,
              code: 'internal_error',
              title: 'Server error',
              message: 'The server could not answer.',
            });
          return CASE_ONE.forks;
        },
      },
    });
    expect(await screen.findByText('Some parts could not be read')).toBeVisible();
    const missed = within(
      await screen.findByRole('region', { name: /The earliest important missed moment/ }),
    );
    expect(
      await missed.findByText(
        'The decision points could not be read, so it is left out of this report. Reload the page to try again.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Heavy customer request when a lighter ask was available', {
        selector: 'h3',
      }),
    ).toBeVisible();
    expect(screen.queryByText('Some parts could not be read')).toBeNull();
  });

  it('shows the not-analysed state instead of a report with nothing in it', async () => {
    renderReport({
      fixture: {
        ...CASE_ONE,
        detail: { ...CASE_ONE.detail, analysisState: 'not_analyzed' },
      },
    });
    expect(await screen.findByText('This case has not been analysed yet')).toBeVisible();
    expect(screen.queryByRole('region', { name: /Verdict/ })).toBeNull();
  });
});

describe('[REV-REPORT-22] the efficient case', () => {
  it('reads as a good-news report: strong quality, nothing to compare, general guidance, an adopted skill plan', async () => {
    const { container } = renderReport({ fixture: CASE_TWO });
    const verdict = within(
      await ready().then(() => screen.getByRole('region', { name: /Verdict/ })),
    );
    expect(verdict.getByText('Strong')).toBeVisible();
    const better = within(screen.getByRole('region', { name: /The better-supported path/ }));
    expect(better.getByText(/Nothing to compare/)).toBeVisible();
    expect(screen.getByText('General guidance — no case-specific evidence')).toBeVisible();
    const review = within(screen.getByRole('region', { name: /Review and approval/ }));
    expect(review.getByText(/4 of 4 steps followed/)).toBeVisible();
    await expectNoAxeViolations(container);
  });
});
