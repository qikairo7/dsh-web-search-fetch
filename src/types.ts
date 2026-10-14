/**
 * Wire-level types for upstream engines. Fields are deliberately `unknown`:
 * the mapping layer narrows them at runtime, so an upstream that lies cannot
 * smuggle a non-string into the seam (see `WebSearchSource`'s doc comment in
 * `@deepseek-ai/dsh-web` — forcing adapters to invent fields makes the seam lie).
 * @module types
 */

/** Zhipu search_engine档位（docs.bigmodel.cn 网络搜索 search_engine 枚举）。 */
export type ZhipuSearchEngine =
  | 'search_std'
  | 'search_pro'
  | 'search_pro_sogou'
  | 'search_pro_quark';

/** 搜索正文粒度（docs.bigmodel.cn content_size）。 */
export type ZhipuContentSize = 'medium' | 'high';

/**
 * Zhipu 搜索面的传输通道（issue #12）：
 * - `anthropic`：Anthropic 兼容端点 `{base}/messages` + 服务端 `web_search_20250305` 工具，消耗 GLM Coding Plan 额度；
 * - `tools-api`：`/paas/v4/web_search` 工具 API，按次计费。
 */
export type ZhipuSearchTransport = 'anthropic' | 'tools-api';

/** Zhipu web_search request body (docs.bigmodel.cn, 工具-api/网络搜索). */
export interface ZhipuSearchRequest {
  /** Search engine tier; defaults to `search_pro` (DESIGN.md). */
  readonly search_engine: ZhipuSearchEngine;
  /** Query text, capped at the API's 70-character limit. */
  readonly search_query: string;
  /** Intent recognition is always skipped, explicitly. */
  readonly search_intent: false;
  /** Result count, aligned to the seam's `maxResults` (1–50). */
  readonly count?: number;
  /** Snippet granularity; defaults to `medium`. */
  readonly content_size?: ZhipuContentSize;
}

/** One `search_result[]` entry as delivered; every field is narrowed before use. */
export interface ZhipuSearchResultItem {
  readonly title?: unknown;
  readonly content?: unknown;
  readonly link?: unknown;
  readonly media?: unknown;
  readonly icon?: unknown;
  readonly refer?: unknown;
  readonly publish_date?: unknown;
}

/** Zhipu web_search response envelope; only `search_result` is consumed. */
export interface ZhipuSearchResponse {
  readonly id?: unknown;
  readonly created?: unknown;
  readonly request_id?: unknown;
  readonly search_intent?: unknown;
  readonly search_result?: unknown;
}

/** 一个 Anthropic Messages 服务端工具声明（`web_search_20250305`）。 */
export interface ZhipuAnthropicTool {
  /** 固定 `web_search_20250305`：服务端搜索工具版本标识。 */
  readonly type: 'web_search_20250305';
  /** 工具名，固定 `web_search`。 */
  readonly name: 'web_search';
  /** 单次请求最多执行的搜索次数。 */
  readonly max_uses: number;
}

/** 一条 Messages 消息（本通道只发单条 user 消息，content 为查询字符串）。 */
export interface ZhipuAnthropicMessage {
  readonly role: 'user';
  readonly content: string;
}

/** Anthropic Messages 请求体（Zhipu 兼容端点）。 */
export interface ZhipuAnthropicRequest {
  /** GLM 模型名；默认 `glm-4.6`。 */
  readonly model: string;
  /** 生成上限；默认 1024。 */
  readonly max_tokens: number;
  /** 服务端搜索工具声明（单元素数组）。 */
  readonly tools: readonly ZhipuAnthropicTool[];
  /** 单条 user 消息，content 为查询原文（此通道不做 70 字符截断）。 */
  readonly messages: readonly ZhipuAnthropicMessage[];
  /**
   * 流式请求标记（issue #14）：`true` 时上游按 SSE 逐帧返回内容块。
   * 省略即非流式 JSON 响应（回退路径用）。
   */
  readonly stream?: true;
}

/**
 * Messages 响应里的一个内容块。字段故意宽：块类型是上游控制的字符串，
 * 两种布局（非标 `tool_result` 与标准 `web_search_tool_result`）共用此形状，
 * 由映射层按 `type` 分流并在运行时窄化每个字段。
 */
export interface ZhipuAnthropicBlock {
  readonly type?: unknown;
  readonly content?: unknown;
  readonly text?: unknown;
  readonly citations?: unknown;
}

/**
 * Anthropic Messages 响应信封；只消费 `content` 块数组。
 * 智谱实际返回 `tool_result`（内容为 Python-repr 风格字符串），
 * 标准 Anthropic 布局返回 `web_search_tool_result`（结构化数组）。
 */
export interface ZhipuAnthropicResponse {
  readonly id?: unknown;
  readonly type?: unknown;
  readonly role?: unknown;
  readonly model?: unknown;
  readonly content?: unknown;
  readonly stop_reason?: unknown;
  readonly usage?: unknown;
}
