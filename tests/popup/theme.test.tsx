// @vitest-environment jsdom
import { act, cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, type ThemeTokens } from '@/shared';
import { applyTheme } from '@/ui/theme/applyTheme';
import { renderPopup, settle } from './helpers';

afterEach(() => {
  cleanup(); // vitest globals are off, so testing-library cannot register its own cleanup
  applyTheme(null);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('lang');
});

const html = document.documentElement;
const tokens = (patch: Partial<ThemeTokens> = {}): ThemeTokens => ({ scheme: 'dark', themeClasses: ['theme-dark', 'theme-midnight'], vars: {}, lang: 'ko', capturedAt: 1, ...patch });
const setTheme = async (platform: Awaited<ReturnType<typeof renderPopup>>['platform'], theme: ThemeTokens | undefined): Promise<void> => {
  await act(async () => {
    platform.write('local', { [LOCAL.theme]: theme });
  });
  await settle();
};

describe('the Discord theme of the content script is applied (docs/PLAN.md §7.4)', () => {
  it('its variables go onto <html>', async () => {
    await renderPopup({
      prepare: (platform) => platform.write('local', { [LOCAL.theme]: tokens({ vars: { '--brand-500': '#112233', '--text-default': 'hsl(220 13% 91% / 1)' } }) }),
    });
    expect(html.style.getPropertyValue('--brand-500')).toBe('#112233');
    expect(html.style.getPropertyValue('--text-default')).toBe('hsl(220 13% 91% / 1)');
    expect(html.dataset.theme).toBe('dark');
  });

  it('a light Discord gives the light palette', async () => {
    await renderPopup({ prepare: (platform) => platform.write('local', { [LOCAL.theme]: tokens({ scheme: 'light', themeClasses: ['theme-light'] }) }) });
    expect(html.dataset.theme).toBe('light');
  });

  it('without a stored theme (Discord was never opened) the popup is dark with its built-in palette', async () => {
    await renderPopup({ prepare: (platform) => platform.write('local', { [LOCAL.theme]: undefined }) });
    expect(html.dataset.theme).toBe('dark');
    expect(html.style.getPropertyValue('--brand-500')).toBe('');
  });

  it('follows a change of the theme while the popup is open, and drops variables the new theme lacks', async () => {
    const { platform } = await renderPopup({ prepare: (mock) => mock.write('local', { [LOCAL.theme]: tokens({ vars: { '--brand-500': '#111', '--text-default': '#222' } }) }) });
    await setTheme(platform, tokens({ scheme: 'light', vars: { '--brand-500': '#333' } }));
    expect(html.dataset.theme).toBe('light');
    expect(html.style.getPropertyValue('--brand-500')).toBe('#333');
    expect(html.style.getPropertyValue('--text-default')).toBe('');
    await setTheme(platform, undefined);
    expect(html.dataset.theme).toBe('dark');
    expect(html.style.getPropertyValue('--brand-500')).toBe('');
  });

  it('values that could load something or are not on the list are never set', async () => {
    await renderPopup({
      prepare: (platform) =>
        platform.write('local', {
          [LOCAL.theme]: tokens({ vars: { '--brand-500': 'url(https://evil.example/x.png)', '--text-default': 'red; background: url(x)', '--evil': 'red', '--text-muted': '#999' } }),
        }),
    });
    expect(html.style.getPropertyValue('--brand-500')).toBe('');
    expect(html.style.getPropertyValue('--text-default')).toBe('');
    expect(html.style.getPropertyValue('--evil')).toBe('');
    expect(html.style.getPropertyValue('--text-muted')).toBe('#999');
  });
});

describe('the language of the app (docs/PLAN.md §7.4: settings.language -> dce.theme lang -> chrome.i18n.getUILanguage())', () => {
  const isKorean = (): boolean => screen.queryByRole('button', { name: '기록' }) !== null;
  const isEnglish = (): boolean => screen.queryByRole('button', { name: 'History' }) !== null;

  it("'auto' follows the language of the Discord page that the content script stored", async () => {
    await renderPopup({ uiLanguage: 'ko', prepare: (platform) => platform.write('local', { [LOCAL.theme]: tokens({ lang: 'en-US' }) }) });
    expect(isEnglish()).toBe(true);
    expect(html.lang).toBe('en');
    cleanup();
    await renderPopup({ uiLanguage: 'en-US', prepare: (platform) => platform.write('local', { [LOCAL.theme]: tokens({ lang: 'ko' }) }) });
    expect(isKorean()).toBe(true);
    expect(html.lang).toBe('ko');
  });

  it("'auto' without a stored page language falls back to the language of the browser", async () => {
    await renderPopup({ uiLanguage: 'en-US', prepare: (platform) => platform.write('local', { [LOCAL.theme]: tokens({ lang: '' }) }) });
    expect(isEnglish()).toBe(true);
    cleanup();
    await renderPopup({ uiLanguage: 'en-US', prepare: (platform) => platform.write('local', { [LOCAL.theme]: undefined }) });
    expect(isEnglish()).toBe(true);
    cleanup();
    await renderPopup({ uiLanguage: 'ko-KR', prepare: (platform) => platform.write('local', { [LOCAL.theme]: undefined }) });
    expect(isKorean()).toBe(true);
  });

  it("any language that is not Korean is shown in English, and a language nobody knows is Korean (the product's default)", async () => {
    await renderPopup({ uiLanguage: 'ja', prepare: (platform) => platform.write('local', { [LOCAL.theme]: undefined }) });
    expect(isEnglish()).toBe(true);
    cleanup();
    await renderPopup({ uiLanguage: '', prepare: (platform) => platform.write('local', { [LOCAL.theme]: undefined }) });
    expect(isKorean()).toBe(true);
  });

  it('an explicit language setting wins over both', async () => {
    await renderPopup({ uiLanguage: 'ko', settings: { language: 'en' }, prepare: (platform) => platform.write('local', { [LOCAL.theme]: tokens({ lang: 'ko' }) }) });
    expect(isEnglish()).toBe(true);
    cleanup();
    await renderPopup({ uiLanguage: 'en', settings: { language: 'ko' }, prepare: (platform) => platform.write('local', { [LOCAL.theme]: tokens({ lang: 'en' }) }) });
    expect(isKorean()).toBe(true);
  });

  it('switches while the popup is open when the language setting or the page language changes', async () => {
    const { platform } = await renderPopup();
    expect(isKorean()).toBe(true);
    await setTheme(platform, tokens({ lang: 'en' }));
    expect(isEnglish()).toBe(true);
    await act(async () => {
      platform.write('local', { [LOCAL.settings]: { ...(platform.read('local', LOCAL.settings) as object), language: 'ko' } });
    });
    await settle();
    expect(isKorean()).toBe(true);
    expect(html.lang).toBe('ko');
  });
});
