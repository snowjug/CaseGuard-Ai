import type { DemoIds } from './support/api';
import { expect, test } from './support/fixtures';
import { PERSONAS, type PersonaKey } from './support/personas';
import { openPage } from './support/ui';

test.describe('[E2E-SMOKE] the stack under test', () => {
  test('the web tier forwards the API probes and serves the shell for the signed-in persona', async ({
    page,
    request,
  }) => {
    const ready = await request.get('/readyz');
    expect(ready.status()).toBe(200);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: `${PERSONAS.engineer.displayName} ${PERSONAS.engineer.roleLabel}`,
      }),
    ).toBeVisible();
  });
});

interface MainRoute {
  readonly name: string;
  readonly persona: PersonaKey;
  readonly path: (ids: DemoIds) => string;
  /** The page's one `h1` (a regular expression, so a title may carry the case reference). */
  readonly heading: RegExp;
}

const caseOne =
  (section = ''): ((ids: DemoIds) => string) =>
  (ids) =>
    `/cases/${ids.caseOneId}${section}`;

/** Every main route of the product, opened as a role that may read it. */
const MAIN_ROUTES: readonly MainRoute[] = [
  { name: 'Home', persona: 'manager', path: () => '/', heading: /^Home$/ },
  { name: 'Cases', persona: 'engineer', path: () => '/cases', heading: /^Cases$/ },
  { name: 'Add a case', persona: 'engineer', path: () => '/cases/new', heading: /^Add a case$/ },
  { name: 'Review', persona: 'reviewer', path: caseOne('/review'), heading: /^Review$/ },
  { name: 'Score', persona: 'manager', path: caseOne('/quality'), heading: /^Score$/ },
  { name: 'Evidence', persona: 'engineer', path: caseOne('/evidence'), heading: /^Evidence$/ },
  { name: 'What if', persona: 'reviewer', path: caseOne('/counterfactual'), heading: /^What if$/ },
  { name: 'Timeline', persona: 'engineer', path: caseOne('/timeline'), heading: /^Timeline$/ },
  {
    name: 'Possible causes',
    persona: 'engineer',
    path: caseOne('/hypotheses'),
    heading: /^Possible causes$/,
  },
  { name: 'Case details', persona: 'engineer', path: caseOne(), heading: /^Case details$/ },
  { name: 'Report', persona: 'reviewer', path: caseOne('/report'), heading: /^Report$/ },
  { name: 'Quality', persona: 'manager', path: () => '/quality', heading: /^Quality$/ },
  { name: 'Skills', persona: 'curator', path: () => '/skills', heading: /^Skills$/ },
  {
    name: 'Skill detail',
    persona: 'curator',
    path: (ids) => `/skills/${ids.skillId}`,
    heading: /./,
  },
  { name: 'Advanced', persona: 'admin', path: () => '/advanced', heading: /^Advanced$/ },
  {
    name: 'Usage and cost',
    persona: 'manager',
    path: () => '/efficiency',
    heading: /^Usage and cost$/,
  },
  {
    name: 'Settings and audit',
    persona: 'admin',
    path: () => '/governance',
    heading: /^Settings and audit$/,
  },
  { name: 'System status', persona: 'admin', path: () => '/system', heading: /^System status$/ },
  { name: 'Guided demo', persona: 'admin', path: () => '/demo', heading: /^Guided demo$/ },
];

test.describe('[E2E-SMOKE-02] every main route renders: one heading, no console errors, no sideways scroll', () => {
  for (const route of MAIN_ROUTES) {
    test.describe(route.name, () => {
      test.use({ persona: route.persona });

      // The `diagnostics` fixture fails the test on any console error, uncaught error or CSP violation.
      test('opens', async ({ page, demo }) => {
        await openPage(page, route.path(demo));
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(route.heading);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      });
    });
  }
});
