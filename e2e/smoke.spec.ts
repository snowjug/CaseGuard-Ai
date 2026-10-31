import { expect, test } from './support/fixtures';
import { PERSONAS } from './support/personas';

test.describe('[E2E-SMOKE] the stack under test', () => {
  test('the web tier forwards the API probes and serves the shell for the signed-in persona', async ({
    page,
    request,
  }) => {
    const ready = await request.get('/readyz');
    expect(ready.status()).toBe(200);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: `${PERSONAS.engineer.displayName} ${PERSONAS.engineer.roleLabel}`,
      }),
    ).toBeVisible();
  });
});
