import { describe, expect, it, vi } from 'vitest';
import { notFound } from '../../../test/next-navigation';
import DesignLabPage from './page';

// The gallery pulls in the whole design system; this test is only about the production guard.
vi.mock('../../features/design-lab/DesignLab', () => ({ DesignLab: () => null }));

describe('[UX-LAB-01] the design lab exists only outside production', () => {
  it('answers 404 in a production build, before loading any sample data', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await expect(DesignLabPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('renders in development and test', async () => {
    notFound.mockClear();
    const page = await DesignLabPage();
    expect(page).toBeTruthy();
    expect(notFound).not.toHaveBeenCalled();
  });
});
