/** Coalesce network reads across surfaces and throttle retries, including failed attempts. */
export class GitFetchScheduler {
 private readonly entries = new Map<string, { at: number; forced: boolean; pending?: Promise<void>; error?: unknown }>();
 private readonly intervalMs: number;
 private readonly now: () => number;
 constructor(intervalMs = 120_000, now = () => Date.now()) { this.intervalMs = intervalMs; this.now = now; }
 async run(repository: string, force: boolean, fetch: () => Promise<void>): Promise<void> {
  const previous = this.entries.get(repository);
  if (previous?.pending) {
   try { return await previous.pending; }
   catch (error) {
    if (!force || previous.forced) throw error;
    // A manual retry can use interactive credentials after a background failure.
    return this.run(repository, true, fetch);
   }
  }
  if (!force && previous && this.now() - previous.at < this.intervalMs) {
   if (previous.error) throw previous.error;
   return;
  }
  const entry: { at: number; forced: boolean; pending?: Promise<void>; error?: unknown } = { at: this.now(), forced: force };
  this.entries.set(repository, entry);
  entry.pending = Promise.resolve().then(fetch).catch(error => { entry.error = error; throw error; }).finally(() => {
   entry.at = this.now();
   entry.pending = undefined;
   // Keep a bounded history without evicting active fetches.
   if (this.entries.size > 256) {
    for (const [key, value] of this.entries) {
     if (key !== repository && !value.pending) { this.entries.delete(key); break; }
    }
   }
  });
  return entry.pending;
 }
}
