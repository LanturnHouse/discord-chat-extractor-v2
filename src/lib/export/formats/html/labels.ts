import type { MessageLocale } from '../../../message';

/**
 * UI strings of the message view (system sentences, date names and reply placeholders live in lib/message/strings.ts).
 * Only `ko` and `en` exist; any other value falls back to `en`.
 */
export interface MessageLabels {
  edited: string;
  /** Tag next to the name of bots and webhooks. */
  appTag: string;
  forwarded: string;
  /** Screen-reader prefix before the replied-to author. */
  replyingTo: string;
  spoilerBadge: string;
  spoilerReveal: string;
  openOriginal: string;
  unnamedFile: string;
  reactions: string;
  reaction: (label: string, count: number, me: boolean) => string;
  stickerFallback: string;
  openVideo: string;
  pollSingle: string;
  pollMulti: string;
  pollVotes: (n: number) => string;
  pollClosed: string;
}

const en: MessageLabels = {
  edited: '(edited)',
  appTag: 'APP',
  forwarded: 'Forwarded',
  replyingTo: 'Replying to',
  spoilerBadge: 'Spoiler',
  spoilerReveal: 'Spoiler: click to reveal',
  openOriginal: 'Open original',
  unnamedFile: 'Unnamed file',
  reactions: 'Reactions',
  reaction: (label, count, me) =>
    `${label}, ${count} ${count === 1 ? 'reaction' : 'reactions'}${me ? ', including you' : ''}`,
  stickerFallback: 'Sticker',
  openVideo: 'Open video',
  pollSingle: 'Select one answer',
  pollMulti: 'Select one or more answers',
  pollVotes: (n) => `${n} ${n === 1 ? 'vote' : 'votes'}`,
  pollClosed: 'Poll closed',
};

const ko: MessageLabels = {
  edited: '(수정됨)',
  appTag: '앱',
  forwarded: '전달됨',
  replyingTo: '답장 대상',
  spoilerBadge: '스포일러',
  spoilerReveal: '스포일러: 클릭하여 보기',
  openOriginal: '원본 열기',
  unnamedFile: '이름 없는 파일',
  reactions: '리액션',
  reaction: (label, count, me) => `${label}, 반응 ${count}개${me ? ', 내가 반응함' : ''}`,
  stickerFallback: '스티커',
  openVideo: '영상 열기',
  pollSingle: '답변 하나를 선택하세요',
  pollMulti: '답변을 하나 이상 선택하세요',
  pollVotes: (n) => `${n}표`,
  pollClosed: '투표 종료',
};

export function getMessageLabels(locale: MessageLocale | string | null | undefined): MessageLabels {
  return locale === 'ko' ? ko : en;
}
