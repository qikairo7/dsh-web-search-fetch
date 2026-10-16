/** A bounded grace period for pending lanes after enough useful results arrive. */
export declare class SettlementWindow {
    private readonly deep;
    private readonly controller;
    readonly signal: AbortSignal;
    private timer?;
    private readonly started;
    constructor(parent?: AbortSignal, deep?: boolean);
    get endedEarly(): boolean;
    observe(sufficient: boolean): void;
    finish(): void;
}
