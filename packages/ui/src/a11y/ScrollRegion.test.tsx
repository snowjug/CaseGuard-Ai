import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoAxeViolations, renderWithTheme } from '../../test/axe';
import { ScrollRegion } from './ScrollRegion';
import { VisuallyHidden } from './VisuallyHidden';

describe('ScrollRegion', () => {
  it('is a named, keyboard-focusable region that scrolls sideways', async () => {
    const { container } = renderWithTheme(
      <ScrollRegion label="Nodes table, scrollable">
        <table>
          <caption>Nodes</caption>
          <tbody>
            <tr>
              <td>A wide cell</td>
            </tr>
          </tbody>
        </table>
      </ScrollRegion>,
    );
    const region = screen.getByRole('region', { name: 'Nodes table, scrollable' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(getComputedStyle(region).overflowX).toBe('auto');
    await expectNoAxeViolations(container);
  });

  it('contains the visually hidden text inside it, so a table wider than the screen cannot widen the page', () => {
    renderWithTheme(
      <ScrollRegion label="Hidden text stays inside">
        <VisuallyHidden>Sorted ascending</VisuallyHidden>
      </ScrollRegion>,
    );
    const region = screen.getByRole('region', { name: 'Hidden text stays inside' });
    // An absolutely positioned child escapes a scroll container that is not positioned itself.
    expect(getComputedStyle(region).position).toBe('relative');
  });
});
