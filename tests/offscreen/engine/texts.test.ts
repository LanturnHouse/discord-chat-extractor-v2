/**
 * The sentences of the engine (src/offscreen/engine/texts.ts): one per kind of error in Korean and English, the scope of a problem
 * with threads kept, the engine's own problems, and the redaction of the authorization value.
 */
import { describe, expect, it } from 'vitest';
import { DiscordApiError } from '@/lib';
import type { ErrorKind } from '@/shared';
import { createTexts } from '@/offscreen/engine/texts';
import { TOKEN } from './kit';

const KINDS: ErrorKind[] = ['auth', 'forbidden', 'not-found', 'rate-limited', 'blocked', 'network', 'server', 'cancelled', 'interrupted', 'unknown'];

const KO: Record<ErrorKind, string> = {
  auth: '디스코드 로그인이 만료됐어요. 디스코드를 새로고침해 주세요',
  forbidden: '이 채널을 볼 권한이 없어요',
  'not-found': '채널을 찾을 수 없어요. 삭제됐을 수 있어요',
  'rate-limited': '디스코드가 요청을 제한했어요. 잠시 뒤에 다시 시도해 주세요',
  blocked: '디스코드가 요청을 막았어요. 잠시 뒤에 다시 시도해 주세요',
  network: '네트워크에 연결하지 못했어요',
  server: '디스코드 서버에 문제가 있어요. 잠시 뒤에 다시 시도해 주세요',
  cancelled: '취소했어요',
  interrupted: '중간에 끊겼어요. 다시 시도해 주세요',
  unknown: '알 수 없는 오류가 났어요',
};

const EN: Record<ErrorKind, string> = {
  auth: 'Your Discord login has expired. Please reload Discord',
  forbidden: "You don't have permission to view this channel",
  'not-found': 'The channel was not found. It may have been deleted',
  'rate-limited': 'Discord is limiting the requests. Please try again in a moment',
  blocked: 'Discord blocked the requests. Please try again in a moment',
  network: 'Could not connect to the network',
  server: 'Discord has a problem on its side. Please try again in a moment',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted. Please try again',
  unknown: 'Something went wrong',
};

describe('one sentence per kind of error', () => {
  it.each(KINDS)('%s, in Korean and in English', (kind) => {
    expect(createTexts('ko', TOKEN).kindError(kind)).toEqual({ kind, message: KO[kind] });
    expect(createTexts('en', TOKEN).kindError(kind)).toEqual({ kind, message: EN[kind] });
  });
});

describe('the error `exportChat` reported', () => {
  it.each(['auth', 'forbidden', 'not-found', 'rate-limited', 'blocked', 'network', 'server'] as const)('%s becomes the friendly sentence', (kind) => {
    expect(createTexts('ko', TOKEN).chatError({ kind, message: 'the library said something formal (403).' })).toEqual({ kind, message: KO[kind] });
    expect(createTexts('en', TOKEN).chatError({ kind, message: 'the library said something formal (403).' })).toEqual({ kind, message: EN[kind] });
  });

  it('keeps the scope of a problem with the threads or the posts of a chat', () => {
    expect(createTexts('en', TOKEN).chatError({ kind: 'forbidden', message: 'Threads: No access to this channel (403).' })).toEqual({ kind: 'forbidden', message: `Threads: ${EN.forbidden}` });
    expect(createTexts('en', TOKEN).chatError({ kind: 'network', message: 'Posts: whatever' }).message).toBe(`Posts: ${EN.network}`);
    expect(createTexts('ko', TOKEN).chatError({ kind: 'forbidden', message: '스레드: 이 채널에 접근할 수 없습니다 (403).' }).message).toBe(`스레드: ${KO.forbidden}`);
    expect(createTexts('ko', TOKEN).chatError({ kind: 'server', message: '게시글: 서버 오류' }).message).toBe(`게시글: ${KO.server}`);
  });

  it('does not take a "Threads:" in the middle of a sentence for a scope', () => {
    expect(createTexts('en', TOKEN).chatError({ kind: 'network', message: 'Lost the Threads: list' }).message).toBe(EN.network);
  });

  it('keeps the library sentence for an unknown kind: it is the only thing that says what happened', () => {
    expect(createTexts('en', TOKEN).chatError({ kind: 'unknown', message: 'Invalid export settings: the start of the range is later than its end' })).toEqual({
      kind: 'unknown',
      message: 'Invalid export settings: the start of the range is later than its end',
    });
  });
});

describe('whatever was thrown', () => {
  it('a Discord error gets the sentence of its kind', () => {
    expect(createTexts('ko', TOKEN).thrown(new DiscordApiError('forbidden', 'raw'))).toEqual({ kind: 'forbidden', message: KO.forbidden });
    expect(createTexts('en', TOKEN).thrown(new DiscordApiError('rate-limited', 'raw', { retryAfterMs: 120_000 }))).toEqual({ kind: 'rate-limited', message: EN['rate-limited'] });
  });

  it('anything else is an unknown error with its own message', () => {
    expect(createTexts('en', TOKEN).thrown(new RangeError('out of range'))).toEqual({ kind: 'unknown', message: 'out of range' });
    expect(createTexts('en', TOKEN).thrown('plain text')).toEqual({ kind: 'unknown', message: 'plain text' });
  });
});

describe("the engine's own problems", () => {
  it('a file that could not be saved, with what the background said (short, on one line)', () => {
    expect(createTexts('en', TOKEN).saveFailure(new Error('the save was refused')).message).toBe('Could not save the file (the save was refused)');
    expect(createTexts('ko', TOKEN).saveFailure(new Error('the save was refused')).message).toBe('파일을 저장하지 못했어요 (the save was refused)');
    expect(createTexts('en', TOKEN).saveFailure(new Error('line one\n   line two')).message).toBe('Could not save the file (line one line two)');
    expect(createTexts('en', TOKEN).saveFailure('not an error').message).toBe('Could not save the file');
    const long = createTexts('en', TOKEN).saveFailure(new Error('x'.repeat(500))).message;
    expect(long.length).toBeLessThan(160);
    expect(long.endsWith('...)')).toBe(true);
  });

  it('an archive that could not be saved', () => {
    expect(createTexts('en', TOKEN).zipSaveFailure(new Error('disk full')).message).toBe('Could not save the ZIP file (disk full)');
    expect(createTexts('ko', TOKEN).zipSaveFailure(undefined).message).toBe('ZIP 파일을 저장하지 못했어요');
  });

  it('a full ZIP says which limit was hit', () => {
    expect(createTexts('en', TOKEN).zipLimit('bytes').message).toBe('The ZIP file is full (about 3.75 GB at most). Please download fewer chats at once');
    expect(createTexts('en', TOKEN).zipLimit('entries').message).toBe('The ZIP file holds too many files (65,535 at most). Please download fewer chats at once');
    expect(createTexts('ko', TOKEN).zipLimit('bytes').message).toContain('3.75GB');
    expect(createTexts('ko', TOKEN).zipLimit('entries').message).toContain('65,535');
    expect(createTexts('ko', TOKEN).zipLimit('entries').kind).toBe('unknown');
  });

  it('counts the attachments that were left out', () => {
    expect(createTexts('en', TOKEN).attachmentsMissed(1).message).toBe('1 attachment could not be saved');
    expect(createTexts('en', TOKEN).attachmentsMissed(12).message).toBe('12 attachments could not be saved');
    expect(createTexts('ko', TOKEN).attachmentsMissed(3).message).toBe('첨부파일 3개를 저장하지 못했어요');
  });
});

describe('redaction', () => {
  it('removes the value wherever it appears, also trimmed', () => {
    const texts = createTexts('en', `  ${TOKEN} `);
    expect(texts.redact(`a ${TOKEN} b ${TOKEN}`)).toBe('a [redacted] b [redacted]');
    expect(texts.redact(`x${TOKEN}y`)).toBe('x[redacted]y');
    expect(texts.redact(`x  ${TOKEN} y`)).not.toContain(TOKEN);
  });

  it('leaves text without it alone', () => {
    expect(createTexts('en', TOKEN).redact('nothing to see')).toBe('nothing to see');
  });

  it('does not scrub with a value that is too short to be one (it would match everywhere)', () => {
    expect(createTexts('en', '').redact('hello')).toBe('hello');
    expect(createTexts('en', 'abc').redact('abc abc')).toBe('abc abc');
  });

  it('every sentence the texts build is redacted', () => {
    const texts = createTexts('en', TOKEN);
    expect(texts.chatError({ kind: 'unknown', message: `x ${TOKEN}` }).message).toBe('x [redacted]');
    expect(texts.thrown(new Error(`y ${TOKEN}`)).message).toBe('y [redacted]');
    expect(texts.saveFailure(new Error(`z ${TOKEN}`)).message).toBe('Could not save the file (z [redacted])');
    expect(texts.zipSaveFailure(new Error(`w ${TOKEN}`)).message).toBe('Could not save the ZIP file (w [redacted])');
  });
});
