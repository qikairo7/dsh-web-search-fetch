import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADDITIONAL_ENGINE_DEFAULTS } from '../src/engines/additional/index.js';

/**
 * Execution smoke test of the browser half.
 *
 * `client/index.js` is a classic script that hands a factory to
 * `window.__ModuleLoader__`; nothing in the Node build touches it, so without
 * this test the tab's registration contract and its save path would go
 * unverified until a real GUI session. The test stubs the two globals the
 * bundle actually uses (the loader facade and `require`) and the page context
 * `apply` reaches, then drives the controller through a save.
 */

/** React stand-ins: the bundle only builds elements, it never renders here. */
const effectCleanups: (() => void)[] = [];
const reactStub = {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props,
    children,
  }),
  useId: () => 'test-id',
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => unknown) => {
    const cleanup = effect();
    if (typeof cleanup === 'function') effectCleanups.push(cleanup as () => void);
  },
};
const jsxRuntimeStub = {
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  Fragment: Symbol('Fragment'),
};
const storeStub = {
  createSnapshotStore: (initial: unknown) => {
    let snapshot = initial;
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set: (next: unknown) => {
        snapshot = next;
        for (const listener of listeners) listener();
      },
    };
  },
};
const primitivesStub = {
  SettingsForm: 'SettingsForm',
  SettingsSecretField: 'SettingsSecretField',
  SegmentedControl: 'SegmentedControl',
  StateDot: 'StateDot',
  Tag: 'Tag',
  Button: 'Button',
  Switch: 'Switch',
  Input: 'Input',
  Checkbox: 'Checkbox',
  SettingsValueField: 'SettingsValueField',
};

/** The modules the bundle is allowed to require, mirroring the platform seeds. */
const seedModules: Record<string, unknown> = {
  react: reactStub,
  'react/jsx-runtime': jsxRuntimeStub,
  '@deepseek-ai/dsh-client-store': storeStub,
  '@deepseek-ai/dsh-client-ui-primitives': primitivesStub,
};

interface Registered {
  id: string;
  factory: (require: (spec: string) => unknown) => Record<string, unknown>;
}

/** Load the bundle and return the module it registers. */
function loadBundle(): { registration: Registered; module: Record<string, any> } {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
  const registrations: Registered[] = [];
  const windowStub = {
    __ModuleLoader__: {
      load: (registration: Registered) => {
        registrations.push(registration);
      },
    },
  };
  const require = (spec: string): unknown => {
    if (!(spec in seedModules)) throw new Error(`unexpected require("${spec}")`);
    return seedModules[spec];
  };
  // The bundle is a classic script; evaluate it with only the two globals it
  // declares a dependency on.
  new Function('window', 'require', source)(windowStub, require);
  expect(registrations).toHaveLength(1);
  const registration = registrations[0]!;
  return { registration, module: registration.factory(require) };
}

/** A settings scope stand-in with the staged-value and mutate contract. */
function createScope(options: {
  value?: unknown;
  writable?: boolean;
  status?: 'loading' | 'ready' | 'unavailable';
  revision?: number;
}): {
  scope: Record<string, unknown>;
  mutations: { op: string; path: readonly string[]; value?: unknown }[][];
  revisions: (number | undefined)[];
  setValue: (next: unknown) => void;
} {
  const mutations: { op: string; path: readonly string[]; value?: unknown }[][] = [];
  const revisions: (number | undefined)[] = [];
  let snapshot = {
    status: options.status ?? 'ready',
    value: options.value,
    base: {},
    user: {},
    writable: options.writable ?? true,
    revision: options.revision ?? 1,
  };
  const listeners = new Set<() => void>();
  const scope = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate: async (
      ops: { op: string; path: readonly string[]; value?: unknown }[],
      expectedRevision?: number,
    ) => {
      mutations.push(ops);
      revisions.push(expectedRevision);
      return true;
    },
  };
  return {
    scope,
    mutations,
    revisions,
    setValue: (next: unknown) => {
      snapshot = { ...snapshot, value: next, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
    },
  };
}

/** A page context stand-in covering exactly what `apply` and the card touch. */
function createPageContext(config: {
  scope: Record<string, unknown>;
  describe?: (refs: string[]) => unknown;
  set?: (ref: string, value: string) => unknown;
}): {
  ctx: Record<string, any>;
  registrations: { options: Record<string, any>; component: unknown }[];
  localeRegistrations: Record<string, unknown>[];
  effects: string[];
  eventHandlers: Map<string, (payload: unknown) => void>;
} {
  const registrations: { options: Record<string, any>; component: unknown }[] = [];
  const localeRegistrations: Record<string, unknown>[] = [];
  const effects: string[] = [];
  const eventHandlers = new Map<string, (payload: unknown) => void>();
  const served = new Set(['web-search-fetch']);
  const describe =
    config.describe ?? (() => ({ ok: true, value: {} }));
  const set = config.set ?? (() => ({ ok: true, value: undefined }));
  const ctx = {
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    locale: {
      bind: () => (key: string) => key,
      register: (ns: string, bundles: unknown) => {
        localeRegistrations.push({ ns, bundles });
        return () => {};
      },
      getSnapshot: () => ({ revision: 1 }),
      subscribe: () => () => {},
    },
    slots: {
      inject: (_name: string, register: () => unknown) => {
        register();
        return () => {};
      },
      register: (options: Record<string, any>, component: unknown) => {
        registrations.push({ options, component });
        return () => {};
      },
      entries: () => [],
      subscribe: () => () => {},
      getVersion: () => 0,
    },
    configForms: {
      get: () => config.scope,
      whileServed: (namespaces: string[], register: (served: Set<string>) => unknown) => {
        if (namespaces.some((ns) => served.has(ns))) register(served);
        return () => {};
      },
    },
    remote: {
      credentials: { describe, set },
      $on: (event: string, handler: (payload: unknown) => void) => {
        eventHandlers.set(event, handler);
        return () => {};
      },
    },
    effect: (factory: () => unknown, label?: string) => {
      effects.push(label ?? '');
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
  };
  return { ctx, registrations, localeRegistrations, effects, eventHandlers };
}

describe('client bundle', () => {
  it('package.json 声明了宿主发现客户端半边所需的字段', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      name: string;
      exports?: Record<string, unknown>;
      files?: string[];
      dsh?: {
        client?: { platform?: string; inject?: string[] };
        compatibility?: { dsh?: string; dshReleases?: Record<string, string> };
      };
    };
    // The host scanner reads dsh.client (platform must be "web"), resolves
    // exports["./client"] to a real file, and requires that file to ship.
    expect(manifest.dsh?.client?.platform).toBe('web');
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-api-remotes');
    // The package that DECLARES the slot this tab registers into must be
    // injected: registering into an undeclared slot throws at plugin load, so a
    // wrong owner here is a blank tab, not a degraded one.
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-settings-plugins');
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-plugin-manager');
    expect(manifest.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-ui-settings');
    const clientExport = manifest.exports?.['./client'];
    expect(clientExport, 'exports["./client"] 必须存在').toBeDefined();
    // The scanner accepts a string or an object with a string default.
    const clientPath =
      typeof clientExport === 'string'
        ? clientExport
        : (clientExport as { default?: string } | undefined)?.default;
    expect(typeof clientPath).toBe('string');
    const resolved = new URL(`../${clientPath!.replace(/^\.\//, '')}`, import.meta.url);
    expect(existsSync(resolved), `client 产物应存在：${clientPath}`).toBe(true);
    expect(manifest.files).toContain('client/**/*.js');
    // The bundle registers under its own package name, which is the id the
    // scanner addresses it by.
    expect(manifest.name).toBe('dsh-web-search-fetch');
    expect(manifest.dsh?.compatibility?.dsh).toBe('0.2.1-rc.2');
    expect(manifest.dsh?.compatibility?.dshReleases).toMatchObject({
      '0.2.1-alpha.2': 'compatible',
      '0.2.1-alpha.3': 'compatible',
      '0.2.1-alpha.4': 'compatible',
      '0.2.1-alpha.5': 'compatible',
      '0.2.1-rc.2': 'compatible',
    });
  });

  it('注册的 id 与包名一致，factory 暴露 apply / inject / NS', () => {
    const { registration, module } = loadBundle();
    expect(registration.id).toBe('dsh-web-search-fetch');
    expect(typeof module.apply).toBe('function');
    expect(module.NS).toBe('settings.webSearchFetch');
    expect(module.inject).toEqual([
      'slots',
      'locale',
      'remote',
      'remote.credentials',
      'configForms',
    ]);
  });

  it('只 require 平台种子模块（构建期外部依赖不漂移）', () => {
    const { module } = loadBundle();
    expect(typeof module.apply).toBe('function');
    // loadBundle's require throws on anything outside the seed table, so
    // reaching this line proves the bundle asked for nothing else.
  });

  it('apply 注册 zh/en 双语并把 tab 挂进 settings.plugins.tab', () => {
    const { module } = loadBundle();
    const { scope } = createScope({ value: {} });
    const page = createPageContext({ scope });
    module.apply(page.ctx);

    const dictionaries = page.localeRegistrations.find(
      (entry) => entry.ns === 'settings.webSearchFetch',
    );
    expect(dictionaries).toBeDefined();
    const bundles = dictionaries!.bundles as { zh: Record<string, string>; en: Record<string, string> };
    expect(Object.keys(bundles.zh).length).toBeGreaterThan(0);
    // Same key set in both dictionaries, so a locale switch cannot miss copy.
    expect(Object.keys(bundles.en).sort()).toEqual(Object.keys(bundles.zh).sort());

    const tab = page.registrations.find((entry) => entry.options.name === 'settings.plugins.tab');
    expect(tab, '应注册 settings.plugins.tab').toBeDefined();
    expect(tab!.options.id).toBe('web-search-fetch');
    expect(typeof tab!.options.order).toBe('number');
    expect(tab!.options.locale).toBe('settings.webSearchFetch');
    expect(typeof tab!.component).toBe('function');
  });

  it('未服务该命名空间时不注册任何 tab（部署里无痕）', () => {
    const { module } = loadBundle();
    const { scope } = createScope({ value: {} });
    const page = createPageContext({ scope });
    // The watched namespace is not served: whileServed must not call back.
    page.ctx.configForms.whileServed = (namespaces: string[], register: () => unknown) => {
      if (namespaces.includes('never-served')) register();
      return () => {};
    };
    module.apply(page.ctx);
    expect(page.registrations.filter((e) => e.options.name === 'settings.plugins.tab')).toHaveLength(0);
  });

  it('注入面暴露 hook 与四个动作，hook 名符合 use<Name> 约定', () => {
    const { module } = loadBundle();
    const { scope } = createScope({ value: {} });
    const page = createPageContext({ scope });
    module.apply(page.ctx);
    const tab = page.registrations.find((entry) => entry.options.name === 'settings.plugins.tab')!;
    const face = tab.options.inject() as Record<string, any>;
    expect(Object.keys(face.hooks)).toEqual(['webSearchFetch']);
    // The renderer derives the prop name from the hook key; the component reads
    // props.useWebSearchFetch, so the two must agree.
    expect(typeof face.hooks.webSearchFetch.getSnapshot).toBe('function');
    for (const action of ['editKey', 'editDecision', 'chooseStart', 'editService', 'editControl', 'editNumber', 'editParticipation', 'save', 'discard']) {
      expect(typeof face[action], action).toBe('function');
    }
  });
});

describe('card controller', () => {
  /** Mount the card and hand back the injected face plus the page stubs. */
  function mount(options: {
    value?: unknown;
    writable?: boolean;
    revision?: number;
    describe?: (refs: string[]) => unknown;
    set?: (ref: string, value: string) => unknown;
  }): {
    face: Record<string, any>;
    page: ReturnType<typeof createPageContext>;
    scope: ReturnType<typeof createScope>;
  } {
    const { module } = loadBundle();
    const scope = createScope({
      value: options.value,
      writable: options.writable,
      revision: options.revision,
    });
    const page = createPageContext({ scope: scope.scope, describe: options.describe, set: options.set });
    module.apply(page.ctx);
    const tab = page.registrations.find((entry) => entry.options.name === 'settings.plugins.tab')!;
    const face = tab.options.inject() as Record<string, any>;
    return { face, page, scope };
  }

  it('投影出完整十四个凭证位', () => {
    const { face } = mount({ value: {} });
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.keys.map((row: { id: string }) => row.id)).toEqual(['anysearch', 'deepseek', 'firecrawl', 'tavily', 'exa', 'keenable', 'crawl4ai', 'github', 'tinyfish', 'serply', 'kimi', 'siliconflow', 'dashscope', 'typesafe']);
    expect(state.keys.every((row: { text: string }) => row.text === '')).toBe(true);
    expect(state.writable).toBe(true);
  });

  it('首次匿名选择暂存固定预设与匿名参与范围，保存不写任何凭证', async () => {
    const writes: string[] = [];
    const { face, scope } = mount({ value: {}, set: ref => { writes.push(ref); return { ok: true }; } });
    expect(face.hooks.webSearchFetch.getSnapshot().controls.preset).toBe('auto');
    expect(face.hooks.webSearchFetch.getSnapshot().anonymousServiceIds).toEqual([]);
    await face.refresh();
    face.chooseStart('anonymous');
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.controls.preset).toBe('custom');
    expect(state.controls.searchServices).toEqual(['anysearch', 'firecrawl', 'tavily']);
    expect(state.controls.fetchServices).toEqual(state.controls.searchServices);
    expect(Object.entries(state.controls.serviceEnabled).filter(([, enabled]) => enabled).map(([id]) => id))
      .toEqual(['anysearch', 'firecrawl', 'tavily', 'http']);
    expect(scope.mutations).toHaveLength(0);
    face.discard();
    expect(face.hooks.webSearchFetch.getSnapshot().controls.preset).toBe('auto');
    face.chooseStart('anonymous');
    await face.save();
    expect(writes).toEqual([]);
    expect(scope.mutations.flat()).toContainEqual({ op: 'set', path: ['controls', 'preset'], value: 'custom' });
  });

  it('匿名选择排除已有或部分凭证、自定义端点与密钥草稿，保留原设置字段', async () => {
    const { face, scope } = mount({ value: {
      engines: { tavily: { baseURL: 'https://custom.example', apiKeyEnv: 'CUSTOM_TV' } },
      search: { anysearchApiKeyEnv: 'AS_SEARCH' }, fetch: { anysearchApiKeyEnv: 'AS_FETCH' },
    }, describe: refs => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'AS_SEARCH', writable: true }])) }) });
    await face.refresh();
    expect(face.hooks.webSearchFetch.getSnapshot().anonymousServiceIds).toEqual(['firecrawl']);
    face.editKey('firecrawl', 'fixture-draft');
    face.chooseStart('anonymous');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.preset).toBe('auto');
    face.editKey('firecrawl', '');
    face.chooseStart('anonymous');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.fetchServices).toEqual(['firecrawl']);
    await face.save();
    expect(scope.mutations.flat().some(op => op.path.includes('baseURL') || op.path.includes('apiKeyEnv'))).toBe(false);
  });

  it('自动配置入口展开调用设置，沿用模型和凭证的分阶段保存', async () => {
    const { face } = mount({ value: { controls: { preset: 'custom' } } });
    face.chooseStart('auto');
    expect(face.hooks.webSearchFetch.getSnapshot().view.callSettingsOpen).toBe(true);
    expect(face.hooks.webSearchFetch.getSnapshot().controls.preset).toBe('auto');
    face.editDecision('jev-latest');
    face.editKey('typesafe', 'fixture-draft');
    face.discard();
    expect(face.hooks.webSearchFetch.getSnapshot().decisionModel).toBe('decision-model-preview');
    expect(face.hooks.webSearchFetch.getSnapshot().keys.every((row: { text: string }) => row.text === '')).toBe(true);
  });

  it('自动配置入口只在激活后聚焦模型，不在其他更新时抢走焦点', () => {
    const { face, page } = mount({ value: { controls: { preset: 'auto' } } });
    const effects: (() => unknown)[] = [];
    const originalEffect = reactStub.useEffect;
    reactStub.useEffect = effect => { effects.push(effect); };
    try {
      const tab = page.registrations.find(entry => entry.options.name === 'settings.plugins.tab')!;
      const tree = (tab.component as (props: unknown) => unknown)({ ...face, t: (key: string) => key,
        useWebSearchFetch: (select: (value: unknown) => unknown) => select(face.hooks.webSearchFetch.getSnapshot()) });
      const nodes: any[] = [];
      const visit = (node: any): void => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== 'object') return;
        nodes.push(node); visit(node.props?.children);
      };
      visit(tree);
      const calls: string[] = [];
      nodes.find(node => node.props?.id === 'wsf-decision-model').props.ref.current = {
        focus: () => calls.push('focus'), scrollIntoView: ({ block }: { block: string }) => calls.push(block),
      };
      effects[1]!();
      expect(calls).toEqual([]);
      nodes.find(node => node.props?.children === 'setupAuto').props.onClick();
      effects[1]!();
      effects[1]!();
      expect(calls).toEqual(['focus', 'center']);
    } finally { reactStub.useEffect = originalEffect; }
  });

  it('只读或状态读取失败时不能选择匿名配置', async () => {
    const { face, scope } = mount({ value: {}, writable: false });
    await face.refresh();
    face.chooseStart('anonymous');
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
    expect(scope.mutations).toEqual([]);
    const broken = mount({ value: {}, describe: () => ({ ok: false }) });
    await broken.face.refresh();
    expect(broken.face.hooks.webSearchFetch.getSnapshot().anonymousServiceIds).toEqual([]);
  });

  it('五款决策模型暂存、撤销并保存到独立字段，不修改服务开关', async () => {
    const { face, scope } = mount({ value: { search: { decisionModel: 'decision-model-preview' } } });
    for (const model of ['Kev-4b', 'SemIf', 'diffusiongemma', 'decision-model-preview', 'jev-latest']) {
      face.editDecision(model);
      expect(face.hooks.webSearchFetch.getSnapshot().decisionModel).toBe(model);
    }
    face.discard();
    expect(face.hooks.webSearchFetch.getSnapshot().decisionModel).toBe('decision-model-preview');
    face.editDecision('jev-latest');
    await face.save();
    expect(scope.mutations).toEqual([[{ op: 'set', path: ['search', 'decisionModel'], value: 'jev-latest' }]]);
    scope.setValue({ search: { decisionModel: 'jev-latest' } });
    expect(face.hooks.webSearchFetch.getSnapshot().decisionModel).toBe('jev-latest');
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
  });

  it('按已服务的引用名询问凭证状态，且只投影布尔', async () => {
    const described: string[][] = [];
    const { face } = mount({
      value: {},
      describe: (refs) => {
        described.push(refs);
        return {
          ok: true,
          value: {
            ANYSEARCH_API_KEY: { configured: true, writable: true, source: 'file', value: 'secret' },
          },
        };
      },
    });
    await Promise.resolve();
    expect(described[0]).toContain('ANYSEARCH_API_KEY');
    expect(described[0]).toContain('FIRECRAWL_API_KEY');
    const state = face.hooks.webSearchFetch.getSnapshot();
    const anysearch = state.keys.find((row: { id: string }) => row.id === 'anysearch');
    expect(anysearch.configured).toBe(true);
    // The provider view carried a value; the projection must not.
    expect(JSON.stringify(state)).not.toContain('secret');
  });

  it('填写 key 后按引用名写入凭证域', async () => {
    const writes: { ref: string; value: string }[] = [];
    const { face } = mount({
      value: {},
      set: (ref, value) => {
        writes.push({ ref, value });
        return { ok: true, value: undefined };
      },
    });
    face.editKey('anysearch', 'sk-live-value');
    await face.save();
    expect(writes).toEqual([{ ref: 'ANYSEARCH_API_KEY', value: 'sk-live-value' }]);
    // The literal must not survive in the card's own render state.
    expect(face.hooks.webSearchFetch.getSnapshot().keys.every((r: { text: string }) => r.text === '')).toBe(
      true,
    );
  });

  it('留空保持：空白草稿不写入凭证域，也不清空既有 key', async () => {
    const writes: { ref: string; value: string }[] = [];
    const { face } = mount({
      value: {},
      set: (ref, value) => {
        writes.push({ ref, value });
        return { ok: true, value: undefined };
      },
    });
    face.editKey('anysearch', '   ');
    await face.save();
    expect(writes).toEqual([]);
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
  });

  it('空白草稿不会覆盖此前已暂存的值', async () => {
    const writes: { ref: string; value: string }[] = [];
    const { face } = mount({
      value: {},
      set: (ref, value) => {
        writes.push({ ref, value });
        return { ok: true, value: undefined };
      },
    });
    face.editKey('anysearch', 'sk-first');
    face.editKey('anysearch', '');
    await face.save();
    expect(writes).toEqual([]);
  });

  it('只读部署拒绝保存', async () => {
    const writes: { ref: string; value: string }[] = [];
    const { face, scope } = mount({
      value: {},
      writable: false,
      set: (ref, value) => {
        writes.push({ ref, value });
        return { ok: true, value: undefined };
      },
    });
    face.editKey('anysearch', 'sk-live');
    await face.save();
    expect(writes).toEqual([]);
    expect(scope.mutations).toHaveLength(0);
    expect(face.hooks.webSearchFetch.getSnapshot().writable).toBe(false);
  });

  it('凭证写入被拒时保留草稿并标记失败', async () => {
    const { face } = mount({
      value: {},
      set: () => ({ ok: false, error: { code: 'credential/rejected', message: 'read-only' } }),
    });
    face.editKey('anysearch', 'sk-live');
    await face.save();
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.failed).toBe(true);
    // The draft is kept so the user can correct it rather than retype.
    expect(state.dirty).toBe(true);
  });

  it('discard 丢弃全部草稿', async () => {
    const { face } = mount({ value: {} });
    face.editKey('tavily', 'secret-draft');
    face.discard();
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.dirty).toBe(false);
  });

  it('凭证变更事件只对受监视引用触发重读', async () => {
    const described: string[][] = [];
    const { face, page } = mount({
      value: {},
      describe: (refs) => {
        described.push(refs);
        return { ok: true, value: {} };
      },
    });
    await Promise.resolve();
    const before = described.length;
    const handler = page.eventHandlers.get('credentials/reference-updated')!;
    handler('UNRELATED_REF');
    await Promise.resolve();
    expect(described.length).toBe(before);
    handler('ANYSEARCH_API_KEY');
    await Promise.resolve();
    expect(described.length).toBeGreaterThan(before);
  });

  it('描述调用失败时不把凭证报成未配置（保持未知）', async () => {
    const { face } = mount({
      value: {},
      describe: () => {
        throw new Error('gateway down');
      },
    });
    await Promise.resolve();
    const state = face.hooks.webSearchFetch.getSnapshot();
    // The card still renders; no row claims a false negative from a failed read.
    expect(state.keys).toHaveLength(14);
    expect(state.keys.every((row: { configured: boolean }) => row.configured === false)).toBe(true);
  });

  it('注册了凭证失效事件与表单清理 effect', () => {
    const { page } = mount({ value: {} });
    expect(page.eventHandlers.has('credentials/reference-updated')).toBe(true);
    expect(page.effects.some((label) => label.includes('credential invalidations'))).toBe(true);
  });

  it('同时注册旧设置页与 rc.2 插件详情配置页', () => {
    const { page } = mount({ value: {} });
    const settingsTab = page.registrations.find(entry => entry.options.name === 'settings.plugins.tab');
    const bundleConfig = page.registrations.find(entry => entry.options.name === 'plugins.bundle.config');
    expect(settingsTab?.options.id).toBe('web-search-fetch');
    expect(bundleConfig?.options.key).toBe('dsh-web-search-fetch');
    expect(bundleConfig?.options.locale).toBe('settings.webSearchFetch');
    const face = bundleConfig!.options.inject() as Record<string, unknown>;
    expect(face.hooks).toHaveProperty('webSearchFetch');
    expect(typeof face.save).toBe('function');
  });
  it('扩展引擎开关作为路径编辑保存，保留原有配置', async () => {
    const { face, scope } = mount({ value: { engines: { tavily: { enabled: true, apiKeyEnv: 'CUSTOM', baseURL: 'https://example.com' } } }, revision: 9 });
    face.editEngine('tavily', false);
    face.editEngine('exa', true);
    await face.save();
    expect(scope.mutations[0]).toEqual([
      { op: 'set', path: ['engines', 'tavily', 'enabled'], value: false },
      { op: 'set', path: ['engines', 'exa', 'enabled'], value: true },
    ]);
    expect(scope.revisions).toEqual([9]);
  });

  it('Firecrawl 搜索与提取拆分引用时两者同时更新', async () => {
    const writes: string[] = [];
    const { face } = mount({ value: { fetch: { firecrawlApiKeyEnv: 'FC_FETCH' }, engines: { firecrawl: { apiKeyEnv: 'FC_SEARCH' } } },
      set: (ref) => { writes.push(ref); return { ok: true }; } });
    face.editKey('firecrawl', 'fixture');
    await face.save();
    expect(writes).toEqual(['FC_FETCH', 'FC_SEARCH']);
  });

  it('凭证引用在输入期间变化时拒绝向新引用写入旧草稿', async () => {
    const writes: string[] = [];
    const { face, scope } = mount({ value: { engines: { tavily: { apiKeyEnv: 'OLD_REF' } } },
      set: ref => { writes.push(ref); return { ok: true }; } });
    face.editKey('tavily', 'fixture');
    scope.setValue({ engines: { tavily: { apiKeyEnv: 'NEW_REF' } } });
    await face.save();
    expect(writes).toEqual([]);
    expect(face.hooks.webSearchFetch.getSnapshot().failed).toBe(true);
  });


  // Complete inventory and interaction regressions.
  it('服务列表包含每一个后端扩展和 README 接入项，匿名服务不新增凭证位', () => {
    const { face, page } = mount({ value: {} });
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.visibleServiceIds).toEqual(expect.arrayContaining(Object.keys(ADDITIONAL_ENGINE_DEFAULTS)));
    expect(state.visibleServiceIds).toHaveLength(15);
    const bundles = page.localeRegistrations[0]!.bundles as { zh: Record<string, string> };
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const id of state.visibleServiceIds) expect(readme).toContain(bundles.zh[id + '-service']);
    expect(state.keys.some((row: { id: string }) => ['bing', 'aihot', 'http'].includes(row.id))).toBe(false);
    expect(state.keys.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining(['tinyfish', 'serply']));
  });

  it('搜索、能力与状态筛选保留所有未保存输入，放弃更改恢复配置', async () => {
    const { face } = mount({ value: { engines: { aihot: { enabled: false } } } });
    await Promise.resolve();
    face.editView({ query: 'Google' });
    expect(face.hooks.webSearchFetch.getSnapshot().visibleServiceIds).toEqual(['serply']);
    face.editView({ query: 'Serply' });
    expect(face.hooks.webSearchFetch.getSnapshot().visibleServiceIds).toEqual(['serply']);
    face.editView({ query: '' });
    face.toggleService('tinyfish');
    face.editKey('tinyfish', 'fixture-key');
    face.editEngine('aihot', true);
    face.editView({ query: 'Bing', capability: 'search' });
    let state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.visibleServiceIds).toEqual(['bing']);
    expect(state.dirty).toBe(true);
    expect(state.changeCount).toBe(2);
    face.editView({ query: '', capability: 'all', status: 'pending' });
    state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.visibleServiceIds).toEqual(['tinyfish', 'aihot']);
    expect(state.keys.find((row: { id: string }) => row.id === 'tinyfish').text).toBe('fixture-key');
    face.discard();
    state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.visibleServiceIds).toEqual([]);
    expect(state.engines.aihot).toBe(false);
    expect(state.dirty).toBe(false);
  });

  it('匿名服务可保存开关，但没有凭证写入', async () => {
    const writes: string[] = [];
    const { face, scope } = mount({ value: { engines: { aihot: { enabled: false }, bing: {} } },
      set: (ref) => { writes.push(ref); return { ok: true }; } });
    face.editEngine('aihot', true);
    face.editEngine('bing', false);
    await face.save();
    expect(scope.mutations[0]).toEqual([
      { op: 'set', path: ['engines', 'aihot', 'enabled'], value: true },
      { op: 'set', path: ['engines', 'bing', 'enabled'], value: false },
    ]);
    expect(writes).toEqual([]);
    expect(face.hooks.webSearchFetch.getSnapshot().saved).toBe(true);
  });

  it('配置已保存但密钥失败后，重试不会再用旧 revision 重写配置', async () => {
    let refused = true;
    const { face, scope } = mount({ value: { engines: { tinyfish: { enabled: false } } },
      set: () => ({ ok: !refused }) });
    face.editEngine('tinyfish', true);
    face.editKey('tinyfish', 'fixture-key');
    await face.save();
    expect(face.hooks.webSearchFetch.getSnapshot().failed).toBe(true);
    refused = false;
    await face.save();
    expect(scope.mutations).toHaveLength(1);
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
    expect(face.hooks.webSearchFetch.getSnapshot().saved).toBe(true);
  });

  it('正文模式与预算按字段保存，保留自定义端点和未编辑的控制字段', async () => {
    const { face, scope } = mount({ value: { controls: { mode: 'organize', preset: 'custom', maxRequests: 32, searchServices: ['anysearch', 'kimi'], extra: 'preserve' }, engines: { kimi: { baseURL: 'https://custom.example' } } } });
    face.editControl('mode', 'select');
    face.editControl('maxRequests', 2);
    face.editParticipation('kimi', 'search', false);
    await face.save();
    expect(scope.mutations[0]).toEqual([
      { op: 'set', path: ['controls', 'mode'], value: 'select' },
      { op: 'set', path: ['controls', 'maxRequests'], value: 2 },
      { op: 'set', path: ['controls', 'searchServices'], value: ['anysearch'] },
    ]);
    expect(face.hooks.webSearchFetch.getSnapshot().controls.extra).toBe('preserve');
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
  });
  it('搜索 13 路、提取 11 路的上限配置不被旧范围误判', () => {
    const { face } = mount({ value: { controls: { maxSearchServices: 13, maxFetchServices: 11 } } });
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.invalid).toBe(false);
    expect(state.numberFields.maxSearchServices.text).toBe('13');
    expect(state.numberFields.maxFetchServices.text).toBe('11');
  });
  it('非法预算不形成草稿，放弃更改恢复整理设置', () => {
    const { face } = mount({ value: { controls: { mode: 'organize', maxRequests: 32 } } });
    face.editControl('maxRequests', 0);
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
    face.editControl('mode', 'select');
    face.discard();
    expect(face.hooks.webSearchFetch.getSnapshot().controls.mode).toBe('organize');
  });

  /** Drive the rendered input, including the old bare number input. */
  function editRequestInput(face: Record<string, any>, page: ReturnType<typeof createPageContext>, text: string) {
    const tab = page.registrations.find(entry => entry.options.id === 'web-search-fetch')!;
    const component = tab.component as (props: Record<string, any>) => any;
    const tree = component({ ...face, t: (key: string) => key,
      useWebSearchFetch: (select: (state: any) => any) => select(face.hooks.webSearchFetch.getSnapshot()) });
    const nodes: any[] = [];
    function visit(node: any) {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      visit(node.props?.children);
    }
    visit(tree);
    const input = nodes.find(node => node.props?.id === 'wsf-limit-maxRequests')
      ?? nodes.find(node => node.type === 'input' && node.props.type === 'number' && node.props.value === 32);
    expect(input, 'request limit must be editable').toBeDefined();
    if (input.props.onEdit) input.props.onEdit(text);
    else input.props.onChange({ target: { value: text } });
  }

  it('清空数值输入保留草稿并阻止写入，而不是立即恢复原数字', async () => {
    const { face, page, scope } = mount({ value: { controls: { maxRequests: 32 } } });
    editRequestInput(face, page, '');
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.dirty).toBe(true);
    expect(state.invalid).toBe(true);
    expect(state.numberFields.maxRequests.text).toBe('');
    await face.save();
    expect(scope.mutations).toHaveLength(0);
    editRequestInput(face, page, '32');
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
  });

  it('超出范围的输入保留错误，连同凭证草稿一起阻止保存', async () => {
    const writes: string[] = [];
    const { face, page, scope } = mount({ value: { controls: { maxRequests: 32 } },
      set: ref => { writes.push(ref); return { ok: true }; } });
    editRequestInput(face, page, '0');
    face.editKey('tavily', 'test-fixture');
    expect(face.hooks.webSearchFetch.getSnapshot().invalid).toBe(true);
    await face.save();
    expect(scope.mutations).toHaveLength(0);
    expect(writes).toHaveLength(0);
    face.discard();
    expect(face.hooks.webSearchFetch.getSnapshot().invalid).toBe(false);
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
  });

  it('修正数值后只保存对应字段，筛选服务不会丢掉数字草稿', async () => {
    const { face, page, scope } = mount({ value: { controls: { maxRequests: 32 } }, revision: 7 });
    editRequestInput(face, page, '24');
    face.editView({ query: 'Kimi' });
    expect(face.hooks.webSearchFetch.getSnapshot().numberFields.maxRequests.text).toBe('24');
    expect(face.hooks.webSearchFetch.getSnapshot().changeCount).toBe(1);
    await face.save();
    expect(scope.mutations).toEqual([[{ op: 'set', path: ['controls', 'maxRequests'], value: 24 }]]);
    expect(scope.revisions).toEqual([7]);
  });

  it('保存中关闭立即清除可见草稿，延迟部分失败不恢复密钥，也不撤销已接受的写入', async () => {
    let finish!: (value: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>(resolve => { finish = resolve; });
    const writes: string[] = [];
    const { face, page, scope } = mount({ value: { controls: { maxRequests: 32 } },
      set: ref => { writes.push(ref); return ref === 'TAVILY_API_KEY' ? pending : { ok: false }; } });
    face.editKey('tavily', 'test-fixture-1');
    face.editKey('exa', 'test-fixture-2');
    editRequestInput(face, page, '24');
    const saving = face.save();
    await Promise.resolve();
    expect(writes).toEqual(['TAVILY_API_KEY']);
    effectCleanups.at(-1)!();
    expect(face.hooks.webSearchFetch.getSnapshot().keys.every((row: { text: string }) => row.text === '')).toBe(true);
    finish({ ok: true });
    await saving;
    expect(writes).toEqual(['TAVILY_API_KEY', 'EXA_API_KEY']);
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.dirty).toBe(false);
    expect(state.numberFields.maxRequests.dirty).toBe(false);
    expect(state.saved).toBe(false);
    expect(scope.mutations).toEqual([[{ op: 'set', path: ['controls', 'maxRequests'], value: 24 }]]);
  });
  it('全部服务统一提供启停状态，基础服务关闭不改参与范围或凭证', async () => {
    const { face, scope } = mount({ value: { controls: { searchServices: ['anysearch', 'tavily'], fetchServices: ['anysearch'] } } });
    expect(Object.keys(face.hooks.webSearchFetch.getSnapshot().engines)).toHaveLength(15);
    face.editService('anysearch', false);
    face.editService('tavily', false);
    face.editService('http', false);
    const state = face.hooks.webSearchFetch.getSnapshot();
    expect(state.engines.anysearch).toBe(false);
    expect(state.engines.http).toBe(false);
    expect(state.controls.searchServices).toEqual(['anysearch', 'tavily']);
    expect(state.controls.fetchServices).toEqual(['anysearch']);
    await face.save();
    expect(scope.mutations).toEqual([[{ op: 'set', path: ['controls', 'serviceEnabled'], value: { anysearch: false, http: false } }]]);
  });
  it('统一开关尊重原重排配置，恢复基础服务原状态会清除草稿', async () => {
    const { face, scope } = mount({ value: { search: { rerank: false } } });
    expect(face.hooks.webSearchFetch.getSnapshot().engines.siliconflow).toBe(false);
    face.editService('anysearch', false);
    face.editService('anysearch', true);
    expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
    face.editService('siliconflow', true);
    await face.save();
    expect(scope.mutations).toEqual([[{ op: 'set', path: ['controls', 'serviceEnabled'], value: { siliconflow: true } }]]);
  });
  it('统一扩展开关同时保存启停控制，保留自定义端点与凭证引用', async () => {
    const { face, scope } = mount({ value: { engines: { firecrawl: { enabled: true, baseURL: 'https://custom.example', apiKeyEnv: 'CUSTOM_FC' } } } });
    face.editService('firecrawl', false);
    expect(face.hooks.webSearchFetch.getSnapshot().changedServiceIds).toContain('firecrawl');
    await face.save();
    expect(scope.mutations).toEqual([[
      { op: 'set', path: ['controls', 'serviceEnabled'], value: { firecrawl: false } },
    ]]);
  });

  it('旧 Firecrawl 搜索关闭或缺省时总开关仍反映可用提取，切回原状态不改旧搜索配置', () => {
    for (const value of [{}, { engines: { firecrawl: { enabled: false } } }]) {
      const { face } = mount({ value });
      expect(face.hooks.webSearchFetch.getSnapshot().engines.firecrawl).toBe(true);
      expect(face.hooks.webSearchFetch.getSnapshot().firecrawlSearchEnabled).toBe(false);
      face.editService('firecrawl', false);
      face.editService('firecrawl', true);
      expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
      expect(face.hooks.webSearchFetch.getSnapshot().firecrawlSearchEnabled).toBe(false);
    }
  });

  it('扩展服务切回原总开关状态时恢复原字段，不产生隐藏草稿', () => {
    for (const value of [
      { engines: { tavily: { enabled: true } }, controls: { serviceEnabled: { tavily: false } } },
      { engines: { tavily: { enabled: false } } },
    ]) {
      const { face } = mount({ value });
      expect(face.hooks.webSearchFetch.getSnapshot().engines.tavily).toBe(false);
      face.editService('tavily', true);
      expect(face.hooks.webSearchFetch.getSnapshot().engines.tavily).toBe(true);
      face.editService('tavily', false);
      expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
    }
  });

  it('Firecrawl 参与搜索切回原有效状态时还原旧开关及列表位置', () => {
    for (const value of [
      { engines: { firecrawl: { enabled: false } }, controls: { searchServices: ['bing', 'firecrawl', 'tavily'] } },
      { engines: { firecrawl: { enabled: true } }, controls: { searchServices: ['bing'] } },
      { engines: { firecrawl: { enabled: false } } },
    ]) {
      const { face } = mount({ value });
      const before = [...face.hooks.webSearchFetch.getSnapshot().controls.searchServices];
      face.editParticipation('firecrawl', 'search', true);
      expect(face.hooks.webSearchFetch.getSnapshot().firecrawlSearchEnabled).toBe(true);
      face.editParticipation('firecrawl', 'search', false);
      expect(face.hooks.webSearchFetch.getSnapshot().controls.searchServices).toEqual(before);
      expect(face.hooks.webSearchFetch.getSnapshot().dirty).toBe(false);
    }
    const { face } = mount({ value: { engines: { firecrawl: { enabled: false } }, controls: { searchServices: ['bing', 'firecrawl', 'tavily'] } } });
    face.editParticipation('bing', 'search', false);
    face.editParticipation('firecrawl', 'search', true);
    face.editParticipation('firecrawl', 'search', false);
    expect(face.hooks.webSearchFetch.getSnapshot().controls.searchServices).toEqual(['firecrawl', 'tavily']);
  });

  it('两面不同引用仅配置一面时保留部分配置状态', async () => {
    const { face, page } = mount({ value: { search: { anysearchApiKeyEnv: 'AS_SEARCH' }, fetch: { anysearchApiKeyEnv: 'AS_FETCH', firecrawlApiKeyEnv: 'FC_FETCH' }, engines: { firecrawl: { apiKeyEnv: 'FC_SEARCH' } } },
      describe: refs => ({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, { configured: ['AS_SEARCH', 'FC_SEARCH'].includes(ref), writable: true }])) }),
    });
    await face.refresh();
    for (const id of ['anysearch', 'firecrawl']) {
      const row = face.hooks.webSearchFetch.getSnapshot().keys.find((row: { id: string }) => row.id === id);
      expect(row.configured).toBe(false);
      expect(row.partial).toBe(true);
    }
    const entry = page.registrations.find(entry => entry.options.name === 'settings.plugins.tab')!;
    const card = (entry.component as (props: unknown) => unknown)({ ...face, t: (key: string) => key, useWebSearchFetch: (select: (value: unknown) => unknown) => select(face.hooks.webSearchFetch.getSnapshot()) });
    const statuses: string[] = [];
    function visit(value: any): void {
      if (!value || typeof value !== 'object') return;
      if (value.props?.className === 'wsf-state') statuses.push(value.props.children);
      for (const child of Object.values(value)) if (typeof child === 'object') Array.isArray(child) ? child.forEach(visit) : visit(child);
    }
    visit(card);
    expect(statuses.filter(status => status === 'partial')).toHaveLength(2);
  });

  it('预设选项含单通道与多通道，并给出双语标签', () => {
    const { face, page } = mount({ value: {} });
    const entry = page.registrations.find(entry => entry.options.name === 'settings.plugins.tab')!;
    const card = (entry.component as (props: unknown) => unknown)({
      ...face, t: (key: string) => key,
      useWebSearchFetch: (select: (value: unknown) => unknown) => select(face.hooks.webSearchFetch.getSnapshot()),
    });
    const segmented: string[][] = [];
    function visit(value: any): void {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.props?.options) && value.props.options.every((option: any) => typeof option?.value === 'string')) {
        segmented.push(value.props.options.map((option: any) => option.value));
      }
      for (const child of Object.values(value)) if (typeof child === 'object') Array.isArray(child) ? child.forEach(visit) : visit(child);
    }
    visit(card);
    const presets = segmented.find(options => options.includes('auto') && options.includes('custom'))!;
    expect(presets).toEqual(['auto', 'single', 'multi', 'free', 'balanced', 'deep', 'custom']);
    const bundles = page.localeRegistrations[0]!.bundles as { zh: Record<string, string>; en: Record<string, string> };
    for (const name of ['singlePreset', 'multiPreset', 'singlePresetHint', 'multiPresetHint', 'decisionRoutingLabel', 'decisionRouting_off', 'decisionRouting_model', 'decisionRoutingHint']) {
      expect(bundles.zh[name], name).toBeTruthy();
      expect(bundles.en[name], name).toBeTruthy();
    }
  });

  it('自动预设默认用本地规则，切到决策模型才要求凭证', () => {
    const { face } = mount({ value: {} });
    expect(face.hooks.webSearchFetch.getSnapshot().controls.decisionRouting).toBeUndefined();
    face.editControl('decisionRouting', 'model');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.decisionRouting).toBe('model');
    face.editControl('decisionRouting', 'nonsense');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.decisionRouting).toBe('model');
    face.editControl('decisionRouting', 'off');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.decisionRouting).toBe('off');
  });

  it('新增预设可选并可保存', async () => {
    const { face, scope } = mount({ value: {} });
    face.editControl('preset', 'single');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.preset).toBe('single');
    face.editControl('preset', 'multi');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.preset).toBe('multi');
    face.editControl('preset', 'bogus');
    expect(face.hooks.webSearchFetch.getSnapshot().controls.preset).toBe('multi');
    await face.save();
    expect(scope.mutations.flat()).toContainEqual({ op: 'set', path: ['controls', 'preset'], value: 'multi' });
  });

});
