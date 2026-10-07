import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS, LOCAL } from '@/shared';
import type { AppSettings } from '@/shared';
import { readSettings } from '@/background/store';
import { createFakeBrowser } from './fakeChrome';
import type { FakeBrowser, FakePage } from './fakeChrome';
import { bootWorker, exportSettings, installFakeDiscordApi, settle } from './helpers';

let fake: FakeBrowser;
let popup: FakePage;

beforeEach(async () => {
  fake = createFakeBrowser();
  installFakeDiscordApi();
  await bootWorker(fake, { agreed: false });
  popup = fake.createPage({ kind: 'popup' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const patch = (value: unknown) => popup.send({ to: 'bg', type: 'settings/patch', patch: value });
const stored = () => fake.local.peek<AppSettings>(LOCAL.settings);

describe('reading the settings (LOCAL.settings merged over the defaults)', () => {
  it('gives the defaults when nothing is stored, as a fresh editable copy', async () => {
    const settings = await readSettings();
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(settings).not.toBe(DEFAULT_APP_SETTINGS);
    expect(Object.isFrozen(settings)).toBe(false);
    expect(settings).toMatchObject({
      common: { count: 200, from: null, to: null, format: 'html', htmlTheme: 'dark', includeAttachments: false, includeThreads: false, incremental: false },
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
  });

  it('merges a partial record over the defaults, including inside the common settings and their content options', async () => {
    fake.local.seed({ [LOCAL.settings]: { zipAll: true, common: { format: 'md', content: { includeEmbeds: false } } } });
    const settings = await readSettings();
    expect(settings.zipAll).toBe(true);
    expect(settings.showButtons).toBe(true);
    expect(settings.common).toEqual({ ...DEFAULT_APP_SETTINGS.common, format: 'md', content: { ...DEFAULT_APP_SETTINGS.common.content, includeEmbeds: false } });
  });

  it('survives a damaged record: bad values fall back one by one', async () => {
    fake.local.seed({ [LOCAL.settings]: { common: { count: 'many', format: 'html' }, showButtons: 5, language: 'ko', folderName: 42 } });
    const settings = await readSettings();
    expect(settings.common.count).toBe(200);
    expect(settings.common.format).toBe('html');
    expect(settings.showButtons).toBe(true);
    expect(settings.language).toBe('ko');
    expect(settings.folderName).toBe('Discord Export');
    fake.local.seed({ [LOCAL.settings]: 'garbage' });
    expect(await readSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });
});

describe('settings/patch', () => {
  it('stores a shallow patch merged over the current settings (the stored record is complete)', async () => {
    await expect(patch({ showButtons: false, zipAll: true })).resolves.toEqual({ ok: true });
    expect(stored()).toEqual({ ...DEFAULT_APP_SETTINGS, showButtons: false, zipAll: true });
  });

  it('patches accumulate and do not touch what they do not mention', async () => {
    await patch({ language: 'en' });
    await patch({ folderName: 'Mine' });
    await patch({ notifyOnComplete: false });
    expect(stored()).toMatchObject({ language: 'en', folderName: 'Mine', notifyOnComplete: false, showButtons: true, common: DEFAULT_APP_SETTINGS.common });
  });

  it('replaces `common` as a whole', async () => {
    const common = exportSettings({ count: null, format: 'json', includeThreads: true, content: { includeBots: false, includeSystem: false, includeReactions: false, includeEmbeds: false } });
    await patch({ common });
    expect(stored()?.common).toEqual(common);
    await patch({ common: exportSettings({ format: 'csv' }) });
    expect(stored()?.common).toEqual(exportSettings({ format: 'csv' })); // not merged with the previous one
  });

  it('records the consent', async () => {
    await expect(patch({ consentAt: 1_760_000_000_000 })).resolves.toEqual({ ok: true });
    expect(stored()?.consentAt).toBe(1_760_000_000_000);
  });

  it('works without an account (the settings belong to the browser, not to a Discord account)', async () => {
    expect(fake.session.keys().filter((key) => key === 'dce.account')).toEqual([]);
    await expect(patch({ showQueuedIndicator: true })).resolves.toEqual({ ok: true });
  });

  it.each([
    ['count 0', { common: exportSettings({ count: 0 }) }, 'count'],
    ['count 1,000,001', { common: exportSettings({ count: 1_000_001 }) }, 'count'],
    ['a fractional count', { common: exportSettings({ count: 1.5 }) }, 'count'],
    ['from after to', { common: exportSettings({ from: '2026-10-06T00:00:00.000Z', to: '2026-10-05T23:59:59.999Z' }) }, 'from must not be after to'],
    ['an unknown format', { common: { ...exportSettings(), format: 'pdf' } }, 'format'],
    ['an incomplete common', { common: { count: 5 } }, 'common'],
    ['a non-boolean flag', { zipAll: 'true' }, 'zipAll'],
    ['an empty folder name', { folderName: '' }, 'folderName'],
    ['a folder name of only forbidden/blank characters', { folderName: '. . .' }, 'folderName'],
    ['an unknown time zone', { timeZone: 'Mars/Base' }, 'timeZone'],
    ['an unknown language', { language: 'fr' }, 'language'],
    ['a bad consent time', { consentAt: 'now' }, 'consentAt'],
    ['a patch that is not an object', 'patch', 'object'],
    ['no patch', undefined, 'object'],
  ])('refuses %s and stores nothing', async (_label, value, fragment) => {
    const response = (await patch(value)) as { ok: boolean; error?: string; message?: string };
    expect(response).toMatchObject({ ok: false, error: 'invalid' });
    expect(response.message).toContain(fragment);
    expect(fake.local.has(LOCAL.settings)).toBe(false);
  });

  it('one bad value refuses the whole patch (nothing is applied halfway)', async () => {
    await patch({ language: 'ko' });
    await expect(patch({ showButtons: false, language: 'xx' })).resolves.toMatchObject({ ok: false, error: 'invalid' });
    expect(stored()).toMatchObject({ language: 'ko', showButtons: true });
  });

  it('cleans the folder name and cuts it to 60 characters', async () => {
    await patch({ folderName: 'a/b:c' });
    expect(stored()?.folderName).toBe('a_b_c');
    await patch({ folderName: 'x'.repeat(100) });
    expect(stored()?.folderName).toBe('x'.repeat(60));
    await patch({ folderName: 'CON' });
    expect(stored()?.folderName).toBe('_CON');
  });

  it('accepts auto or an IANA time zone and the three languages', async () => {
    await patch({ timeZone: 'Asia/Seoul', language: 'ko' });
    expect(stored()).toMatchObject({ timeZone: 'Asia/Seoul', language: 'ko' });
    await patch({ timeZone: 'auto', language: 'auto' });
    expect(stored()).toMatchObject({ timeZone: 'auto', language: 'auto' });
  });

  it('ignores unknown keys, and an empty patch writes nothing', async () => {
    await expect(patch({ unknown: 1, __proto__: { x: 1 } })).resolves.toEqual({ ok: true });
    expect(fake.local.has(LOCAL.settings)).toBe(false);
    await patch({ zipAll: true, unknown: 'x' });
    expect(stored()).not.toHaveProperty('unknown');
  });

  it('loses no update when patches arrive at once', async () => {
    await Promise.all([patch({ zipAll: true }), patch({ showButtons: false }), patch({ language: 'en' }), patch({ folderName: 'Together' }), patch({ notifyOnComplete: false })]);
    expect(stored()).toMatchObject({ zipAll: true, showButtons: false, language: 'en', folderName: 'Together', notifyOnComplete: false });
  });

  it('is announced through storage.onChanged (the content script reacts to showButtons / showQueuedIndicator)', async () => {
    const seen: unknown[] = [];
    fake.storageChanged.addListener((changes, area) => {
      if (area === 'local' && LOCAL.settings in changes) seen.push((changes[LOCAL.settings].newValue as AppSettings).showButtons);
    });
    await patch({ showButtons: false });
    await settle();
    expect(seen).toEqual([false]);
  });

  it('never stores the same value twice (no change event for an identical patch)', async () => {
    await patch({ zipAll: true });
    fake.local.set.mockClear();
    await patch({ zipAll: true });
    expect(fake.local.set).toHaveBeenCalledTimes(1); // the write happens, Chrome simply reports no change for it
    let events = 0;
    fake.storageChanged.addListener(() => (events += 1));
    await patch({ zipAll: true });
    await settle();
    expect(events).toBe(0);
  });
});
