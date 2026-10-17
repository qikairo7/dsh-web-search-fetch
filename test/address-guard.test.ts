import { describe, expect, it } from 'vitest';
import { guardTargetAddress, isPrivateAddress, blockedTargetError, systemLookup } from '../src/address-guard.js';
import { AggregatedFetchProvider } from '../src/fetch-pipeline.js';
import { WebError } from '@deepseek-ai/dsh-web';

/** A resolver stand-in that answers from a table and fails for unknown hosts. */
const resolveFrom = (table: Record<string, string[]>) => async (hostname: string) => table[hostname];

describe('isPrivateAddress', () => {
  it('拒绝回环、私网、链路本地、组播与保留地址', () => {
    for (const address of ['127.0.0.1', '127.255.255.254', '10.0.0.8', '172.16.4.2', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '255.255.255.255', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it('放行公网单播地址，含方括号包裹的 IPv6', () => {
    for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '[2606:2800:220:1:248:1893:25c8:1946]']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('非地址文本不判定为私网', () => {
    expect(isPrivateAddress('example.com')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
  });
});

describe('guardTargetAddress', () => {
  it('字面量私网地址直接拒绝，不做 DNS 查询', async () => {
    const verdict = await guardTargetAddress('http://127.0.0.1:3080/', { lookup: async () => { throw new Error('must not resolve'); } });
    expect(verdict.allowed).toBe(false);
    expect(verdict.address).toBe('127.0.0.1');
    expect((await guardTargetAddress('http://[::1]/')).allowed).toBe(false);
  });

  it('主机名解析到私网即拒绝，任一答案是私网就够', async () => {
    const verdict = await guardTargetAddress('https://intranet.test/page', {
      lookup: resolveFrom({ 'intranet.test': ['93.184.216.34', '10.1.2.3'] }),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.address).toBe('10.1.2.3');
  });

  it('解析失败不拦截（无法证明是内网）', async () => {
    const verdict = await guardTargetAddress('https://nowhere.test/', { lookup: resolveFrom({}) });
    expect(verdict).toMatchObject({ allowed: true, reason: 'unresolvable' });
  });

  it('静态域名画像里的主机豁免，含子域且按点边界匹配', async () => {
    const options = { exemptHosts: ['docs.test'], lookup: resolveFrom({ 'docs.test': ['127.0.0.1'], 'cdn.docs.test': ['127.0.0.1'], 'evildocs.test': ['127.0.0.1'] }) };
    expect((await guardTargetAddress('https://docs.test/a', options)).allowed).toBe(true);
    expect((await guardTargetAddress('https://cdn.docs.test/a', options)).allowed).toBe(true);
    expect((await guardTargetAddress('https://evildocs.test/a', options)).allowed).toBe(false);
  });

  it('非 http(s) 与不可解析 URL 交给后面的 URL 校验', async () => {
    expect(await guardTargetAddress('ftp://10.0.0.1/file')).toMatchObject({ allowed: true, reason: 'not-a-url' });
    expect(await guardTargetAddress('not a url')).toMatchObject({ allowed: true, reason: 'not-a-url' });
  });

  it('默认解析器可读真实公网主机名', async () => {
    const addresses = await systemLookup('example.com');
    expect(Array.isArray(addresses)).toBe(true);
  });
});

describe('fetch 面的地址守卫', () => {
  const leg = () => {
    const state = { calls: 0 };
    return {
      state,
      leg: {
        engineId: 'firecrawl',
        async extract(url: string) {
          state.calls += 1;
          return { url, statusCode: 200, body: { kind: 'text' as const, content: 'engine body' }, truncated: false };
        },
      },
    };
  };

  it('内网目标→ WEB_BLOCKED_URL，第三方引擎零调用', async () => {
    const counted = leg();
    const provider = new AggregatedFetchProvider({ legs: [counted.leg], lookup: async () => ['127.0.0.1'] });
    await expect(provider.fetch({ url: 'http://localhost/guide' })).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
    expect(counted.state.calls).toBe(0);
  });

  it('内网字面量在任何适配器与 AIHOT 判定之前被拒绝', async () => {
    let apiCalls = 0;
    const provider = new AggregatedFetchProvider({
      legs: [],
      additionalEngines: [{
        id: 'aihot',
        search: async () => ({ sources: [], truncated: false }),
        readApi: async () => { apiCalls += 1; return undefined; },
      }],
    });
    const error = await provider.fetch({ url: 'http://192.168.0.10/anything' }).catch(value => value);
    expect(error).toBeInstanceOf(WebError);
    expect((error as WebError).code).toBe('WEB_BLOCKED_URL');
    expect(apiCalls).toBe(0);
  });

  it('守卫关闭时按原样继续（测试与显式放行用）', async () => {
    const counted = leg();
    const provider = new AggregatedFetchProvider({ legs: [counted.leg], blockPrivateAddresses: false, lookup: async () => ['127.0.0.1'] });
    await expect(provider.fetch({ url: 'https://intranet.test/guide' })).resolves.toMatchObject({ statusCode: 200 });
    expect(counted.state.calls).toBe(1);
  });

  it('错误文本说明目标属于内网并指出放行方式', async () => {
    const error = blockedTargetError('http://127.0.0.1/', '127.0.0.1');
    expect(error.code).toBe('WEB_BLOCKED_URL');
    expect(error.message).toContain('内网');
    expect(error.message).toContain('staticDomains');
  });
});
