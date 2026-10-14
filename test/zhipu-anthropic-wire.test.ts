/**
 * Contract tests for the Zhipu Anthropic-compatible channel's pure wire layer:
 * request shaping and the two response layouts (Zhipu's non-standard
 * `tool_result` + Python-repr string, and standard Anthropic
 * `web_search_tool_result`). No HTTP here — the client suite covers transport.
 *
 * Samples mirror the shapes of the reference implementation
 * (PartinGQAQ/dsh-web-search-zhipu, MIT) plus locally built non-standard ones.
 * @module test/zhipu-anthropic-wire
 */
import { describe, expect, it } from 'vitest';
import {
  buildZhipuAnthropicEndpoint,
  buildZhipuAnthropicRequest,
  mapZhipuAnthropicResponse,
  resolveZhipuAnthropicBaseURL,
  resolveZhipuAnthropicMaxUses,
  resolveZhipuAnthropicModel,
  resolveZhipuSearchTransport,
} from '../src/engines/zhipu/anthropic-wire.js';
import type { ZhipuAnthropicResponse } from '../src/types.js';
import { readFixtureJson } from './helpers/fixtures.js';

describe('resolveZhipuSearchTransport / buildZhipuAnthropicEndpoint', () => {
  it('通道名只认 anthropic 与 tools-api；缺省/非法回落 anthropic', () => {
    expect(resolveZhipuSearchTransport('anthropic')).toBe('anthropic');
    expect(resolveZhipuSearchTransport('tools-api')).toBe('tools-api');
    expect(resolveZhipuSearchTransport(undefined)).toBe('anthropic');
    expect(resolveZhipuSearchTransport('')).toBe('anthropic');
    expect(resolveZhipuSearchTransport('nope')).toBe('anthropic');
    expect(resolveZhipuSearchTransport(42)).toBe('anthropic');
  });

  it('baseURL 缺省/空白回落公开 Anthropic 兼容端点', () => {
    expect(resolveZhipuAnthropicBaseURL('https://example.com/api/anthropic/v1')).toBe(
      'https://example.com/api/anthropic/v1',
    );
    expect(resolveZhipuAnthropicBaseURL(undefined)).toBe(
      'https://open.bigmodel.cn/api/anthropic/v1',
    );
    expect(resolveZhipuAnthropicBaseURL('   ')).toBe('https://open.bigmodel.cn/api/anthropic/v1');
    expect(resolveZhipuAnthropicBaseURL(7)).toBe('https://open.bigmodel.cn/api/anthropic/v1');
  });

  it('endpoint = {base}/messages，尾斜杠不产生双斜杠', () => {
    expect(buildZhipuAnthropicEndpoint('https://open.bigmodel.cn/api/anthropic/v1')).toBe(
      'https://open.bigmodel.cn/api/anthropic/v1/messages',
    );
    expect(buildZhipuAnthropicEndpoint('https://open.bigmodel.cn/api/anthropic/v1/')).toBe(
      'https://open.bigmodel.cn/api/anthropic/v1/messages',
    );
    expect(buildZhipuAnthropicEndpoint('http://127.0.0.1:9/api/anthropic/v1///')).toBe(
      'http://127.0.0.1:9/api/anthropic/v1/messages',
    );
  });
});

describe('buildZhipuAnthropicRequest', () => {
  it('按 Anthropic Messages 形状构造：model/max_tokens/tools/messages 四项齐备，且默认流式', () => {
    const request = buildZhipuAnthropicRequest('测试查询');
    expect(request).toEqual({
      model: 'glm-4.6',
      max_tokens: 1_024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [{ role: 'user', content: '测试查询' }],
      // issue #14: the channel's normal mode is an SSE stream with early close.
      stream: true,
    });
  });

  it('stream:false 时省略该字段（非流式回退请求不带 stream）', () => {
    const request = buildZhipuAnthropicRequest('q', { stream: false });
    expect(request).not.toHaveProperty('stream');
    expect(Object.keys(request).sort()).toEqual(['max_tokens', 'messages', 'model', 'tools']);
  });

  it('model 与 maxUses 可配', () => {
    const request = buildZhipuAnthropicRequest('q', { model: 'glm-4.5-air', maxUses: 7 });
    expect(request.model).toBe('glm-4.5-air');
    expect(request.tools[0]!.max_uses).toBe(7);
  });

  it('maxTokens 可配（默认 1024）', () => {
    expect(buildZhipuAnthropicRequest('q', { maxTokens: 2_048 }).max_tokens).toBe(2_048);
  });

  it('非法运行时值回落默认，不把未验证值发给上游', () => {
    const request = buildZhipuAnthropicRequest('q', {
      model: '   ',
      maxUses: 0,
      maxTokens: -1,
    });
    expect(request.model).toBe('glm-4.6');
    expect(request.tools[0]!.max_uses).toBe(1);
    expect(request.max_tokens).toBe(1_024);
    expect(buildZhipuAnthropicRequest('q', { maxUses: 2.5 }).tools[0]!.max_uses).toBe(2);
    expect(buildZhipuAnthropicRequest('q', { maxUses: 'x' as never }).tools[0]!.max_uses).toBe(1);
  });

  it('此通道不做 70 字符截断：query 原样进 messages.content（Anthropic 端自管）', () => {
    const query = `查${'x'.repeat(200)}尾`;
    expect(buildZhipuAnthropicRequest(query).messages[0]!.content).toBe(query);
  });

  it('请求体只带 Messages 面字段，不带工具 API 的 search_engine/content_size/count', () => {
    const request = buildZhipuAnthropicRequest('q', { stream: false });
    expect(Object.keys(request).sort()).toEqual(['max_tokens', 'messages', 'model', 'tools']);
  });

  it('流式请求体只多一个 stream 字段', () => {
    const streamed = Object.keys(buildZhipuAnthropicRequest('q')).sort();
    expect(streamed).toEqual(['max_tokens', 'messages', 'model', 'stream', 'tools']);
  });
});

describe('resolveZhipuAnthropicModel / resolveZhipuAnthropicMaxUses', () => {
  it('合法值透传；缺省/非法回落默认（glm-4.6 / 1）', () => {
    expect(resolveZhipuAnthropicModel('glm-4.6')).toBe('glm-4.6');
    expect(resolveZhipuAnthropicModel(undefined)).toBe('glm-4.6');
    expect(resolveZhipuAnthropicModel(42)).toBe('glm-4.6');
    expect(resolveZhipuAnthropicMaxUses(5)).toBe(5);
    expect(resolveZhipuAnthropicMaxUses(undefined)).toBe(1);
    expect(resolveZhipuAnthropicMaxUses(Number.NaN)).toBe(1);
    expect(resolveZhipuAnthropicMaxUses(0)).toBe(1);
  });
});

describe('mapZhipuAnthropicResponse — 非标 tool_result（Python-repr 字符串）', () => {
  it('真实响应形状回放：link→url、title、content→snippet、date→publishedAt', () => {
    const payload = readFixtureJson<ZhipuAnthropicResponse>('zhipu-anthropic-response.json');
    expect(mapZhipuAnthropicResponse(payload)).toEqual({
      sources: [
        {
          url: 'https://www.sohu.com/a/897879632_121123890',
          title: '2025年5月23日财经早资讯',
          snippet: '一、1-4月我国对外直接投资575.4亿美元，同比增长7.5%。',
          publishedAt: '2025-05-23',
        },
      ],
      truncated: false,
    });
  });

  it('repr 转义与嵌套 text 包装：反斜杠转义还原、多条记录逐条抽出', () => {
    const literal = [
      "[{'text': [",
      "{'title': 'We\\'re launching it', 'link': 'https://example.com/a', 'content': 'hello \\'world\\'', 'refer': 'ref_1'},",
      "{'title': 'Second', 'link': 'https://example.com/b', 'content': 'body', 'refer': 'ref_2'}",
      "]}, {'text': [{'title': 'Third', 'link': 'https://example.com/c', 'content': 'x', 'refer': 'ref_3'}]}]",
    ].join('');
    const payload: ZhipuAnthropicResponse = {
      content: [{ type: 'tool_result', content: literal }],
    };
    expect(mapZhipuAnthropicResponse(payload)).toEqual({
      sources: [
        {
          url: 'https://example.com/a',
          title: "We're launching it",
          snippet: "hello 'world'",
        },
        { url: 'https://example.com/b', title: 'Second', snippet: 'body' },
        { url: 'https://example.com/c', title: 'Third', snippet: 'x' },
      ],
      truncated: false,
    });
  });

  it('换行/制表转义按 Python repr 语义还原', () => {
    const literal = "[{'title': 'T', 'link': 'https://example.com/n', 'content': 'a\\nb\\tc'}]";
    const payload: ZhipuAnthropicResponse = {
      content: [{ type: 'tool_result', content: literal }],
    };
    expect(mapZhipuAnthropicResponse(payload).sources[0]!.snippet).toBe('a\nb\tc');
  });

  it('内容是 JSON 字符串时按 JSON 解析（两种布局都收）', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [
        {
          type: 'tool_result',
          content: JSON.stringify([{ title: 'T', link: 'https://example.com/j', content: 's' }]),
        },
      ],
    };
    expect(mapZhipuAnthropicResponse(payload)).toEqual({
      sources: [{ url: 'https://example.com/j', title: 'T', snippet: 's' }],
      truncated: false,
    });
  });

  it('内容是结构化数组时直接抽取（link 与 url 都认）', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [
        {
          type: 'tool_result',
          content: [
            { title: 'A', link: 'https://example.com/a', content: 'aa' },
            { title: 'B', url: 'https://example.com/b', text: 'bb' },
          ],
        },
      ],
    };
    expect(mapZhipuAnthropicResponse(payload).sources).toEqual([
      { url: 'https://example.com/a', title: 'A', snippet: 'aa' },
      { url: 'https://example.com/b', title: 'B', snippet: 'bb' },
    ]);
  });
});

describe('mapZhipuAnthropicResponse — 标准 Anthropic 布局', () => {
  it('web_search_tool_result 结构化条目 + text 块 citations 补 snippet', () => {
    const payload = readFixtureJson<ZhipuAnthropicResponse>(
      'zhipu-anthropic-standard-response.json',
    );
    expect(mapZhipuAnthropicResponse(payload)).toEqual({
      sources: [
        {
          url: 'https://example.com/std-a',
          title: '标准布局 A',
          publishedAt: '2026-01-02',
          snippet: '引用正文 A',
        },
        { url: 'https://example.com/std-b', title: '标准布局 B' },
      ],
      truncated: false,
    });
  });

  it('条目自带 snippet 时不被 citations 覆盖', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://example.com/x', title: 'X', content: '原文' },
          ],
        },
        { type: 'text', text: '…', citations: [{ url: 'https://example.com/x', cited_text: '引用' }] },
      ],
    };
    expect(mapZhipuAnthropicResponse(payload).sources[0]!.snippet).toBe('原文');
  });

  it('tool_result 的字符串内嵌标准条目也认（web_search_result 的 url 字段）', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [
        {
          type: 'tool_result',
          content: JSON.stringify([{ type: 'web_search_result', url: 'https://example.com/s', title: 'S' }]),
        },
      ],
    };
    expect(mapZhipuAnthropicResponse(payload).sources).toEqual([
      { url: 'https://example.com/s', title: 'S' },
    ]);
  });
});

describe('mapZhipuAnthropicResponse — 去重与丢弃规则', () => {
  it('按 URL 去重（跨块、块内），先出现者胜', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [
        { type: 'tool_result', content: [{ title: 'A', link: 'https://example.com/1', content: 'a' }] },
        {
          type: 'tool_result',
          content: [
            { title: 'B', link: 'https://example.com/1', content: 'b' },
            { title: 'C', link: 'https://example.com/1', content: 'c' },
          ],
        },
      ],
    };
    expect(mapZhipuAnthropicResponse(payload).sources).toEqual([
      { url: 'https://example.com/1', title: 'A', snippet: 'a' },
    ]);
  });

  it('无 URL / 空 URL / 非字符串 URL 的条目丢弃；空字段省略而非编造', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [
        {
          type: 'tool_result',
          content: [
            { title: '无链接' },
            { title: '空链接', link: '   ', content: 'x' },
            { title: 42, link: 'https://example.com/ok', content: '   ', date: '' },
            null,
            'not-an-object',
          ],
        },
      ],
    };
    expect(mapZhipuAnthropicResponse(payload)).toEqual({
      sources: [{ url: 'https://example.com/ok' }],
      truncated: false,
    });
  });

  it('repr 字符串里空 URL 的记录不产出 source', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [
        {
          type: 'tool_result',
          content: "[{'title': 'A', 'link': '', 'content': 'x'}, {'title': 'B', 'link': 'https://e.com/b'}]",
        },
      ],
    };
    expect(mapZhipuAnthropicResponse(payload).sources).toEqual([{ url: 'https://e.com/b', title: 'B' }]);
  });

  it('无结果块（只有 text 块）→ 空 sources，不抛错', () => {
    const payload: ZhipuAnthropicResponse = {
      content: [{ type: 'text', text: '没有触发搜索' }],
    };
    expect(mapZhipuAnthropicResponse(payload)).toEqual({ sources: [], truncated: false });
  });

  it('content 缺失/非数组/响应非对象 → 空 sources', () => {
    expect(mapZhipuAnthropicResponse({}).sources).toEqual([]);
    expect(mapZhipuAnthropicResponse({ content: 'oops' }).sources).toEqual([]);
    expect(mapZhipuAnthropicResponse({ content: [null, 7, 'x'] }).sources).toEqual([]);
  });

  it('空的 repr 字符串与纯空白字符串 → 空 sources', () => {
    if (mapZhipuAnthropicResponse({ content: [{ type: 'tool_result', content: '' }] }).sources.length !== 0) {
      throw new Error('empty repr string must not yield sources');
    }
    expect(
      mapZhipuAnthropicResponse({ content: [{ type: 'tool_result', content: '   ' }] }).sources,
    ).toEqual([]);
  });
});
