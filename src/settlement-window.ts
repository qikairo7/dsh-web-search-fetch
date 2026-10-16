/** A bounded grace period for pending lanes after enough useful results arrive. */
export class SettlementWindow {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly started = Date.now();
  constructor(parent?: AbortSignal, private readonly deep = false) {
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
  }
  get endedEarly(): boolean { return this.controller.signal.aborted; }
  observe(sufficient: boolean): void {
    if (!sufficient || this.timer || this.signal.aborted) return;
    const grace = this.deep ? 1500 : 500;
    const minimum = this.deep ? 2500 : 1200;
    this.timer = setTimeout(() => this.controller.abort(new Error('sufficient results; grace period ended')),
      Math.max(grace, minimum - (Date.now() - this.started)));
  }
  finish(): void { if (this.timer) clearTimeout(this.timer); }
}
