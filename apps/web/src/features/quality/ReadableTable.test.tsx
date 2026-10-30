import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../../test/harness';
import { ReadableTable } from './ReadableTable';

describe('[FR-QA-03] Readable tables', () => {
  it('asks for a readable width per column around the table it holds', () => {
    renderApp(
      <ReadableTable columns={9}>
        <p>The table</p>
      </ReadableTable>,
    );
    const wrapper = screen.getByText('The table').parentElement;
    expect(wrapper?.style.getPropertyValue('--cg-columns')).toBe('9');
  });

  it('follows the number of columns it is given', () => {
    renderApp(
      <ReadableTable columns={5}>
        <p>Another table</p>
      </ReadableTable>,
    );
    expect(
      screen.getByText('Another table').parentElement?.style.getPropertyValue('--cg-columns'),
    ).toBe('5');
  });
});
