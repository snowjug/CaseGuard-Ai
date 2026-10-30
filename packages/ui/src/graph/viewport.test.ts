import { describe, expect, it } from 'vitest';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  centerOn,
  clampZoom,
  fitTransform,
  initialTransform,
  revealRect,
  zoomAbout,
} from './viewport';

const view = { width: 800, height: 500 };

describe('viewport maths', () => {
  it('fits content inside the view, centred and never magnified', () => {
    const t = fitTransform({ width: 2000, height: 1000 }, view);
    expect(t.k).toBeCloseTo(Math.min((800 - 24) / 2000, (500 - 24) / 1000), 5);
    expect(t.tx).toBeCloseTo((800 - 2000 * t.k) / 2, 5);
    expect(fitTransform({ width: 100, height: 100 }, view).k).toBe(1);
  });

  it('clamps zoom to the allowed range', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
  });

  it('zooms about a fixed screen point', () => {
    const t = { k: 1, tx: 0, ty: 0 };
    const zoomed = zoomAbout(t, 2, 400, 250);
    expect(zoomed.k).toBe(2);
    // The content point under (400, 250) stays under (400, 250).
    expect(400 * zoomed.k * 0 + (400 - zoomed.tx) / zoomed.k).toBeCloseTo(400, 5);
    expect((250 - zoomed.ty) / zoomed.k).toBeCloseTo(250, 5);
  });

  it('centres on a content point', () => {
    const t = centerOn(1000, 600, 1, view);
    expect(1000 * t.k + t.tx).toBe(400);
    expect(600 * t.k + t.ty).toBe(250);
  });

  it('reveals an off-screen rectangle with the smallest pan and leaves visible ones alone', () => {
    const t = { k: 1, tx: 0, ty: 0 };
    const inside = revealRect(t, { x: 100, y: 100, width: 50, height: 50 }, view);
    expect(inside).toBe(t);
    const outside = revealRect(t, { x: 1000, y: 100, width: 100, height: 100 }, view);
    expect(outside.tx).toBe(800 - 24 - 1100);
    expect(outside.ty).toBe(0);
  });

  it('opens a large graph at a readable scale centred on the focus instead of unreadable specks', () => {
    const content = { width: 4000, height: 900 };
    const t = initialTransform(content, view, { x: 2000, y: 450 });
    expect(t.k).toBe(1);
    expect(2000 * t.k + t.tx).toBeCloseTo(400, 3);
    expect(initialTransform({ width: 600, height: 300 }, view, null).k).toBe(1);
  });
});
