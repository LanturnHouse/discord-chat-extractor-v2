/**
 * Localised strings for message semantics (system messages, placeholders, date names).
 * Only `ko` and `en` exist; any other value falls back to `en`.
 *
 * Date/time names live here (instead of coming from Intl) so output is identical across ICU versions
 * (newer ICU puts a narrow no-break space before "PM", which would break exact-match tests and exports).
 */
export type MessageLocale = 'ko' | 'en';

export interface MessageStrings {
  unknownUser: string;
  someone: string;

  genericSystem: (type: string) => string;
  recipientAdd: (actor: string, target: string) => string;
  recipientRemove: (actor: string, target: string) => string;
  recipientLeave: (actor: string) => string;
  callStarted: (actor: string) => string;
  callLasted: (actor: string, duration: string) => string;
  callMissed: (actor: string) => string;
  channelName: (actor: string, name: string | null) => string;
  channelIcon: (actor: string) => string;
  pinned: (actor: string) => string;
  joined: (actor: string) => string;
  boost: (actor: string, count: number | null) => string;
  boostTier: (actor: string, count: number | null, level: number) => string;
  followAdd: (actor: string, name: string | null) => string;
  discoveryDisqualified: string;
  discoveryRequalified: string;
  threadCreated: (actor: string, name: string | null) => string;
  inviteReminder: string;
  autoMod: (actor: string) => string;
  roleSubscription: (actor: string) => string;
  stageStart: (actor: string, topic: string | null) => string;
  stageEnd: (actor: string, topic: string | null) => string;
  stageSpeaker: (actor: string) => string;
  stageRaiseHand: (actor: string) => string;
  stageTopic: (actor: string, topic: string | null) => string;

  seconds: (n: number) => string;
  minutes: (n: number) => string;
  hoursMinutes: (h: number, m: number) => string;

  replyAttachment: string;
  replyDeleted: string;
  replyUnavailable: string;

  attachment: string;
  sticker: string;
  embed: string;
  poll: string;
  forwarded: string;
  spoiler: string;

  months: readonly string[];
  weekdays: readonly string[];
  am: string;
  pm: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const en: MessageStrings = {
  unknownUser: 'Unknown user',
  someone: 'someone',

  genericSystem: (type) => `[System message (type ${type})]`,
  recipientAdd: (a, t) => `${a} added ${t} to the group.`,
  recipientRemove: (a, t) => `${a} removed ${t} from the group.`,
  recipientLeave: (a) => `${a} left the group.`,
  callStarted: (a) => `${a} started a call.`,
  callLasted: (a, d) => `${a} started a call that lasted ${d}.`,
  callMissed: (a) => `Missed call from ${a}.`,
  channelName: (a, n) => (n ? `${a} changed the channel name: ${n}` : `${a} changed the channel name.`),
  channelIcon: (a) => `${a} changed the channel icon.`,
  pinned: (a) => `${a} pinned a message to this channel.`,
  joined: (a) => `${a} joined the server.`,
  boost: (a, c) => (c && c > 1 ? `${a} boosted the server ${c} times.` : `${a} boosted the server.`),
  boostTier: (a, c, l) =>
    `${c && c > 1 ? `${a} boosted the server ${c} times.` : `${a} boosted the server.`} The server has reached Level ${l}!`,
  followAdd: (a, n) =>
    n ? `${a} added a channel follow to this channel: ${n}` : `${a} added a channel follow to this channel.`,
  discoveryDisqualified: 'This server was removed from Server Discovery because it no longer meets the requirements.',
  discoveryRequalified: 'This server is eligible for Server Discovery again and has been relisted.',
  threadCreated: (a, n) => (n ? `${a} started a thread: ${n}` : `${a} started a thread.`),
  inviteReminder: 'Reminder: invite people to the server.',
  autoMod: (a) => `AutoMod took action on a message from ${a}.`,
  roleSubscription: (a) => `${a} subscribed to a role.`,
  stageStart: (a, t) => (t ? `${a} started the Stage: ${t}` : `${a} started a Stage.`),
  stageEnd: (a, t) => (t ? `${a} ended the Stage: ${t}` : `${a} ended the Stage.`),
  stageSpeaker: (a) => `${a} is now a speaker.`,
  stageRaiseHand: (a) => `${a} requested to speak.`,
  stageTopic: (a, t) => (t ? `${a} changed the Stage topic: ${t}` : `${a} changed the Stage topic.`),

  seconds: (n) => plural(n, 'second', 'seconds'),
  minutes: (n) => plural(n, 'minute', 'minutes'),
  hoursMinutes: (h, m) => (m > 0 ? `${plural(h, 'hour', 'hours')} ${plural(m, 'minute', 'minutes')}` : plural(h, 'hour', 'hours')),

  replyAttachment: 'Click to see attachment',
  replyDeleted: 'Original message was deleted',
  replyUnavailable: 'Original message is unavailable',

  attachment: '[attachment]',
  sticker: '[sticker]',
  embed: '[embed]',
  poll: '[poll]',
  forwarded: '[forwarded message]',
  spoiler: '[spoiler]',

  months: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  am: 'AM',
  pm: 'PM',
};

const ko: MessageStrings = {
  unknownUser: '알 수 없는 사용자',
  someone: '누군가',

  genericSystem: (type) => `[시스템 메시지 (유형 ${type})]`,
  recipientAdd: (a, t) => `${a}님이 ${t}님을 그룹에 추가했어요.`,
  recipientRemove: (a, t) => `${a}님이 ${t}님을 그룹에서 내보냈어요.`,
  recipientLeave: (a) => `${a}님이 그룹을 나갔어요.`,
  callStarted: (a) => `${a}님이 통화를 시작했어요.`,
  callLasted: (a, d) => `${a}님이 시작한 통화가 ${d} 동안 이어졌어요.`,
  callMissed: (a) => `${a}님의 부재중 통화`,
  channelName: (a, n) => (n ? `${a}님이 채널 이름을 변경했어요: ${n}` : `${a}님이 채널 이름을 변경했어요.`),
  channelIcon: (a) => `${a}님이 채널 아이콘을 변경했어요.`,
  pinned: (a) => `${a}님이 이 채널에 메시지를 고정했어요.`,
  joined: (a) => `${a}님이 서버에 참여했어요.`,
  boost: (a, c) => (c && c > 1 ? `${a}님이 서버를 ${c}번 부스트했어요.` : `${a}님이 서버를 부스트했어요.`),
  boostTier: (a, c, l) =>
    `${c && c > 1 ? `${a}님이 서버를 ${c}번 부스트했어요.` : `${a}님이 서버를 부스트했어요.`} 서버가 레벨 ${l}에 도달했어요!`,
  followAdd: (a, n) =>
    n ? `${a}님이 이 채널에 채널 팔로우를 추가했어요: ${n}` : `${a}님이 이 채널에 채널 팔로우를 추가했어요.`,
  discoveryDisqualified: '이 서버가 서버 탐색 요건을 충족하지 못해 목록에서 제외되었어요.',
  discoveryRequalified: '이 서버가 다시 서버 탐색 요건을 충족해 목록에 다시 등록되었어요.',
  threadCreated: (a, n) => (n ? `${a}님이 스레드를 시작했어요: ${n}` : `${a}님이 스레드를 시작했어요.`),
  inviteReminder: '알림: 서버에 사람들을 초대해 보세요.',
  autoMod: (a) => `AutoMod가 ${a}님의 메시지에 조치를 취했어요.`,
  roleSubscription: (a) => `${a}님이 역할을 구독했어요.`,
  stageStart: (a, t) => (t ? `${a}님이 스테이지를 시작했어요: ${t}` : `${a}님이 스테이지를 시작했어요.`),
  stageEnd: (a, t) => (t ? `${a}님이 스테이지를 종료했어요: ${t}` : `${a}님이 스테이지를 종료했어요.`),
  stageSpeaker: (a) => `${a}님이 발언자가 되었어요.`,
  stageRaiseHand: (a) => `${a}님이 발언을 요청했어요.`,
  stageTopic: (a, t) => (t ? `${a}님이 스테이지 주제를 변경했어요: ${t}` : `${a}님이 스테이지 주제를 변경했어요.`),

  seconds: (n) => `${n}초`,
  minutes: (n) => `${n}분`,
  hoursMinutes: (h, m) => (m > 0 ? `${h}시간 ${m}분` : `${h}시간`),

  replyAttachment: '첨부 파일 보기',
  replyDeleted: '원본 메시지가 삭제되었어요',
  replyUnavailable: '원본 메시지를 불러올 수 없어요',

  attachment: '[첨부 파일]',
  sticker: '[스티커]',
  embed: '[임베드]',
  poll: '[투표]',
  forwarded: '[전달된 메시지]',
  spoiler: '[스포일러]',

  months: ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
  weekdays: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'],
  am: '오전',
  pm: '오후',
};

const TABLE: Record<MessageLocale, MessageStrings> = { ko, en };

/** Total on purpose: callers pass user-facing settings, so an unexpected value must not throw. */
export function getStrings(locale: MessageLocale | string | null | undefined): MessageStrings {
  return locale === 'ko' ? TABLE.ko : TABLE.en;
}
