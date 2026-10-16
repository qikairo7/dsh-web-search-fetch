/**
 * URL-aware conditional orchestration for the aggregated fetch provider
 * (DESIGN.md 提取管线, GLOSSARY 条件编排/择优, DESIGN.md — concurrent
 * aggregation, never a serial fallback chain).
 *
 * Three layers, all deliberately engine-agnostic and dependency-injected so
 * every acceptance item of issue #9 is unit-testable without network:
 *
 * 1. {@link classifyFetchRoute} — the pure URL-aware rule table: obviously
 *    static resources (known extensions, configured static-domain profiles)
 *    route to the zero-cost single HTTP fetch; everything else (PDFs, unknown
 *    or missing extensions, anti-bot suspicion) routes to the dynamic path.
 * 2. The dynamic path: all non-broken engines are dispatched **concurrently**
 *    with a per-engine deadline; failures and timeouts are logged and
 *    dropped, breaker signals are forwarded verbatim, and 200-with-empty
 *    bodies count as invalid (no score).
 * 3. {@link selectBestCandidate} — 择优: engine weight + body length + body
 *    density + title match pick one complete body; the remaining engines
 *    degrade to consistency signals (title similarity + body hash) that only
 *    reach the log and never change the return value.
 *
 * Failure selection when every engine loses takes the **most specific**
 * `WEB_*` code (a `WEB_BLOCKED_URL` beats a generic `WEB_PROVIDER_ERROR`).
 * An aborted outer signal always yields `WEB_ABORTED`.
 * @module fetch-aggregate
 */
import { createHash } from 'node:crypto';
import { organizeDocuments } from './fetch-document/organize.js';
import { operationNotes, requestCount, deadlineReached, currentDecisionDepth, noteOperation } from './request-budget.js';
import { SettlementWindow } from './settlement-window.js';
import { markdown, splitBlocks, cleanBlocks, challengeBlocks } from './fetch-document/blocks.js';
import { WebError } from '@deepseek-ai/dsh-web';
import type { WebFetchResult } from '@deepseek-ai/dsh-web';
import type { BreakerSignal, CircuitBreaker } from './breaker/index.js';
import { FirecrawlError } from './engines/firecrawl/client.js';
import { failureSignalOf } from './engines/anysearch/engine.js';

// ---------------------------------------------------------------------------
// URL 感知分流（规则表：可配、可单测的纯函数）
// ---------------------------------------------------------------------------

/** The two dispatch routes of the fetch pipeline. */
export type FetchRoute = 'static' | 'dynamic';

/**
 * Default static-extension table (the issue's `.txt/.xml/.json/.md/.csv 等`).
 * Extensions not in this list — `.pdf`, `.html`, no extension, unknown —
 * route dynamic (DESIGN.md: PDF and unknown pages go to the engine bundle).
 */
export const DEFAULT_STATIC_EXTENSIONS: readonly string[] = [
  'txt',
  'text',
  'xml',
  'json',
  'md',
  'markdown',
  'csv',
  'tsv',
  'rss',
  'atom',
  'yaml',
  'yml',
  'log',
  'ini',
  'toml',
  'ics',
  'vtt',
  'srt',
];

/** Routing knobs; every field has a production default. */
export interface FetchRouteOptions {
  /** `false` disables URL awareness entirely: every fetch goes through HTTP. */
  readonly enabled?: boolean;
  /** Static extension table; entries may carry a leading dot and any case. */
  readonly staticExtensions?: readonly string[];
  /** Static-domain profiles: exact host or any subdomain of it (dot-bounded). */
  readonly staticDomains?: readonly string[];
}

/**
 * Decide the route for one URL. Rules, in order:
 *
 * 1. Routing disabled → `static` (the pass-through configuration).
 * 2. Unparseable or non-HTTP(S) URLs → `static`, so the HTTP fetcher — which
 *    owns URL validation — answers with `WEB_INVALID_URL`.
 * 3. Host equal to, or a dot-bounded subdomain of, a configured static
 *    domain → `static` (the domain profile wins over the path).
 * 4. Last path segment carries an extension from the table → `static`.
 * 5. Everything else → `dynamic`.
 */
export function classifyFetchRoute(rawUrl: string, options: FetchRouteOptions = {}): FetchRoute {
  if (options.enabled === false) return 'static';
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'static';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'static';

  const host = url.hostname.toLowerCase();
  for (const domain of options.staticDomains ?? []) {
    const normalized = domain.trim().toLowerCase().replace(/^\.+/, '');
    if (normalized.length === 0) continue;
    if (host === normalized || host.endsWith(`.${normalized}`)) return 'static';
  }

  const lastSegment = url.pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  if (dot > 0) {
    const extension = lastSegment.slice(dot + 1).toLowerCase();
    const table = options.staticExtensions ?? DEFAULT_STATIC_EXTENSIONS;
    if (table.some((entry) => entry.replace(/^\./, '').toLowerCase() === extension)) return 'static';
  }
  return 'dynamic';
}

// ---------------------------------------------------------------------------
// 质量信号（择优：引擎权重 + 正文长度 + 正文密度 + 标题匹配）
// ---------------------------------------------------------------------------

/** Default per-engine weights (DESIGN.md: firecrawl highest, others behind). */
export const DEFAULT_ENGINE_WEIGHTS: Readonly<Record<string, number>> = {
  firecrawl: 3,
  anysearch: 2,
};

/** Weight given to an engine with no explicit or default entry. */
export const DEFAULT_UNKNOWN_ENGINE_WEIGHT = 2;

/** Body length (in characters) at which the length score saturates. */
export const LENGTH_SCORE_FULL_CHARS = 2_000;

/** Maximum length score, added at {@link LENGTH_SCORE_FULL_CHARS} characters. */
export const LENGTH_SCORE_MAX = 2;

/** Maximum weight of the text-density signal (text characters / total). */
export const DENSITY_SCORE_MAX = 1;

/** Maximum weight of the slug-vs-title match signal. */
export const TITLE_MATCH_SCORE_MAX = 1.5;

/** How much of the body head is searched for its title. */
export const TITLE_WINDOW_CHARS = 500;

/** Default per-engine extraction budget (DESIGN.md: ≤45 s per engine). */
export const DEFAULT_FETCH_ENGINE_TIMEOUT_MS = 45_000;

/** One candidate that entered selection. */
export interface FetchCandidate {
  readonly engineId: string;
  readonly result: WebFetchResult;
  readonly receivedAt?: string;
}

/** Per-signal breakdown behind a candidate's score, for tests and logs. */
export interface CandidateScoreBreakdown {
  readonly weight: number;
  readonly length: number;
  readonly density: number;
  readonly titleMatch: number;
}

/** A scored candidate. */
export interface ScoredCandidate extends FetchCandidate {
  readonly score: number;
  readonly breakdown: CandidateScoreBreakdown;
}

/** The body text of a fetch result (both closed-union arms carry `content`). */
function bodyText(result: WebFetchResult): string {
  return result.body.content;
}

/**
 * Whether a candidate counts as a usable body: a 200-with-empty (or
 * pure-whitespace) body is invalid and gets no score (issue #9 acceptance).
 */
export function isUsableCandidate(result: WebFetchResult): boolean {
  return bodyText(result).trim().length > 0;
}

/**
 * Fraction of "word" characters (Unicode letters/digits) in the body — the
 * text/total density signal. Markup- or boilerplate-heavy scrapes score low;
 * solid prose scores high.
 */
function densityRatio(text: string): number {
  if (text.length === 0) return 0;
  const matches = text.match(/[\p{L}\p{N}]/gu);
  return (matches?.length ?? 0) / text.length;
}

/** The final path segment of a URL, separators normalized to spaces, lowercased. */
export function extractUrlSlug(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return '';
  }
  const lastSegment = decodeSafely(url.pathname.split('/').pop() ?? '');
  const dot = lastSegment.lastIndexOf('.');
  const withoutExtension = dot > 0 ? lastSegment.slice(0, dot) : lastSegment;
  return withoutExtension
    .replace(/[-_.+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The body's title, simplified per the issue: within the first
 * {@link TITLE_WINDOW_CHARS} characters, the first markdown heading wins;
 * otherwise the first non-empty line. Empty when neither exists.
 */
export function extractBodyTitle(text: string): string {
  const window = text.slice(0, TITLE_WINDOW_CHARS);
  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(window);
  if (heading !== null) {
    return heading[1]!.trim().replace(/#+$/, '').trim();
  }
  for (const line of window.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** Token set for similarity: Unicode letter/digit runs, lowercased. */
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/** Jaccard similarity of two titles' token sets; empty input scores 0. */
export function titleSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return intersection / union;
}

/** Consistency fingerprint: first 8 hex digits of the sha1 of the body. */
export function bodyFingerprint(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8);
}

/** Resolve one engine's weight: explicit override, built-in default, unknown default. */
function engineWeight(engineId: string, overrides?: Partial<Record<string, number>>): number {
  const override = overrides?.[engineId];
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  const builtin = DEFAULT_ENGINE_WEIGHTS[engineId];
  return builtin ?? DEFAULT_UNKNOWN_ENGINE_WEIGHT;
}

/**
 * Score one candidate: engine weight + body length (capped) + body density +
 * slug-vs-title match. Deterministic and pure, so selection is reproducible.
 */
export function scoreCandidate(
  engineId: string,
  result: WebFetchResult,
  requestUrl: string,
  weights: Partial<Record<string, number>> = DEFAULT_ENGINE_WEIGHTS,
): ScoredCandidate {
  const text = bodyText(result);
  const breakdown: CandidateScoreBreakdown = {
    weight: engineWeight(engineId, weights),
    length: Math.min(text.length / LENGTH_SCORE_FULL_CHARS, 1) * LENGTH_SCORE_MAX,
    density: densityRatio(text) * DENSITY_SCORE_MAX,
    titleMatch:
      titleSimilarity(extractUrlSlug(requestUrl), extractBodyTitle(text)) * TITLE_MATCH_SCORE_MAX,
  };
  const score = breakdown.weight + breakdown.length + breakdown.density + breakdown.titleMatch;
  return { engineId, result, score, breakdown };
}

/**
 * 择优: pick the highest-scoring usable candidate; ties go to the earlier
 * candidate (engine dispatch order). Unusable (empty-body) candidates are
 * excluded; `best` is `undefined` only when nothing usable came back.
 */
export function selectBestCandidate(
  requestUrl: string,
  candidates: readonly FetchCandidate[],
  weights: Partial<Record<string, number>> = DEFAULT_ENGINE_WEIGHTS,
): { best: ScoredCandidate | undefined; scored: readonly ScoredCandidate[] } {
  const scored: ScoredCandidate[] = [];
  let best: ScoredCandidate | undefined;
  for (const candidate of candidates) {
    if (!isUsableCandidate(candidate.result)) continue;
    const entry = scoreCandidate(candidate.engineId, candidate.result, requestUrl, weights);
    scored.push(entry);
    if (best === undefined || entry.score > best.score) best = entry;
  }
  return { best, scored };
}

// ---------------------------------------------------------------------------
// 熔断信号转发（词表 rate-limit / quota-exhausted / insufficient-credits 直传）
// ---------------------------------------------------------------------------

/**
 * Read Firecrawl's breaker signal off a caught error: the `breaker`-classified
 * `FirecrawlFailure` already carries the vocabulary-conform signal (`402` →
 * `insufficient-credits`, `429` → `rate-limit` with the Retry-After hint).
 */
export function firecrawlBreakerSignal(error: unknown): BreakerSignal | undefined {
  if (!(error instanceof FirecrawlError)) return undefined;
  const classification = error.classification;
  if (classification.class !== 'breaker') return undefined;
  return classification.signal;
}

/**
 * Read AnySearch's breaker signal: the engine's failure classification maps
 * `rate-limit` and `quota-exhausted` onto the breaker's vocabulary verbatim
 * (`failureSignalOf` accepts both the engine error and a `WebError` wrapper).
 */
export function anysearchBreakerSignal(error: unknown): BreakerSignal | undefined {
  const signal = failureSignalOf(error);
  if (signal === undefined) return undefined;
  if (signal.kind === 'rate-limit') {
    return signal.retryAfterMs === undefined
      ? { kind: 'rate-limit' }
      : { kind: 'rate-limit', retryAfterMs: signal.retryAfterMs };
  }
  if (signal.kind === 'quota-exhausted') return { kind: 'quota-exhausted' };
  return undefined;
}

// ---------------------------------------------------------------------------
// 动态路径编排（多路并发、单路限时、熔断跳过、择优返回）
// ---------------------------------------------------------------------------

/**
 * One engine leg of the dynamic path. `extract` resolves a normalized
 * {@link WebFetchResult} (engine mapping already closed-union); `signalOf`
 * optionally classifies a thrown error into a breaker signal.
 */
export interface FetchEngineLeg {
  readonly engineId: string;
  extract(url: string, signal?: AbortSignal): Promise<WebFetchResult>;
  signalOf?(error: unknown): BreakerSignal | undefined;
}

/** Minimal logger surface the pipeline needs; `ctx.logger` satisfies it. */
export interface FetchPipelineLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Inputs of {@link aggregateDynamicFetch}. */
export interface AggregateDynamicFetchOptions {
  readonly settleEarly?: boolean;
  readonly mode?: 'organize' | 'select';
  readonly maxOutputChars?: number;
  readonly url: string;
  readonly legs: readonly FetchEngineLeg[];
  readonly signal?: AbortSignal;
  readonly breaker?: CircuitBreaker;
  readonly logger?: FetchPipelineLogger;
  /** Per-engine deadline; defaults to {@link DEFAULT_FETCH_ENGINE_TIMEOUT_MS}. */
  readonly perEngineTimeoutMs?: number;
  /** Engine-weight overrides for selection; missing entries keep defaults. */
  readonly engineWeights?: Partial<Record<string, number>>;
}

/** Specificity ranking for the all-failed error (higher wins). */
const SPECIFIC_CODE_RANK: Readonly<Record<string, number>> = {
  WEB_BLOCKED_URL: 6,
  WEB_INVALID_URL: 5,
  WEB_FETCH_TOO_LARGE: 4,
  WEB_UNSUPPORTED_CONTENT_TYPE: 3,
  WEB_FETCH_TIMEOUT: 2,
};

interface LegFailureNote {
  readonly engineId: string;
  readonly code: string;
  readonly description: string;
}

/** Rank a failure code: known specific codes beat unknown ones beat `WEB_PROVIDER_ERROR`. */
function failureRank(code: string): number {
  return SPECIFIC_CODE_RANK[code] ?? (code === 'WEB_PROVIDER_ERROR' ? 0 : 1);
}

/**
 * Run the dynamic path for one URL: dispatch every non-broken engine
 * concurrently (each with its own deadline), forward breaker signals, pick the
 * best usable body (择优), log consistency signals for the losers, and only
 * throw after every engine lost — with the most specific error code observed.
 */
export async function aggregateDynamicFetch(
  options: AggregateDynamicFetchOptions,
): Promise<WebFetchResult> {
  const { url, legs, signal, breaker, logger } = options;
  const timeoutMs = options.perEngineTimeoutMs ?? DEFAULT_FETCH_ENGINE_TIMEOUT_MS;
  const weights = options.engineWeights ?? {};

  if (legs.length === 0) {
    throw new WebError('no extraction engines are configured', 'WEB_PROVIDER_ERROR');
  }
  if (isAborted(signal)) {
    throw new WebError('fetch aborted', 'WEB_ABORTED', { cause: signal?.reason });
  }

  const active: FetchEngineLeg[] = [];
  for (const leg of legs) {
    if (breaker?.isBroken(leg.engineId) === true) {
      logger?.warn(`[提取] 引擎 ${leg.engineId} 处于熔断，已跳过`);
      continue;
    }
    active.push(leg);
  }
  if (active.length === 0) {
    throw new WebError('all extraction engines are broken', 'WEB_PROVIDER_ERROR');
  }

  const candidatesByLeg: (FetchCandidate | undefined)[] = new Array(active.length);
  const notes: LegFailureNote[] = [];
  const window = new SettlementWindow(signal, currentDecisionDepth() === 'deep');
  const substantial = new Map<string, { title: string; anchors: Set<string> }>();

  const runLeg = async (leg: FetchEngineLeg, index: number): Promise<void> => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const composed = AbortSignal.any([window.signal, deadline]);
    try {
      const result = await raceWithAbort(leg.extract(url, composed), composed);
      if (!isUsableCandidate(result)) {
        logger?.warn(`[提取] 引擎 ${leg.engineId} 返回空正文，候选无效`);
        notes.push({ engineId: leg.engineId, code: 'WEB_PROVIDER_ERROR', description: 'empty body' });
        return;
      }
      candidatesByLeg[index] = { engineId: leg.engineId, result, receivedAt: new Date().toISOString() };
      if (options.mode === 'organize' && options.settleEarly !== false && result.statusCode >= 200 && result.statusCode < 300 && result.url === url) {
        const blocks = cleanBlocks(splitBlocks(markdown(bodyText(result), result.body.kind)));
        const paragraphs = blocks.filter(block => block.kind === 'paragraph').map(block => block.text.replace(/\s+/g, ' ').trim());
        if (!challengeBlocks(blocks) && paragraphs.join(' ').length >= 1200) substantial.set(leg.engineId, {
          title: (blocks.find(block => block.kind === 'heading')?.key ?? '').split(/\s+(?:—|\||-)\s+/)[0]!.toLowerCase(),
          anchors: new Set(blocks.filter(block => block.kind === 'paragraph' && block.text.length >= 100).map(block => block.key)),
        });
        const bodies = [...substantial.values()];
        const agreement = new Map<string, number>();
        for (const body of bodies) for (const anchor of body.anchors) {
          const key = `${body.title}\n${anchor}`;
          agreement.set(key, (agreement.get(key) ?? 0) + 1);
        }
        window.observe([...agreement.values()].some(count => count >= 3));
      }
      logger?.info(`[提取] 服务 ${leg.engineId} 成功：状态 ${result.statusCode}，正文 ${bodyText(result).length} 字符`);
    } catch (error) {
      if (window.endedEarly && !isAborted(signal)) return;
      if (isAborted(signal)) {
        // The outer abort wins; classification happens after all legs settle.
        notes.push({ engineId: leg.engineId, code: 'WEB_ABORTED', description: 'aborted' });
        return;
      }
      if (deadline.aborted) {
        logger?.warn(`[提取] 引擎 ${leg.engineId} 超时（${timeoutMs} ms），已丢弃`);
        notes.push({
          engineId: leg.engineId,
          code: 'WEB_FETCH_TIMEOUT',
          description: `timed out after ${timeoutMs} ms`,
        });
        return;
      }
      const code = error instanceof WebError ? error.code : 'WEB_PROVIDER_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn(`[提取] 引擎 ${leg.engineId} 失败：${message}`);
      notes.push({ engineId: leg.engineId, code, description: message });
      const breakerSignal = leg.signalOf?.(error);
      if (breakerSignal !== undefined) breaker?.recordSignal(leg.engineId, breakerSignal);
    }
  };

  // Each lane races its own signal, so all settle promptly on total cancellation.
  try { await Promise.allSettled(active.map(runLeg)); }
  finally { window.finish(); }
  if (window.endedEarly) noteOperation('已有至少三路可互补且有共同正文的提取，宽限等待结束后提前取消慢渠道；未完成内容未纳入整理。');

  if (isAborted(signal) && !deadlineReached()) {
    throw new WebError('fetch aborted', 'WEB_ABORTED', { cause: signal?.reason });
  }
  const candidates = candidatesByLeg.filter((candidate): candidate is FetchCandidate => candidate !== undefined);
  if (candidates.length === 0) {
    if (deadlineReached()) throw new WebError('fetch deadline exceeded', 'WEB_FETCH_TIMEOUT');
    throw allFailedError(notes);
  }

  if (options.mode === 'organize') {
    const output = organizeDocuments(url, candidates, options.maxOutputChars, [
      ...notes.map(note => `${note.engineId}: ${note.code}`), ...operationNotes(),
      ...(window.endedEarly ? ['多路正文充分后提前结束等待，保留已完成结果。'] : []), `本插件 HTTP 请求：${requestCount()} 次。`,
    ]);
    logger?.info(`[提取] 已整理 ${candidates.length} 路结果，输出 ${output.body.content.length} 字符；请求 ${requestCount()} 次。`);
    return { ...output, truncated: window.endedEarly || output.truncated || deadlineReached() || notes.some(note => note.code === 'WEB_FETCH_TIMEOUT') };
  }

  const selection = selectBestCandidate(url, candidates, weights);
  const best = selection.best;
  if (best === undefined) {
    throw allFailedError(notes);
  }

  logger?.info(
    `[提取] 择优 ${best.engineId}（得分 ${best.score.toFixed(2)}）；正文哈希 ${bodyFingerprint(bodyText(best.result))}`,
  );
  const bestTitle = extractBodyTitle(bodyText(best.result));
  for (const scored of selection.scored) {
    if (scored === best) continue;
    const otherText = bodyText(scored.result);
    logger?.info(
      `[提取] 一致性信号：${scored.engineId} vs ${best.engineId} 标题相似度 ${titleSimilarity(
        bestTitle,
        extractBodyTitle(otherText),
      ).toFixed(2)}，正文哈希 ${bodyFingerprint(otherText)}`,
    );
  }
  return { ...best.result, truncated: best.result.truncated || deadlineReached() };
}

/**
 * Read "the outer signal fired" through a function call, so control-flow
 * narrowing of `signal.aborted` elsewhere in this module cannot turn the
 * re-checks into statically-dead comparisons (the object is externally
 * mutated by `abort()` while the legs are in flight).
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Compose the all-failed error: every leg's reason, the most specific code. */
function allFailedError(notes: readonly LegFailureNote[]): WebError {
  let best = notes[0];
  for (const note of notes) {
    if (best === undefined || failureRank(note.code) > failureRank(best.code)) best = note;
  }
  const detail = notes.map((note) => `${note.engineId}: ${note.description}`).join('; ');
  return new WebError(
    `all extraction engines failed: ${detail}`,
    best?.code ?? 'WEB_PROVIDER_ERROR',
  );
}

/**
 * Await `work`, but resolve early (as an abort error) the moment the outer
 * signal fires — a leg that ignores its signal must not hold the pipeline to
 * its own deadline. The abort rejection is always a `WEB_ABORTED` `WebError`.
 */
async function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return await work;
  }
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new WebError('fetch aborted', 'WEB_ABORTED', { cause: signal.reason }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, abort]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** Decode a URL path segment best-effort; malformed percent-escapes pass through. */
function decodeSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
