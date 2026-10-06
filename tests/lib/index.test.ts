import { describe, expect, it } from 'vitest';
import * as lib from '@/lib';

describe('the public API of src/lib', () => {
  it('exports exactly what the engine is told to use', () => {
    expect(Object.keys(lib).sort()).toEqual(
      [
        'BLOCKED_RETRY_WAITS_MS',
        'DEFAULT_PAGE_GAP',
        'DiscordApiError',
        'ITEM_GAP',
        'MAX_COLLECT_COUNT',
        'MAX_ZIP_ENTRIES',
        'MAX_ZIP_INPUT_BYTES',
        'NO_GAP',
        'URL_REFRESH_AFTER_MS',
        'ZipAssembler',
        'ZipLimitError',
        'abortableSleep',
        'collectMessages',
        'collectMessagesResult',
        'compareSnowflakes',
        'createDiscordClient',
        'createFetchTransport',
        'dateStamp',
        'describeChatError',
        'exportChat',
        'isAbortError',
        'isAttachmentUrlStale',
        'isRefreshableUrl',
        'isSnowflake',
        'listThreads',
        'randomGapMs',
        'refreshAttachmentUrls',
        'zipFileName',
        'zipFilePath',
      ].sort(),
    );
  });

  it('leaves the demo client out', () => {
    expect('createMockClient' in lib).toBe(false);
  });

  it('exports callables and constants of the right kind', () => {
    for (const name of ['createDiscordClient', 'createFetchTransport', 'collectMessages', 'collectMessagesResult', 'listThreads', 'refreshAttachmentUrls', 'exportChat', 'describeChatError', 'zipFileName', 'zipFilePath']) {
      expect(typeof (lib as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(typeof lib.ZipAssembler).toBe('function');
    expect(lib.DEFAULT_PAGE_GAP).toEqual({ minMs: 700, maxMs: 1500 });
    expect(lib.ITEM_GAP).toEqual({ minMs: 2000, maxMs: 4000 });
    expect(lib.BLOCKED_RETRY_WAITS_MS).toEqual([30_000, 60_000, 120_000]);
  });

  it('has the ZIP file name the plan asks for', () => {
    expect(lib.zipFileName(new Date('2026-10-06T14:37:00Z'), { timeZone: 'UTC' })).toBe('Discord Export 2026-10-06 1437.zip');
    expect(lib.zipFilePath('Discord Export', new Date('2026-10-06T14:37:00Z'), { timeZone: 'UTC', partial: true, locale: 'ko' })).toBe('Discord Export/Discord Export 2026-10-06 1437 (부분).zip');
  });
});
