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

/** Place an anchored overlay using only visible space, before clamping its edges. */
export function anchoredOverlay(bounds: ReturnType<typeof overlayBounds>, anchor: OverlayRect,
  width: number, height: number, align: 'left' | 'right' | 'center', gap = 6) {
  const above = Math.max(0, Math.min(bounds.bottom, anchor.top - gap) - bounds.top);
  const below = Math.max(0, bounds.bottom - Math.max(bounds.top, anchor.bottom + gap));
  const up = height <= above || above >= below;
  const maxHeight = up ? above : below;
  const fittedWidth = Math.min(width, bounds.width);
  const fittedHeight = Math.min(height, maxHeight);
  const left = align === 'right' ? anchor.right - fittedWidth
    : align === 'center' ? (anchor.left + anchor.right - fittedWidth) / 2 : anchor.left;
  return { ...fitOverlay(bounds, left, up ? anchor.top - gap - fittedHeight : anchor.bottom + gap,
    fittedWidth, fittedHeight), maxHeight: fittedHeight };
}
