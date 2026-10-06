import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import previewConfig from '@/ui/preview/vite.config';
import * as ui from '@/ui';

describe('src/ui (the shared UI of the extension pages)', () => {
  it('exports the components, i18n, theme, formatting, the settings panel and the platform wrapper', () => {
    for (const name of [
      'Button',
      'IconButton',
      'SplitButton',
      'Toggle',
      'Checkbox',
      'NumberInput',
      'DateInput',
      'RadioGroup',
      'ProgressBar',
      'Badge',
      'Download',
      'Check',
      'Gear',
      'Close',
      'Play',
      'History',
      'Settings',
      'Warning',
      'Folder',
      'ChevronDown',
      'External',
      'SettingsPanel',
      'defineStrings',
      'resolveUiLocale',
      'LocaleProvider',
      'useStrings',
      'applyTheme',
      'useTheme',
      'summarizeSettings',
      'formatTargetLabel',
      'startOfDayIso',
      'endOfDayIso',
      'ChromePlatform',
      'shouldUseMock',
    ] as const) {
      expect(ui[name], name).toBeDefined();
    }
  });

  it('does not pull the mock into the shared entry: it is loaded on demand only', () => {
    expect('createMockPlatform' in ui).toBe(false);
    expect('MOCK_ACCOUNT' in ui).toBe(false);
  });
});

describe('the preview dev server config (src/ui/preview/vite.config.ts)', () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');

  it('serves src/popup (where popup.html is) and may read the whole repo', () => {
    expect(previewConfig.root?.replaceAll('\\', '/')).toBe(`${repo}src/popup`);
    expect(previewConfig.server?.open).toBe('/popup.html?mock=1');
    const allow = previewConfig.server?.fs?.allow?.map((path) => path.replaceAll('\\', '/')) ?? [];
    expect(allow.some((path) => repo.startsWith(path.endsWith('/') ? path : `${path}/`))).toBe(true);
  });

  it('resolves @/ like the real build and has its own port', () => {
    const alias = previewConfig.resolve?.alias as Record<string, string>;
    expect(alias['@'].replaceAll('\\', '/').replace(/\/$/, '')).toBe(`${repo}src`);
    expect(previewConfig.server?.port).toBe(5859);
  });
});
