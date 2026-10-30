/** Pure pan/zoom maths for the investigation graph canvas. */

export interface Transform {
  /** Scale. */
  k: number;
  /** Translation in screen pixels. */
  tx: number;
  ty: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 1.25;

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/** Scale and translation that show all of `content` inside `view`, centred, never magnified beyond 1:1. */
export function fitTransform(content: Size, view: Size, margin = 12): Transform {
  const k = clampZoom(
    Math.min(
      (view.width - margin * 2) / content.width,
      (view.height - margin * 2) / content.height,
      1,
    ),
  );
  return {
    k,
    tx: (view.width - content.width * k) / 2,
    ty: (view.height - content.height * k) / 2,
  };
}

/** Zooms by `factor` keeping the screen point (`px`, `py`) fixed (the viewport centre for button zoom). */
export function zoomAbout(t: Transform, factor: number, px: number, py: number): Transform {
  const k = clampZoom(t.k * factor);
  const ratio = k / t.k;
  return { k, tx: px - (px - t.tx) * ratio, ty: py - (py - t.ty) * ratio };
}

/** Centres the content point (`cx`, `cy`) in the view at scale `k`. */
export function centerOn(cx: number, cy: number, k: number, view: Size): Transform {
  const scale = clampZoom(k);
  return { k: scale, tx: view.width / 2 - cx * scale, ty: view.height / 2 - cy * scale };
}

/**
 * Smallest pan that brings the content rectangle fully into view (with `margin`). If the rectangle is larger than
 * the view on an axis, it is centred on that axis. Returns the same transform when nothing needs to move.
 */
export function revealRect(
  t: Transform,
  rect: { x: number; y: number; width: number; height: number },
  view: Size,
  margin = 24,
): Transform {
  const left = rect.x * t.k + t.tx;
  const top = rect.y * t.k + t.ty;
  const right = left + rect.width * t.k;
  const bottom = top + rect.height * t.k;
  const axis = (start: number, end: number, size: number, translate: number): number => {
    if (end - start > size - margin * 2) return translate + (size / 2 - (start + end) / 2);
    if (start < margin) return translate + (margin - start);
    if (end > size - margin) return translate + (size - margin - end);
    return translate;
  };
  const tx = axis(left, right, view.width, t.tx);
  const ty = axis(top, bottom, view.height, t.ty);
  return tx === t.tx && ty === t.ty ? t : { k: t.k, tx, ty };
}

/**
 * Initial transform: the whole graph when it stays readable (scale >= `readable`); otherwise a readable scale
 * centred on `focus`, so a large graph opens on the interesting part rather than as unreadable specks.
 */
export function initialTransform(
  content: Size,
  view: Size,
  focus: { x: number; y: number } | null,
  readable = 1,
): Transform {
  const fit = fitTransform(content, view);
  if (fit.k >= readable || !focus) return fit;
  const k = readable;
  const tx = Math.min(0, Math.max(view.width - content.width * k, view.width / 2 - focus.x * k));
  const ty =
    content.height * k <= view.height
      ? (view.height - content.height * k) / 2
      : Math.min(0, Math.max(view.height - content.height * k, view.height / 2 - focus.y * k));
  return { k, tx, ty };
}
