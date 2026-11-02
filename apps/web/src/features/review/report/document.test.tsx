import { render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations } from '../../../../test/harness';
import {
  CASE_ONE,
  CASE_TWO,
  OVERLAY_ONE,
  OVERLAY_TWO,
  type CaseFixture,
} from '../../../../test/review-fixtures';
import { denied, ready } from '../model/sources';
import { REPORT_CSS, STANDALONE_CSS } from './css';
import { STANDALONE_CSP, buildReportHtml } from './html';
import { REPORT_SECTIONS, buildReport, type ReportInput } from './model';
import { ReportDocument } from './ReportDocument';

const ORIGIN = 'https://caseguard.example';

function inputOf(fixture: CaseFixture, overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    detail: ready(fixture.detail),
    run: ready(fixture.run),
    quality: ready(fixture.quality),
    metrics: ready(fixture.metrics),
    coaching: ready(fixture.coaching),
    forks: ready(fixture.forks),
    scenarios: ready(fixture.scenarios),
    warnings: ready(fixture.warnings),
    ranking: ready(fixture.ranking),
    matches: ready(fixture.matches),
    overlays: fixture === CASE_ONE ? { [OVERLAY_ONE.matchId]: ready(OVERLAY_ONE) } : {},
    timeline: ready({
      events: fixture.timeline.events,
      total: fixture.timeline.total,
      truncated: false,
    }),
    claimReviews: ready([]),
    readAt: Date.parse('2026-03-12T15:30:00.000Z'),
    ...overrides,
  };
}

const reportOf = (fixture: CaseFixture, overrides: Partial<ReportInput> = {}) =>
  buildReport(inputOf(fixture, overrides), 'Support engineer');

describe('[REV-REPORT-10] the report document', () => {
  it('reads as nine numbered sections in order, with a contents list, and has no accessibility violations', async () => {
    const report = reportOf(CASE_ONE);
    const { container } = render(
      <ReportDocument report={report} caseId={CASE_ONE.detail.id} origin={ORIGIN} />,
    );
    const view = within(container);
    expect(view.getByRole('heading', { level: 1 }).textContent).toBe(
      `${CASE_ONE.detail.reference}: ${CASE_ONE.detail.title}`,
    );
    const headings = view
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Contents',
      ...REPORT_SECTIONS.map((section, index) => `${index + 1}. ${section.title}`),
    ]);
    const contents = view.getByRole('navigation', { name: 'Contents of the report' });
    expect(within(contents).getAllByRole('link')).toHaveLength(9);
    expect(within(contents).getAllByRole('link')[4]).toHaveAttribute('href', '#r-better');
    await expectNoAxeViolations(container);
  });

  it('labels estimates and simulations, and the recorded against the better-supported path is a table with a caption', () => {
    const { container } = render(
      <ReportDocument report={reportOf(CASE_ONE)} caseId={CASE_ONE.detail.id} origin={ORIGIN} />,
    );
    const view = within(container);
    expect(view.getAllByText('Estimated').length).toBeGreaterThan(0);
    const head = container.querySelector('header');
    expect(head).not.toBeNull();
    expect(within(head as HTMLElement).getByText('Synthetic data')).toBeVisible();
    const table = view.getByRole('table', {
      name: 'The recorded path and the better-supported path (simulated estimate)',
    });
    expect(
      within(table).getByRole('columnheader', {
        name: 'Better-supported path (simulated estimate)',
      }),
    ).toBeVisible();
    expect(view.getByText(/Nothing here happened\./)).toBeVisible();
    expect(
      view.getAllByText('Within the simulation’s uncertainty', { selector: 'td' }).length,
    ).toBeGreaterThan(0);
  });

  it('shows the chronology as a picture with the whole summary as its text, and the same events as a list', () => {
    const { container } = render(
      <ReportDocument report={reportOf(CASE_ONE)} caseId={CASE_ONE.detail.id} origin={ORIGIN} />,
    );
    const view = within(container);
    const picture = view.getByRole('img', {
      name: /^Chronology strip\. 31 events over 3 days 1 hour/,
    });
    expect(picture.querySelectorAll('.cg-m--decisions').length).toBe(9);
    const list = view.getByRole('list', { name: 'Key events and waits, 14 key events' });
    expect(within(list).getAllByRole('listitem').length).toBe(18);
    expect(
      within(list).getByText('The customer waited 15 hours 10 minutes for a reply.'),
    ).toBeVisible();
  });

  it('lists every recommendation with its evidence, and says so when there is none', () => {
    const one = render(
      <ReportDocument report={reportOf(CASE_ONE)} caseId={CASE_ONE.detail.id} origin={ORIGIN} />,
    );
    const list = within(one.container).getByRole('list', { name: 'Ranked recommendations' });
    expect(within(list).getAllByRole('heading', { level: 3 })).toHaveLength(8);
    expect(
      within(list).getByLabelText(
        'Evidence for Write causes as hypotheses until evidence supports them',
      ),
    ).toBeVisible();
    one.unmount();
    const two = render(
      <ReportDocument report={reportOf(CASE_TWO)} caseId={CASE_TWO.detail.id} origin={ORIGIN} />,
    );
    expect(
      within(two.container).getByText('General guidance — no case-specific evidence'),
    ).toBeVisible();
  });

  it('shows the comparison with the skill with the server’s numbers exactly as given', () => {
    const { container } = render(
      <ReportDocument report={reportOf(CASE_ONE)} caseId={CASE_ONE.detail.id} origin={ORIGIN} />,
    );
    const table = within(container).getByRole('table', {
      name: 'Recorded against with the skill (estimates worked out by the server)',
    });
    const row = within(table).getByRole('row', { name: /^Time to useful evidence/ });
    expect(within(row).getByText('240 min (120 min to 480 min)')).toBeVisible();
    expect(within(row).getByText('150 min (0 min to 450 min)')).toBeVisible();
    expect(within(row).getByText('90 min (30 min to 150 min)')).toBeVisible();
  });

  it('shows only the skill’s own saving when the case has nothing to set it against', () => {
    const report = reportOf(CASE_TWO, { overlays: { [OVERLAY_TWO.matchId]: ready(OVERLAY_TWO) } });
    const { container } = render(
      <ReportDocument report={report} caseId={CASE_TWO.detail.id} origin={ORIGIN} />,
    );
    const table = within(container).getByRole('table', {
      name: /^What the skill saved on the case it came from/,
    });
    expect(within(table).getByText('90 min (30 min to 150 min)')).toBeVisible();
    expect(
      within(container).queryByRole('table', {
        name: 'Recorded against with the skill (estimates worked out by the server)',
      }),
    ).toBeNull();
  });

  it('puts the explicit note in place of a section the reader may not read, and at the top', async () => {
    const report = reportOf(CASE_ONE, {
      quality: denied('quality:read'),
      coaching: denied('quality:read'),
      metrics: denied('quality:read'),
    });
    const { container } = render(
      <ReportDocument report={report} caseId={CASE_ONE.detail.id} origin={ORIGIN} />,
    );
    const view = within(container);
    const top = view.getByRole('region', { name: 'Left out of this report' });
    expect(within(top).getByText(/1 section could not be included/)).toBeVisible();
    const verdict = view.getByRole('region', { name: /Verdict/ });
    expect(within(verdict).getByRole('note')).toHaveTextContent(
      /Left out of this report\. Your role \(Support engineer\) does not include the “quality:read” permission/,
    );
    // The other sections are still there.
    expect(view.getByRole('region', { name: /^2\. Chronology$/ })).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it('shows who reviewed what, and from which analysis run and when it was generated', () => {
    const { container } = render(
      <ReportDocument report={reportOf(CASE_ONE)} caseId={CASE_ONE.detail.id} origin={ORIGIN} />,
    );
    const review = within(within(container).getByRole('region', { name: /Review and approval/ }));
    expect(
      review.getByText(/^Generated at 12 Mar 2026, 15:30 UTC from analysis run /),
    ).toBeVisible();
    expect(review.getByText('No claim has been reviewed by a person yet.')).toBeVisible();
    expect(review.getByText('No warning was dismissed.')).toBeVisible();
  });
});

/** A case whose every free-text field tries to break out of the page. */
function hostile(fixture: CaseFixture): CaseFixture {
  const attack =
    '</title><script>alert(1)</script><img src=x onerror=alert(2)>"\' onmouseover="alert(3)';
  const [first] = fixture.forks.items;
  if (!first) throw new Error('fixture without a decision point');
  return {
    ...fixture,
    detail: { ...fixture.detail, title: attack, reference: `CG<${attack}>` },
    coaching: { ...fixture.coaching, summary: attack },
    forks: {
      ...fixture.forks,
      items: [{ ...first, title: attack, summary: attack }, ...fixture.forks.items.slice(1)],
    },
  };
}

describe('[REV-REPORT-11] the downloaded file is one self-contained document', () => {
  const props = (fixture: CaseFixture) => ({
    report: reportOf(fixture),
    caseId: fixture.detail.id,
    origin: ORIGIN,
  });

  it('has a restrictive content security policy, an inline stylesheet and nothing that loads', async () => {
    const html = await buildReportHtml(props(CASE_ONE));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(doc.documentElement.lang).toBe('en');
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(policy?.getAttribute('content')).toBe(STANDALONE_CSP);
    expect(STANDALONE_CSP).toContain("default-src 'none'");
    expect(STANDALONE_CSP).not.toMatch(/script-src|unsafe-eval|connect-src|\*/);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    expect(doc.querySelector('style')?.textContent).toBe(`${STANDALONE_CSS}\n${REPORT_CSS}`);
    for (const selector of [
      'script',
      'link',
      'iframe',
      'object',
      'embed',
      'base',
      'form',
      'img',
      'video',
      'audio',
    ]) {
      expect(doc.querySelectorAll(selector), selector).toHaveLength(0);
    }
    expect(doc.title).toBe(`${CASE_ONE.detail.reference}: guided review report`);
    // The only addresses in the file are links to follow, never something the file fetches.
    for (const element of Array.from(
      doc.querySelectorAll('[src], [srcset], [data], [action], [poster]'),
    )) {
      throw new Error(`the file loads something: <${element.tagName.toLowerCase()}>`);
    }
    for (const link of Array.from(doc.querySelectorAll('a[href]'))) {
      expect(link.getAttribute('href') ?? '').toMatch(/^(#|https:\/\/caseguard\.example\/)/);
    }
  });

  it('writes the stylesheet as it is, so the quotes and arrows of the CSS are not turned into entities', async () => {
    const html = await buildReportHtml(props(CASE_ONE));
    expect(html).toContain(REPORT_CSS);
    expect(REPORT_CSS).not.toMatch(/<\/style/i);
    expect(REPORT_CSS).toContain('a[href^="http"]');
  });

  it('escapes every string that came from a case: nothing in it can become a script, a handler or a tag', async () => {
    const html = await buildReportHtml(props(hostile(CASE_ONE)));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script, img, iframe')).toHaveLength(0);
    for (const element of Array.from(doc.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on'), `${element.tagName} ${attribute.name}`).toBe(false);
      }
    }
    // The text is there, as text.
    expect(doc.querySelector('h1')?.textContent).toContain('<script>alert(1)</script>');
    expect(doc.title).toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/<img[\s>]/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('names the file from the case reference', async () => {
    const hostileReport = buildReport(inputOf(hostile(CASE_ONE)), 'Support engineer');
    expect(hostileReport.fileName).toBe(
      'CG-title-script-alert-1-script-img-src-x-onerror-alert-2-onmouseover-alert-3-guided-review.html',
    );
  });

  it('is a real print stylesheet: no application chrome, light colours, page breaks and readable links', () => {
    const print = REPORT_CSS.slice(REPORT_CSS.indexOf('@media print'));
    expect(REPORT_CSS).toContain('@page');
    expect(print).toMatch(/body nav/);
    expect(print).toMatch(/body header:not\(\.cg-head\)/);
    expect(print).toMatch(/\.cg-skip-link/);
    expect(print).toMatch(/break-inside:avoid/);
    expect(print).toMatch(/break-after:avoid/);
    expect(print).toMatch(/table-header-group/);
    expect(print).toMatch(
      /a\[href\^="http"\]:not\(\.cg-nourl\)::after\{content:" \(" attr\(href\) "\)"/,
    );
    // Print uses the light variables whatever theme the page is in.
    expect(print).toContain('--cgSurface:#FFFFFF');
    // The application frame is a flex column of full height; on paper it must be plain blocks or pages are cut off.
    expect(print).toContain('div:has(main#main-content){display:block!important');
  });

  it('is balanced CSS: every block that is opened is closed, in the stylesheet and in the theme variables', () => {
    const count = (text: string, char: string): number => text.split(char).length - 1;
    for (const css of [REPORT_CSS, STANDALONE_CSS]) {
      expect(count(css, '{')).toBe(count(css, '}'));
      expect(count(css, '(')).toBe(count(css, ')'));
      expect(count(css, '"') % 2).toBe(0);
    }
  });
});
