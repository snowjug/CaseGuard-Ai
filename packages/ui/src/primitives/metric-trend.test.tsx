import { describe, expect, it } from 'vitest';
import { trendText } from './MetricCard';

describe('[UI-METRIC-02] the trend line of a metric card never prints the change twice', () => {
  it('puts the signed change in front of a label that is only the comparison', () => {
    expect(trendText({ delta: 4.2, label: 'vs previous run' })).toBe('+4.2 vs previous run');
    expect(trendText({ delta: -6, label: 'vs previous run' })).toBe('-6 vs previous run');
  });

  it('shows a label that already starts with the change as it is (what the API sends)', () => {
    const up = '+63.1 points compared with CG-SYN-1001, the previous analysed case (estimates)';
    expect(trendText({ delta: 63.1, label: up })).toBe(up);
    const down =
      '-56.3 percentage points compared with CG-SYN-1001, the previous analysed case (estimates)';
    expect(trendText({ delta: -56.3, label: down })).toBe(down);
    const domain = '+4.2 since the previous analysis';
    expect(trendText({ delta: 4.2, label: domain })).toBe(domain);
  });

  it('does not take a longer number that begins the same way for the same change', () => {
    expect(trendText({ delta: 6, label: '+63 points since the previous analysis' })).toBe(
      '+6 +63 points since the previous analysis',
    );
    expect(trendText({ delta: 1, label: '1.5 points higher' })).toBe('+1 1.5 points higher');
  });

  it('reads the typographic minus sign as the hyphen', () => {
    const label = '\u22126 percentage points compared with the previous case';
    expect(trendText({ delta: -6, label })).toBe(label);
  });
});
