/**
 * The sentences the engine shows the user (progress rows, history entries): Korean or English by `job.locale`, one per
 * `ErrorKind` (docs/PLAN.md §6.3), plus the few engine-specific problems (a file that could not be saved, a full ZIP, attachments
 * that were left out). Every text that leaves this module went through `redact`, so the authorization value of the job can never
 * end up in a message, whatever an error happened to contain.
 */
import { describeChatError } from '@/lib';
import type { ChatError, ZipLimitKind } from '@/lib';
import type { ErrorKind } from '@/shared';

export type Locale = 'ko' | 'en';

/** Longest text kept of a detail that comes from somewhere else (the background's answer to a refused save). */
const MAX_DETAIL = 120;

interface Texts {
  kinds: Record<ErrorKind, string>;
  saveFailed(detail: string): string;
  zipSaveFailed(detail: string): string;
  zipLimit(limit: 'bytes' | 'entries'): string;
  attachmentsMissed(count: number): string;
}

const KO: Texts = {
  kinds: {
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
  },
  saveFailed: (detail) => (detail === '' ? '파일을 저장하지 못했어요' : `파일을 저장하지 못했어요 (${detail})`),
  zipSaveFailed: (detail) => (detail === '' ? 'ZIP 파일을 저장하지 못했어요' : `ZIP 파일을 저장하지 못했어요 (${detail})`),
  zipLimit: (limit) =>
    limit === 'bytes'
      ? 'ZIP 파일 하나에 담을 수 있는 크기(약 3.75GB)를 넘었어요. 한 번에 받는 채팅 수를 줄여 주세요'
      : 'ZIP 파일 하나에 담을 수 있는 파일 수(65,535개)를 넘었어요. 한 번에 받는 채팅 수를 줄여 주세요',
  attachmentsMissed: (count) => `첨부파일 ${count}개를 저장하지 못했어요`,
};

const EN: Texts = {
  kinds: {
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
  },
  saveFailed: (detail) => (detail === '' ? 'Could not save the file' : `Could not save the file (${detail})`),
  zipSaveFailed: (detail) => (detail === '' ? 'Could not save the ZIP file' : `Could not save the ZIP file (${detail})`),
  zipLimit: (limit) =>
    limit === 'bytes'
      ? 'The ZIP file is full (about 3.75 GB at most). Please download fewer chats at once'
      : 'The ZIP file holds too many files (65,535 at most). Please download fewer chats at once',
  attachmentsMissed: (count) => `${count} attachment${count === 1 ? '' : 's'} could not be saved`,
};

/** A problem of a chat's threads / forum posts starts with this (the library puts it there, in the job's language). */
const SCOPE_PREFIX = /^(?:Threads|Posts|스레드|게시글): /;

/** The texts and error builders of one job. */
export interface JobTexts {
  /** The error of a kind with nothing else to say: its sentence. */
  kindError(kind: ErrorKind): ChatError;
  /** `{ kind, message }` for the error `exportChat` reported: a friendly sentence for the known kinds, the library's own for the rest. */
  chatError(error: ChatError): ChatError;
  /** Whatever was thrown (outside of `exportChat`), as an error of the item. */
  thrown(error: unknown): ChatError;
  /** A save was refused or failed. */
  saveFailure(error: unknown): ChatError;
  /** The archive could not be saved. */
  zipSaveFailure(error: unknown): ChatError;
  /** The ZIP is full (a `ZipLimitError` / `ZipAssembler.limitFor` said which limit). */
  zipLimit(limit: ZipLimitKind): ChatError;
  /** Some attachments were left out (the chat itself is fine). */
  attachmentsMissed(count: number): ChatError;
  /** Removes the authorization value from a text. */
  redact(text: string): string;
}

/**
 * `secret` is the authorization value of the job. Values that are too short to be a real one are not scrubbed (an empty value
 * would otherwise "match" everywhere).
 */
export function createTexts(locale: Locale, secret: string): JobTexts {
  const texts = locale === 'ko' ? KO : EN;
  const secrets = [...new Set([secret, secret.trim()])].filter((value) => value.length >= 8);

  const redact = (text: string): string => secrets.reduce((out, value) => out.split(value).join('[redacted]'), text);
  const detailOf = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : '';
    const clean = redact(raw).replace(/\s+/g, ' ').trim();
    return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL)}...` : clean;
  };
  const unknown = (message: string): ChatError => ({ kind: 'unknown', message: redact(message) });

  return {
    kindError: (kind) => ({ kind, message: redact(texts.kinds[kind]) }),
    chatError(error) {
      if (error.kind === 'unknown') return unknown(error.message);
      const scope = SCOPE_PREFIX.exec(error.message)?.[0] ?? '';
      return { kind: error.kind, message: redact(`${scope}${texts.kinds[error.kind]}`) };
    },
    thrown(error) {
      const described = describeChatError(error, locale);
      return described.kind === 'unknown' ? unknown(described.message) : { kind: described.kind, message: redact(texts.kinds[described.kind]) };
    },
    saveFailure: (error) => unknown(texts.saveFailed(detailOf(error))),
    zipSaveFailure: (error) => unknown(texts.zipSaveFailed(detailOf(error))),
    zipLimit: (limit) => unknown(texts.zipLimit(limit)),
    attachmentsMissed: (count) => unknown(texts.attachmentsMissed(count)),
    redact,
  };
}
