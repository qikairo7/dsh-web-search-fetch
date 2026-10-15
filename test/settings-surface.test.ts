import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Config } from '../src/index.js';
import { ZhipuClient } from '../src/engines/zhipu/client.js';
import {
  CREDENTIAL_SLOTS,
  EDITABLE_SETTINGS_PATHS,
  WEB_SEARCH_FETCH_SETTINGS_NAMESPACE,
  isEditableSettingsPath,
  projectCredentialStatus,
  projectEditableSettings,
  readVolatile,
  resolveCredentialRef,
  resolveCredentialRefs,
} from '../src/settings-surface.js';
import type { SettingsSurfaceConfig } from '../src/settings-surface.js';

/** A hand-built volatile stand-in: the same protocol `.volatile()` fields parse into. */
function volatileOf<T>(initial: T): { get(): T; set(next: T): void } {
  let current = initial;
  return {
    get: () => current,
    set: (next) => {
      current = next;
    },
  };
}

/** The parsed Config, with every volatile field read through its reference. */
function plainRefs(config: SettingsSurfaceConfig): Record<string, string | undefined> {
  return {
    zhipu: resolveCredentialRef(config, 'zhipu'),
    anysearch: resolveCredentialRef(config, 'anysearch'),
    zhihu: resolveCredentialRef(config, 'zhihu'),
    siliconflow: resolveCredentialRef(config, 'siliconflow'),
    firecrawl: resolveCredentialRef(config, 'firecrawl'),
  };
}

describe('settings namespace', () => {
  it('命名空间等于 cordis.patch.yml 插入的 entry id', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
    // The settings domain addresses a plugin by its Loader entry id, so the id
    // the bundle inserts and the namespace the card binds must be one value.
    expect(patch).toContain(`- id: ${WEB_SEARCH_FETCH_SETTINGS_NAMESPACE}`);
  });
});

describe('EDITABLE_SETTINGS_PATHS', () => {
  it('每一条都在真实 Config schema 上是 volatile（设置域只服务这些字段）', () => {
    const json = Config.toJSON() as {
      uid: number;
      refs: Record<string, { meta?: { volatile?: boolean }; dict?: Record<string, number> }>;
    };
    const volatileAt = (path: readonly string[]): boolean => {
      let node = json.refs[String(json.uid)];
      for (const segment of path) {
        const next = node?.dict?.[segment];
        if (next === undefined) return false;
        node = json.refs[String(next)];
      }
      return node?.meta?.volatile === true;
    };
    for (const path of EDITABLE_SETTINGS_PATHS) {
      expect(volatileAt(path), path.join('.')).toBe(true);
    }
  });

  it('不把非 volatile 字段谎报为可编辑', () => {
    expect(isEditableSettingsPath(['search', 'zhipuTransport'])).toBe(true);
    expect(isEditableSettingsPath(['apiKeyEnv'])).toBe(true);
    // Ordinary tuning knobs stay out of the served form.
    expect(isEditableSettingsPath(['search', 'rrfK'])).toBe(false);
    expect(isEditableSettingsPath(['search', 'rerank'])).toBe(true);
    // A path that merely shares a prefix is not editable either.
    expect(isEditableSettingsPath(['search'])).toBe(false);
    expect(isEditableSettingsPath(['search', 'zhipuTransport', 'x'])).toBe(false);
  });

  it('覆盖完整接入清单的凭证位需要的全部引用路径', () => {
    for (const slot of CREDENTIAL_SLOTS) {
      for (const path of slot.overridePaths) {
        expect(isEditableSettingsPath(path), `${slot.id}: ${path.join('.')}`).toBe(true);
      }
    }
  });
});

describe('resolveCredentialRefs', () => {
  it('默认 Config 下五槽各取自己的默认引用', () => {
    expect(plainRefs(Config({}))).toEqual({
      zhipu: 'ZHIPU_API_KEY',
      anysearch: 'ANYSEARCH_API_KEY',
      zhihu: 'ZHIHU_ACCESS_SECRET',
      siliconflow: 'SILICONFLOW_API_KEY',
      firecrawl: 'FIRECRAWL_API_KEY',
    });
  });

  it('槽位顺序稳定（卡片按此顺序渲染）', () => {
    expect(CREDENTIAL_SLOTS.map((slot) => slot.id)).toEqual(['anysearch', 'zhipu', 'zhihu', 'firecrawl', 'tavily', 'exa', 'keenable', 'crawl4ai', 'github', 'qianfan', 'doubao-search', 'doubao-fetch', 'tinyfish', 'serply', 'kimi', 'siliconflow', 'dashscope', 'typesafe']);
    expect(resolveCredentialRefs(Config({})).map((slot) => slot.id)).toEqual(
      CREDENTIAL_SLOTS.map((slot) => slot.id),
    );
  });

  it('显式覆盖优先，根 apiKeyEnv 是智谱的第二顺位', () => {
    expect(
      plainRefs(
        Config({
          apiKeyEnv: 'ROOT_KEY',
          search: { zhipuApiKeyEnv: 'SEARCH_KEY' },
        }),
      ).zhipu,
    ).toBe('SEARCH_KEY');
    expect(plainRefs(Config({ apiKeyEnv: 'ROOT_KEY' })).zhipu).toBe('ROOT_KEY');
  });

  it('空串覆盖被跳过（留空沿用下一顺位，而不是把引用名清空）', () => {
    expect(
      plainRefs(Config({ apiKeyEnv: 'ROOT_KEY', search: { zhipuApiKeyEnv: '' } })).zhipu,
    ).toBe('ROOT_KEY');
  });

  it('经 .get() 读取活引用：保存后的新值立刻可见', () => {
    const zhipuRef = volatileOf('OLD_REF');
    const config: SettingsSurfaceConfig = { search: { zhipuApiKeyEnv: zhipuRef } };
    expect(resolveCredentialRef(config, 'zhipu')).toBe('OLD_REF');
    // The settings domain commits a saved edit into this same reference.
    zhipuRef.set('NEW_REF');
    expect(resolveCredentialRef(config, 'zhipu')).toBe('NEW_REF');
  });
});

describe('projectCredentialStatus', () => {
  const slots = resolveCredentialRefs(Config({}));

  it('只输出布尔与引用名——没有任何字段能承载凭证值', () => {
    const rows = projectCredentialStatus(slots, {
      ZHIPU_API_KEY: { configured: true, source: 'file', writable: true },
    });
    const zhipu = rows.find((row) => row.id === 'zhipu');
    expect(zhipu).toEqual({
      id: 'zhipu',
      ref: 'ZHIPU_API_KEY',
      configured: true,
      writable: true,
    });
    expect(Object.keys(zhipu!).sort()).toEqual(['configured', 'id', 'ref', 'writable']);
    // A configured reference reports presence, never the value.
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['configured', 'id', 'ref', 'writable']);
      expect(typeof row.configured).toBe('boolean');
      expect(typeof row.writable).toBe('boolean');
    }
  });

  it('未描述的引用报未配置，缺失 writable 视为可写', () => {
    const rows = projectCredentialStatus(slots, {});
    expect(rows.every((row) => row.configured === false)).toBe(true);
    expect(rows.every((row) => row.writable === true)).toBe(true);
  });

  it('provider 视图上的多余字段不会流到状态行', () => {
    const rows = projectCredentialStatus(slots, {
      // A provider view with an unexpected field must not widen the row.
      ZHIPU_API_KEY: {
        configured: true,
        writable: false,
        source: 'file',
        value: 'leaked-secret',
      } as never,
    });
    const zhipu = rows.find((row) => row.id === 'zhipu');
    expect(zhipu).toEqual({
      id: 'zhipu',
      ref: 'ZHIPU_API_KEY',
      configured: true,
      writable: false,
    });
  });

  it('按引用名而非槽位取事实：两个槽位同名引用时各自独立', () => {
    const shared = resolveCredentialRefs(
      Config({ search: { zhipuApiKeyEnv: 'SHARED', anysearchApiKeyEnv: 'SHARED' } }),
    );
    const rows = projectCredentialStatus(shared, {
      SHARED: { configured: true, writable: true },
    });
    expect(rows.filter((row) => row.ref === 'SHARED')).toHaveLength(2);
    expect(rows.find((row) => row.id === 'zhipu')!.configured).toBe(true);
    expect(rows.find((row) => row.id === 'anysearch')!.configured).toBe(true);
  });
});

describe('projectEditableSettings', () => {
  it('默认通道 anthropic', () => {
    expect(projectEditableSettings(Config({})).zhipuTransport).toBe('anthropic');
  });

  it('未知通道名回落到 anthropic（与 ZhipuClient 的收窄一致）', () => {
    expect(projectEditableSettings({ search: { zhipuTransport: 'nope' } }).zhipuTransport).toBe(
      'anthropic',
    );
  });

  it('经活引用读取：保存后的通道切换立刻可见', () => {
    const transport = volatileOf<string>('anthropic');
    const config: SettingsSurfaceConfig = { search: { zhipuTransport: transport } };
    expect(projectEditableSettings(config).zhipuTransport).toBe('anthropic');
    transport.set('tools-api');
    expect(projectEditableSettings(config).zhipuTransport).toBe('tools-api');
  });
});

describe('readVolatile', () => {
  it('读活引用；普通值原样返回；缺省为 undefined', () => {
    expect(readVolatile(volatileOf('live'))).toBe('live');
    expect(readVolatile('plain')).toBe('plain');
    expect(readVolatile(undefined)).toBeUndefined();
  });
});

describe('ZhipuClient transport liveness', () => {
  it('resolveTransport 每次取值，挂载后切换通道即生效', async () => {
    let current: 'anthropic' | 'tools-api' = 'anthropic';
    const client = new ZhipuClient({
      resolveApiKey: async () => 'unused',
      credentialName: 'ZHIPU_API_KEY',
      resolveTransport: () => current,
      fetchImpl: (() => Promise.reject(new Error('not called'))) as unknown as typeof fetch,
    });
    expect(client.configuredTransport).toBe('anthropic');
    // A volatile settings edit commits into the running reference without a
    // remount, so the client must observe it on the next operation.
    current = 'tools-api';
    expect(client.configuredTransport).toBe('tools-api');
  });

  it('固定 transport 选项仍然可用（手写配置与既有调用方）', () => {
    const client = new ZhipuClient({
      resolveApiKey: async () => 'unused',
      credentialName: 'ZHIPU_API_KEY',
      transport: 'tools-api',
    });
    expect(client.configuredTransport).toBe('tools-api');
  });

  it('resolveTransport 优先于固定 transport，未定义时回落 anthropic', () => {
    const client = new ZhipuClient({
      resolveApiKey: async () => 'unused',
      credentialName: 'ZHIPU_API_KEY',
      transport: 'tools-api',
      resolveTransport: () => undefined,
    });
    expect(client.configuredTransport).toBe('anthropic');
  });
});

describe('client bundle parity', () => {
  it('浏览器半边的槽位表与 node 半边逐字一致', () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    const match = /const CREDENTIAL_SLOTS = (\[[\s\S]*?\n\t\t\]);/.exec(source);
    expect(match, 'client/index.js 里应有 CREDENTIAL_SLOTS 字面量').not.toBeNull();
    // The literal is JSON-shaped on purpose: this parse is the pin. A client
    // bundle cannot import a Host module, so the table is restated there and
    // this test is what keeps the two copies from drifting.
    const clientSlots = JSON.parse(match![1]!) as unknown;
    expect(clientSlots).toEqual(CREDENTIAL_SLOTS);
  });

  it('浏览器半边登记的命名空间与 node 半边一致', () => {
    const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
    expect(source).toContain(`const SETTINGS_NS = "${WEB_SEARCH_FETCH_SETTINGS_NAMESPACE}"`);
  });
});


describe('complete integration credentials', () => {
  it('扩展服务使用与运行时相同的默认引用，豆包提取独立', () => {
    const refs = Object.fromEntries(resolveCredentialRefs(Config({})).map(slot => [slot.id, slot.ref]));
    expect(refs).toMatchObject({ tavily: 'TAVILY_API_KEY', exa: 'EXA_API_KEY', keenable: 'KEENABLE_API_KEY',
      crawl4ai: 'CRAWL4AI_API_KEY', github: 'GITHUB_TOKEN', qianfan: 'QIANFAN_API_KEY',
      'doubao-search': 'DOUBAO_SEARCH_API_KEY', 'doubao-fetch': 'DOUBAO_FETCH_API_KEY' });
  });
  it('扩展配置通过 volatile 根读取自定义凭证与搜索提取分离引用', () => {
    const config = Config({ engines: { doubao: { apiKeyEnv: 'DS', fetchApiKeyEnv: 'DF' }, firecrawl: { apiKeyEnv: 'FS' } },
      fetch: { firecrawlApiKeyEnv: 'FF', anysearchApiKeyEnv: 'AF' } });
    const slots = resolveCredentialRefs(config);
    expect(slots.find(slot => slot.id === 'doubao-search')?.ref).toBe('DS');
    expect(slots.find(slot => slot.id === 'doubao-fetch')?.ref).toBe('DF');
    expect(slots.find(slot => slot.id === 'firecrawl')?.refs).toEqual(['FF', 'FS']);
    expect(slots.find(slot => slot.id === 'anysearch')?.refs).toEqual(['ANYSEARCH_API_KEY', 'AF']);
  });
});
