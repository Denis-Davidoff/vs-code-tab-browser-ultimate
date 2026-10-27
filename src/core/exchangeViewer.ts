/** One viewer per browser tab/workspace, shared by the same-origin chat iframe. */
export function exchangeViewerId(pointId: string): string {
  try {
    const key = `ai-browser:viewer:${pointId}`;
    let id = sessionStorage.getItem(key);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(key, id); }
    return id;
  } catch {
    // Older/restricted browsers group the two channels by authenticated session.
    return "legacy";
  }
}
