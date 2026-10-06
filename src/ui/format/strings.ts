import { defineStrings } from '../i18n/core';
import type { NumberFormatter } from '../i18n/locale';

/** Words of the one-line settings summary ("200개 · HTML · 기간 없음 · 첨부") shown under every queue row and history entry. */
export const summaryStrings = defineStrings({
  ko: {
    count: (count: number, fmt: NumberFormatter) => `${fmt(count)}개`,
    all: '전체',
    noRange: '기간 없음',
    from: (from: string) => `${from}부터`,
    until: (to: string) => `${to}까지`,
    between: (from: string, to: string) => `${from} ~ ${to}`,
    attachments: '첨부',
    threads: '스레드',
    incremental: '새 메시지만',
  },
  en: {
    count: (count, fmt) => `${fmt(count)} ${count === 1 ? 'message' : 'messages'}`,
    all: 'All messages',
    noRange: 'No date range',
    from: (from) => `From ${from}`,
    until: (to) => `Until ${to}`,
    between: (from, to) => `${from} – ${to}`,
    attachments: 'attachments',
    threads: 'threads',
    incremental: 'new only',
  },
});
