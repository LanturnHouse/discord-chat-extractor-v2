import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_BASE_PATH,
  DEFAULT_APP_SETTINGS,
  DEFAULT_CONTENT_OPTIONS,
  DEFAULT_EXPORT_SETTINGS,
  DISCORD_ORIGINS,
  EXPORT_FORMATS,
  LOCAL,
  SESSION,
  resolveItemSettings,
  type AppSettings,
  type ChatTarget,
  type ExportFormat,
  type ExportSettings,
  type QueueItem,
  type ToBackground,
  type ToContent,
} from '@/shared';

describe('defaults (docs/PLAN.md §2, §5.1, §5.4)', () => {
  it('content options are all on', () => {
    expect(DEFAULT_CONTENT_OPTIONS).toEqual({ includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true });
  });

  it('export settings: latest 200 messages, no date range, HTML with the dark theme, every extra off', () => {
    expect(DEFAULT_EXPORT_SETTINGS).toEqual({
      count: 200,
      from: null,
      to: null,
      format: 'html',
      htmlTheme: 'dark',
      includeAttachments: false,
      includeThreads: false,
      incremental: false,
      content: { includeBots: true, includeSystem: true, includeReactions: true, includeEmbeds: true },
    });
  });

  it('app settings: `common` is the export default, the rest are the §5.1 defaults, no per-item defaults any more', () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      common: DEFAULT_EXPORT_SETTINGS,
      showButtons: true,
      showQueuedIndicator: false,
      zipAll: false,
      folderName: 'Discord Export',
      dateInFileName: true,
      timeZone: 'auto',
      notifyOnComplete: true,
      language: 'auto',
      consentAt: null,
    });
    expect(DEFAULT_APP_SETTINGS.common).toBe(DEFAULT_EXPORT_SETTINGS);
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('defaults');
    expect(DEFAULT_APP_SETTINGS).not.toHaveProperty('rememberLast');
  });

  it('Discord origins and API base path', () => {
    expect(DISCORD_ORIGINS).toEqual(['https://discord.com', 'https://ptb.discord.com', 'https://canary.discord.com']);
    expect(API_BASE_PATH).toBe('/api/v9');
  });

  it('the default objects are deep-frozen: an accidental mutation throws instead of corrupting the defaults', () => {
    for (const frozen of [DEFAULT_CONTENT_OPTIONS, DEFAULT_EXPORT_SETTINGS, DEFAULT_APP_SETTINGS, DEFAULT_APP_SETTINGS.common, DEFAULT_EXPORT_SETTINGS.content, DISCORD_ORIGINS]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
    expect(() => {
      DEFAULT_EXPORT_SETTINGS.count = 5;
    }).toThrow(TypeError);
    expect(() => {
      DEFAULT_APP_SETTINGS.common.content.includeBots = false;
    }).toThrow(TypeError);
  });

  it('structuredClone gives an editable deep copy', () => {
    const copy = structuredClone(DEFAULT_APP_SETTINGS);
    copy.common.content.includeBots = false;
    copy.common.count = null;
    copy.common.format = 'json';
    expect(DEFAULT_APP_SETTINGS.common.content.includeBots).toBe(true);
    expect(DEFAULT_APP_SETTINGS.common.count).toBe(200);
    expect(DEFAULT_APP_SETTINGS.common.format).toBe('html');
  });

  it('are typed as the contract types', () => {
    expectTypeOf(DEFAULT_EXPORT_SETTINGS).toEqualTypeOf<ExportSettings>();
    expectTypeOf(DEFAULT_APP_SETTINGS).toEqualTypeOf<AppSettings>();
  });
});

describe('resolveItemSettings (docs/PLAN.md §3, §5.4, §6.3)', () => {
  /** A complete settings object that differs from the defaults in every field. */
  const override: ExportSettings = {
    count: null,
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T23:59:59.999Z',
    format: 'xlsx',
    htmlTheme: 'light',
    includeAttachments: true,
    includeThreads: true,
    incremental: true,
    content: { includeBots: false, includeSystem: false, includeReactions: false, includeEmbeds: false },
  };
  const common = (): ExportSettings => ({ ...structuredClone(DEFAULT_EXPORT_SETTINGS), count: 50, format: 'md' });

  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) deepFreeze(inner);
      Object.freeze(value);
    }
    return value;
  }

  it('has the documented signature', () => {
    expectTypeOf(resolveItemSettings).parameters.toEqualTypeOf<[Pick<QueueItem, 'settings'>, ExportSettings]>();
    expectTypeOf(resolveItemSettings).returns.toEqualTypeOf<ExportSettings>();
  });

  it('an item without own settings (null) follows the common settings: an equal, separate copy', () => {
    const shared = common();
    const resolved = resolveItemSettings({ settings: null }, shared);
    expect(resolved).toEqual(shared);
    expect(resolved).not.toBe(shared);
    expect(resolved.content).not.toBe(shared.content);
  });

  it('an item with own settings keeps them and ignores the common settings: an equal, separate copy', () => {
    const own = structuredClone(override);
    const shared = common();
    const resolved = resolveItemSettings({ settings: own }, shared);
    expect(resolved).toEqual(override);
    expect(resolved).not.toEqual(shared);
    expect(resolved).not.toBe(own);
    expect(resolved.content).not.toBe(own.content);
  });

  it('own settings count as own even when they equal the common settings (they are never compared)', () => {
    const shared = common();
    const own = structuredClone(shared);
    const resolved = resolveItemSettings({ settings: own }, shared);
    expect(resolved).toEqual(own);
    expect(resolved).not.toBe(shared);
    expect(resolved).not.toBe(own);
  });

  it('an item that has no `settings` at all (undefined, e.g. stored by an older build) is treated like null', () => {
    const shared = common();
    expect(resolveItemSettings({} as Pick<QueueItem, 'settings'>, shared)).toEqual(shared);
    expect(resolveItemSettings({ settings: undefined } as unknown as Pick<QueueItem, 'settings'>, shared)).toEqual(shared);
  });

  it('accepts a whole queue item (it only reads `settings`)', () => {
    const target: ChatTarget = { kind: 'dm', channelId: '1', guildId: null, guildName: null, channelName: 'Someone' };
    const item: QueueItem = { key: '1', target, settings: null, addedAt: 0 };
    expect(resolveItemSettings(item, common())).toEqual(common());
    expect(item).toEqual({ key: '1', target, settings: null, addedAt: 0 });
  });

  it('editing the result never reaches the item or the common settings (nested content included)', () => {
    const shared = common();
    const own = structuredClone(override);

    const followed = resolveItemSettings({ settings: null }, shared);
    followed.count = 1;
    followed.format = 'json';
    followed.content.includeBots = false;
    expect(shared).toEqual(common());

    const individual = resolveItemSettings({ settings: own }, shared);
    individual.count = 1;
    individual.format = 'json';
    individual.content.includeEmbeds = true;
    expect(own).toEqual(override);
    expect(shared).toEqual(common());
  });

  it('a result is fixed at the moment of the call: later edits of the common settings or the item do not change it', () => {
    const shared = common();
    const own = structuredClone(override);
    const followed = resolveItemSettings({ settings: null }, shared);
    const individual = resolveItemSettings({ settings: own }, shared);

    shared.count = 999;
    shared.content.includeSystem = false;
    own.format = 'csv';
    own.content.includeBots = true;
    expect(followed).toEqual(common());
    expect(individual).toEqual(override);
  });

  it('works on frozen inputs (the defaults, a frozen store state) and always returns an editable, unfrozen copy', () => {
    const fromDefaults = resolveItemSettings({ settings: null }, DEFAULT_APP_SETTINGS.common);
    expect(fromDefaults).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(Object.isFrozen(fromDefaults)).toBe(false);
    expect(Object.isFrozen(fromDefaults.content)).toBe(false);
    fromDefaults.count = 7;
    fromDefaults.content.includeBots = false;
    expect(DEFAULT_APP_SETTINGS.common.count).toBe(200);
    expect(DEFAULT_APP_SETTINGS.common.content.includeBots).toBe(true);

    const frozenOwn = deepFreeze(structuredClone(override));
    const fromOwn = resolveItemSettings({ settings: frozenOwn }, deepFreeze(common()));
    expect(fromOwn).toEqual(override);
    expect(Object.isFrozen(fromOwn)).toBe(false);
    expect(Object.isFrozen(fromOwn.content)).toBe(false);
  });

  it('does not touch its arguments', () => {
    const item: Pick<QueueItem, 'settings'> = { settings: structuredClone(override) };
    const shared = common();
    resolveItemSettings(item, shared);
    resolveItemSettings({ settings: null }, shared);
    expect(item).toEqual({ settings: override });
    expect(shared).toEqual(common());
  });
});

describe('contract constants (docs/PLAN.md §5.1-§5.3)', () => {
  it('EXPORT_FORMATS lists the six formats, HTML first (it is the default)', () => {
    expect(EXPORT_FORMATS).toEqual(['html', 'txt', 'md', 'xlsx', 'csv', 'json']);
    expectTypeOf(EXPORT_FORMATS).toEqualTypeOf<readonly ExportFormat[]>();
    expect(DEFAULT_EXPORT_SETTINGS.format).toBe(EXPORT_FORMATS[0]);
  });

  it('storage keys: session keys are unique and namespaced, local key builders include the account id', () => {
    const sessionKeys = Object.values(SESSION);
    expect(new Set(sessionKeys).size).toBe(sessionKeys.length);
    for (const key of sessionKeys) expect(key).toMatch(/^dce\./);
    expect(LOCAL.settings).toBe('dce.settings');
    expect(LOCAL.queue('42')).toBe('dce.queue.42');
    expect(LOCAL.history('42')).toBe('dce.history.42');
    expect(LOCAL.lastExported('42')).toBe('dce.lastExported.42');
    expect(LOCAL.queue('a')).not.toBe(LOCAL.queue('b'));
    expect(LOCAL.theme).toBe('dce.theme');
    expect(LOCAL.classCache).toBe('dce.classCache');
    expect(LOCAL.lastAccount).toBe('dce.lastAccount');
  });

  it('the message unions are usable through the barrel (compile-time check, run by `npm run typecheck`)', () => {
    const target: ChatTarget = { kind: 'guild-channel', channelId: '2', guildId: '1', guildName: 'Server', channelName: 'general' };
    const toggle: ToBackground = { to: 'bg', type: 'queue/toggle', target };
    const category: ToBackground = { to: 'bg', type: 'queue/addCategory', guildId: '1', guildName: 'Server', categoryId: '3', categoryName: 'Category' };
    const start: ToBackground = { to: 'bg', type: 'job/start', keys: 'all' };
    const status: ToBackground = { to: 'bg', type: 'status/get' };
    const shortcut: ToContent = { to: 'content', type: 'shortcut/toggleCurrent' };
    expect([toggle.type, category.type, start.type, status.type, shortcut.type]).toEqual([
      'queue/toggle',
      'queue/addCategory',
      'job/start',
      'status/get',
      'shortcut/toggleCurrent',
    ]);
  });
});
