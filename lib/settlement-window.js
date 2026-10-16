/** A bounded grace period for pending lanes after enough useful results arrive. */
export class SettlementWindow {
    deep;
    controller = new AbortController();
    signal;
    timer;
    started = Date.now();
    constructor(parent, deep = false) {
        this.deep = deep;
        this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal;
    }
    get endedEarly() { return this.controller.signal.aborted; }
    observe(sufficient) {
        if (!sufficient || this.timer || this.signal.aborted)
            return;
        const grace = this.deep ? 1500 : 500;
        const minimum = this.deep ? 2500 : 1200;
        this.timer = setTimeout(() => this.controller.abort(new Error('sufficient results; grace period ended')), Math.max(grace, minimum - (Date.now() - this.started)));
    }
    finish() { if (this.timer)
        clearTimeout(this.timer); }
}
