export interface OverlayRect { left: number; top: number; right: number; bottom: number }

/** Coordinates relative to the app, limited to its visible intersection with the viewport. */
export function overlayBounds(app: OverlayRect, viewport: OverlayRect, gap: number) {
  const left = Math.max(app.left, viewport.left) - app.left + gap;
  const top = Math.max(app.top, viewport.top) - app.top + gap;
  const right = Math.max(left, Math.min(app.right, viewport.right) - app.left - gap);
  const bottom = Math.max(top, Math.min(app.bottom, viewport.bottom) - app.top - gap);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function fitOverlay(bounds: ReturnType<typeof overlayBounds>, left: number, top: number, width: number, height: number) {
  return {
    left: Math.max(bounds.left, Math.min(left, bounds.right - width)),
    top: Math.max(bounds.top, Math.min(top, bounds.bottom - height)),
  };
}
