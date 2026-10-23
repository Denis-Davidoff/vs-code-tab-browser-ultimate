export type ScrollInput = {
  action: "scroll";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
};
/** Coalesce trackpad/touch events; only one remote wheel command can be outstanding. */
export function createPreviewScrollQueue(
  send: (input: ScrollInput, done: (ok: boolean) => void) => boolean,
) {
  let pending: ScrollInput | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    active = false,
    generation = 0;
  const reset = () => {
    generation++;
    pending = undefined;
    active = false;
    clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    timer = undefined;
    if (active || !pending) return;
    const chunk = {
      ...pending,
      deltaX: Math.max(-2000, Math.min(2000, pending.deltaX)),
      deltaY: Math.max(-2000, Math.min(2000, pending.deltaY)),
    };
    pending.deltaX -= chunk.deltaX;
    pending.deltaY -= chunk.deltaY;
    if (!pending.deltaX && !pending.deltaY) pending = undefined;
    const current = generation;
    active = true;
    const sent = send(chunk, (ok) => {
      if (current !== generation) return;
      active = false;
      if (!ok) {
        reset();
        return;
      }
      if (pending) timer = setTimeout(flush, 16);
    });
    if (!sent) reset();
  };
  return {
    reset,
    enqueue(x: number, y: number, deltaX: number, deltaY: number) {
      if (
        ![x, y, deltaX, deltaY].every(Number.isFinite) ||
        (!deltaX && !deltaY)
      )
        return;
      pending = {
        action: "scroll",
        x,
        y,
        deltaX: Math.max(
          -8000,
          Math.min(8000, (pending?.deltaX ?? 0) + deltaX),
        ),
        deltaY: Math.max(
          -8000,
          Math.min(8000, (pending?.deltaY ?? 0) + deltaY),
        ),
      };
      if (!active && !timer) timer = setTimeout(flush, 16);
    },
  };
}
