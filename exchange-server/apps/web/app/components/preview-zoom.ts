/** 100% is the preview's full width; below it the page is shown smaller, centred. */
export const minPreviewZoom = 0.25;
export const maxPreviewZoom = 4;

export function clampPreviewZoom(value: number): number {
  return Number.isFinite(value) ? Math.max(minPreviewZoom, Math.min(maxPreviewZoom, value)) : 1;
}

/** Preserve the image position under the finger/cursor while scaling. */
export function previewZoomScroll(
  scroll: number,
  anchor: number,
  previous: number,
  next: number,
): number {
  return Math.max(0, ((scroll + anchor) * next) / previous - anchor);
}

/** Image coordinates exclude letterboxing, and remain correct after zoom and pan. */
export function previewPoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  naturalWidth: number,
  naturalHeight: number,
): { x: number; y: number } | undefined {
  if (!naturalWidth || !naturalHeight || !rect.width || !rect.height) return;
  const scale = Math.min(
    rect.width / naturalWidth,
    rect.height / naturalHeight,
  );
  const width = naturalWidth * scale,
    height = naturalHeight * scale;
  const px = (x - rect.left - (rect.width - width) / 2) / width;
  const py = (y - rect.top - (rect.height - height) / 2) / height;
  if (px < 0 || px > 1 || py < 0 || py > 1) return;
  return { x: px, y: py };
}
