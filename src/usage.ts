export type UsageRecord = { threadId: string; at: number; tokens: number };
export type UsageData = { since: number; totals: Record<string, number>; records: UsageRecord[] };
const day = 86400000;
/** Store cumulative checkpoints separately from timestamped increments to avoid double counting on resume. */
export class UsageStore {
  readonly data: UsageData;
  constructor(saved?: UsageData, now = Date.now()) {
    this.data = saved ?? { since: now, totals: {}, records: [] };
    this.prune(now);
  }
  baseline(threadId: string, tokens: number) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) return;
    this.data.totals[threadId] = Math.max(this.data.totals[threadId] ?? 0, tokens);
  }
  update(threadId: string, tokens: number, restored = false, now = Date.now()) {
    if (!Number.isSafeInteger(tokens) || tokens < 0) return;
    const previous = this.data.totals[threadId];
    const delta = tokens - (previous ?? (restored ? tokens : 0));
    this.baseline(threadId, tokens);
    if (delta > 0) this.data.records.push({threadId, at: now, tokens: delta});
    this.prune(now);
  }
  summary(threadId?: string, now = Date.now()) {
    this.prune(now);
    return { session: threadId ? this.data.totals[threadId] ?? null : 0,
      day: this.sum(now - day), week: this.sum(now - 7 * day), month: this.sum(now - 30 * day), since: this.data.since };
  }
  private sum(after: number) { return this.data.records.reduce((sum, record) => sum + (record.at >= after ? record.tokens : 0), 0); }
  private prune(now: number) { this.data.records = this.data.records.filter(record => record.at >= now - 30 * day); }
}
