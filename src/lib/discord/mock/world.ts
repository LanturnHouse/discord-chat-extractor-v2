import { snowflakeToTimestamp } from '../snowflake';
import { ChannelType } from '../types';
import type { Channel, GuildSummary, PermissionOverwrite, Role, Snowflake, User } from '../types';
import { MOCK_ME, person, prefersKorean } from './cast';
import { DAY, WORLD_NOW_MS, channelId, dmId, guildId, roleId, threadId } from './ids';
import { lastMessageIdOf } from './generate';
import { createRng, hashString } from './prng';
import { SHOWCASE_AUTHORS, buildShowcaseScript } from './showcase';
import { iconDataUri } from './svg';
import type { Flavour, GuildCtx, KindName, Lang, MessageProfile, ScriptEntry } from './types';

/** How `getMessages` behaves for a channel. */
export type Access =
  | 'ok'
  /** 403: hidden by permissions, or visible on paper but denied by the server. */
  | 'forbidden'
  /** Categories and forums hold no messages. */
  | 'unreadable';

export interface ChannelEntry {
  channel: Channel;
  access: Access;
  /** null for categories / forums. */
  profile: MessageProfile | null;
}

export interface GuildData {
  summary: GuildSummary;
  /** `GET /guilds/{id}/channels` in API order (deliberately shuffled; sort by `position`). */
  channels: Channel[];
  /** Active threads / forum posts. */
  threads: Channel[];
  roles: Role[];
  myRoles: Snowflake[];
}

export interface World {
  guilds: GuildData[];
  guildById: ReadonlyMap<Snowflake, GuildData>;
  dms: Channel[];
  /** Every channel, thread and DM that has an id. */
  entries: ReadonlyMap<Snowflake, ChannelEntry>;
}

// ---------------------------------------------------------------------------------------------------------------------
// permissions

const P = {
  kick: 1n << 1n,
  administrator: 1n << 3n,
  addReactions: 1n << 6n,
  view: 1n << 10n,
  send: 1n << 11n,
  manageMessages: 1n << 13n,
  embedLinks: 1n << 14n,
  attachFiles: 1n << 15n,
  readHistory: 1n << 16n,
  connect: 1n << 20n,
  speak: 1n << 21n,
};
const EVERYONE_PERMISSIONS = P.view | P.send | P.readHistory | P.addReactions | P.embedLinks | P.attachFiles | P.connect | P.speak;
const OWNER_PERMISSIONS = (1n << 51n) - 1n;

type RoleKey = 'everyone' | 'member' | 'developer' | 'moderator' | 'admin' | 'booster';

interface RoleDef {
  key: RoleKey;
  name: string;
  permissions: bigint;
  color: number;
}

const BASIC_ROLES: readonly RoleDef[] = [
  { key: 'everyone', name: '@everyone', permissions: EVERYONE_PERMISSIONS, color: 0 },
  { key: 'member', name: '멤버 Member', permissions: 0n, color: 0x95a5a6 },
];
const FULL_ROLES: readonly RoleDef[] = [
  ...BASIC_ROLES,
  { key: 'developer', name: 'Developer', permissions: 0n, color: 0x3498db },
  { key: 'moderator', name: 'Moderator', permissions: P.manageMessages | P.kick, color: 0x2ecc71 },
  { key: 'admin', name: 'Admin', permissions: P.administrator, color: 0xe74c3c },
  { key: 'booster', name: 'Server Booster', permissions: 0n, color: 0xf47fff },
];

interface OverwriteDef {
  who: RoleKey | 'me';
  allow?: bigint;
  deny?: bigint;
}

const HIDE_FROM_EVERYONE: OverwriteDef = { who: 'everyone', deny: P.view };
const STAFF_ONLY: readonly OverwriteDef[] = [
  HIDE_FROM_EVERYONE,
  { who: 'moderator', allow: P.view | P.send | P.readHistory },
  { who: 'admin', allow: P.view },
];

function overwritesOf(guildKey: string, defs: readonly OverwriteDef[]): PermissionOverwrite[] {
  return defs.map((d) => ({
    id: d.who === 'me' ? MOCK_ME.id : roleId(guildKey, d.who),
    type: d.who === 'me' ? 1 : 0,
    allow: (d.allow ?? 0n).toString(),
    deny: (d.deny ?? 0n).toString(),
  }));
}

/** Discord's algorithm (@everyone overwrite, then roles together, then the member overwrite) for the demo user. */
function userCanView(guildKey: string, roles: readonly RoleDef[], myRoles: readonly RoleKey[], owner: boolean, overwrites: readonly PermissionOverwrite[]): boolean {
  if (owner) return true;
  const gid = guildId(guildKey);
  let perms = 0n;
  for (const role of roles) if (role.key === 'everyone' || myRoles.includes(role.key)) perms |= role.permissions;
  if ((perms & P.administrator) !== 0n) return true;

  const apply = (o: PermissionOverwrite | undefined): void => {
    if (o) perms = (perms & ~BigInt(o.deny)) | BigInt(o.allow);
  };
  apply(overwrites.find((o) => o.type === 0 && o.id === gid));
  let allow = 0n;
  let deny = 0n;
  for (const key of myRoles) {
    const o = overwrites.find((x) => x.type === 0 && x.id === roleId(guildKey, key));
    if (o) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = (perms & ~deny) | allow;
  apply(overwrites.find((o) => o.type === 1 && o.id === MOCK_ME.id));
  return (perms & P.view) !== 0n;
}

// ---------------------------------------------------------------------------------------------------------------------
// declarative world description

interface MsgDef {
  n: number;
  flavour?: Flavour;
  lang?: Lang;
  /** Age of the newest message in days (default: stable pseudo-random 0-25). */
  endAgoDays?: number;
  /** Days between the oldest and newest message (default: n / 5, at most 220). */
  spanDays?: number;
  /** Gap before message `index`, in days. */
  gapsDays?: Record<number, number>;
  /** Use the hand-written showcase script (n is ignored). */
  showcase?: boolean;
}

interface ChDef {
  key: string;
  name: string;
  type: number;
  topic?: string;
  nsfw?: boolean;
  pos?: number;
  overwrites?: readonly OverwriteDef[];
  msgs?: MsgDef;
  /** Listed as readable, but the server answers 403. */
  forbidden?: boolean;
}

interface CatDef {
  key: string;
  name: string;
  pos: number;
  overwrites?: readonly OverwriteDef[];
  channels: ChDef[];
}

interface ThreadDef {
  key: string;
  name: string;
  parent: string;
  type?: number;
  owner?: string;
  msgs: MsgDef;
}

interface GuildDef {
  key: string;
  name: string;
  icon: boolean;
  owner?: boolean;
  features?: string[];
  fullRoles?: boolean;
  lang: Lang;
  /** Everybody who may write here, most active first. */
  authors: string[];
  loose: ChDef[];
  categories: CatDef[];
  threads: ThreadDef[];
}

const m = (n: number, flavour?: Flavour, lang?: Lang, extra: Partial<MsgDef> = {}): MsgDef => ({ n, flavour, lang, ...extra });
const text = (key: string, name: string, o: Partial<ChDef> = {}): ChDef => ({ key, name, type: ChannelType.GuildText, ...o });
const news = (key: string, name: string, o: Partial<ChDef> = {}): ChDef => ({ key, name, type: ChannelType.GuildAnnouncement, ...o });
const voice = (key: string, name: string, o: Partial<ChDef> = {}): ChDef => ({ key, name, type: ChannelType.GuildVoice, ...o });
const stage = (key: string, name: string, o: Partial<ChDef> = {}): ChDef => ({ key, name, type: ChannelType.GuildStageVoice, ...o });
const forum = (key: string, name: string, o: Partial<ChDef> = {}): ChDef => ({ key, name, type: ChannelType.GuildForum, ...o });

const BIG_AUTHORS = [
  'minjun', 'seoyeon', 'me', 'jiho', 'sua', 'woojin', 'alex', 'haeun', 'sam', 'dohyun', 'yerin', 'jordan',
  'jiwoo', 'sehun', 'taylor', 'morgan', 'casey', 'riley', 'pizza', 'mina', 'ahmad', 'muller', 'legacy', 'long',
];

const DEV_LOUNGE: GuildDef = {
  key: 'dev-lounge',
  name: '개발자 라운지',
  icon: true,
  fullRoles: true,
  features: ['COMMUNITY', 'NEWS'],
  lang: 'mixed',
  authors: BIG_AUTHORS,
  loose: [
    text('welcome', '👋｜welcome', { msgs: m(45, 'welcome', 'mixed', { endAgoDays: 1 }), topic: 'Say hi! 👋 새로 오신 분들은 여기서 인사해 주세요.' }),
    news('notice-ko', '📣｜공지사항', { msgs: m(22, 'announce', 'ko') }),
    text('daily-question', '❓｜오늘의-질문', { msgs: m(30, 'plain', 'ko') }),
    voice('lobby', '🔊 로비 Lobby', { pos: 0 }),
  ],
  categories: [
    {
      key: 'cat-info',
      name: '📌 INFORMATION',
      pos: 4,
      channels: [
        text('rules', 'rules', { msgs: m(8, 'announce', 'ko'), topic: '서버 규칙 / Server rules' }),
        text('faq', 'faq', { msgs: m(6, 'announce', 'mixed') }),
        news('announcements', 'announcements', { msgs: m(40, 'announce', 'mixed'), topic: '📣 Official announcements only. Follow this channel to get them in your own server.' }),
        text('changelog', 'changelog', { msgs: m(30, 'bots', 'en') }),
        text('roadmap', 'roadmap', { msgs: m(12, 'announce', 'en') }),
        text('useful-links', 'useful-links', { msgs: m(25, 'music', 'en'), topic: 'Docs, tools and reading lists' }),
      ],
    },
    {
      key: 'cat-general',
      name: '💬 일반 GENERAL',
      pos: 1,
      channels: [
        text('general', 'general', {
          msgs: m(2687, 'general', 'mixed', { endAgoDays: 0, spanDays: 245, gapsDays: { 1040: 75 } }),
          topic: 'Welcome! 자유롭게 대화하세요 💬\nRules: https://example.com/rules  ·  한국어 / English both welcome.',
        }),
        text('chitchat', '잡담', { msgs: m(350, 'chatty', 'ko') }),
        text('random', 'random', { msgs: m(210, 'chatty', 'en') }),
        text('memes', 'memes', { msgs: m(120, 'memes', 'mixed') }),
        text('showcase', 'feature-showcase', { msgs: m(0, 'showcase', 'mixed', { showcase: true, endAgoDays: 2, spanDays: 150 }), topic: 'One of everything: markdown, attachments, embeds, system messages …' }),
        text('intro', 'introductions', { msgs: m(60, 'intro', 'mixed') }),
        text('off-topic', 'off-topic', { msgs: m(180, 'chatty', 'en') }),
        text('ko-only', '한국어-전용', { msgs: m(260, 'general', 'ko') }),
        text('en-only', 'english-only', { msgs: m(150, 'general', 'en') }),
        text('bots', 'bots-playground', { msgs: m(300, 'bots', 'mixed') }),
        text('music', 'music-share', { msgs: m(90, 'music', 'mixed') }),
        text('photos', 'photos', { msgs: m(70, 'photos', 'mixed') }),
        // Lowest position of the category, yet displayed after the text channels.
        voice('voice-chat-ko', '🎧 잡담 음성', { pos: 0, msgs: m(15, 'voicechat', 'ko') }),
      ],
    },
    {
      key: 'cat-dev',
      name: '💻 DEVELOPMENT',
      pos: 6,
      channels: [
        text('frontend', 'frontend', { msgs: m(390, 'code', 'mixed'), topic: 'React · Vite · CSS — 프론트엔드 이야기' }),
        text('backend', 'backend', { msgs: m(320, 'code', 'en') }),
        text('devops', 'devops', { msgs: m(140, 'code', 'en') }),
        text('code-review', 'code-review', { msgs: m(210, 'code', 'mixed') }),
        text('help', 'help', { msgs: m(370, 'code', 'mixed'), topic: '질문은 여기서! Ask anything. Please include a minimal reproduction.' }),
        forum('forum', '질문-게시판', { topic: '질문마다 새 게시글을 만들어 주세요.' }),
        text('design', 'design', { msgs: m(60, 'plain', 'mixed') }),
        text('security', 'security', { msgs: m(45, 'code', 'en') }),
        text('mobile', 'mobile', { msgs: m(80, 'code', 'ko') }),
        text('data-science', 'data-science', { msgs: m(110, 'code', 'en') }),
        text('tests', 'tests', { msgs: m(35, 'bots', 'en') }),
      ],
    },
    {
      key: 'cat-test',
      name: '🧪 TEST · EDGE CASES',
      pos: 9,
      channels: [
        text('edge-199', 'edge-199', { msgs: m(199, 'plain', 'mixed', { endAgoDays: 3, spanDays: 12 }) }),
        text('edge-200', 'edge-200', { msgs: m(200, 'plain', 'mixed', { endAgoDays: 4, spanDays: 12 }) }),
        text('edge-201', 'edge-201', { msgs: m(201, 'plain', 'mixed', { endAgoDays: 5, spanDays: 12 }) }),
        text('edge-400', 'edge-400', { msgs: m(400, 'plain', 'mixed', { endAgoDays: 2, spanDays: 20 }) }),
        text('edge-401', 'edge-401', { msgs: m(401, 'plain', 'mixed', { endAgoDays: 6, spanDays: 20 }) }),
        text('empty', 'empty-channel', { msgs: m(0, 'plain') }),
        text('forbidden', '비공개-라운지', { forbidden: true, msgs: m(30, 'plain', 'ko'), topic: 'Looks open, but the server says 403.' }),
        text('con', 'con', { msgs: m(6, 'plain', 'en') }),
        text('nul', 'nul', { msgs: m(4, 'plain', 'en') }),
      ],
    },
    {
      key: 'cat-perms',
      name: '🔐 PERMISSIONS',
      pos: 7,
      channels: [
        text('devs-only', 'devs-only', { overwrites: [HIDE_FROM_EVERYONE, { who: 'developer', allow: P.view }], msgs: m(80, 'code', 'en') }),
        text('secret-club', 'secret-club', { overwrites: [HIDE_FROM_EVERYONE, { who: 'me', allow: P.view }], msgs: m(40, 'chatty', 'ko') }),
        text('role-conflict', 'role-conflict', { overwrites: [{ who: 'member', deny: P.view }, { who: 'developer', allow: P.view }], msgs: m(25, 'plain', 'en') }),
        text('personal-block', 'personal-block', { overwrites: [{ who: 'me', deny: P.view }], msgs: m(30, 'plain', 'en') }),
      ],
    },
    {
      key: 'cat-voice',
      name: '🔊 VOICE 음성',
      pos: 2,
      channels: [
        voice('voice-lounge', '라운지 Lounge', { msgs: m(20, 'voicechat', 'mixed') }),
        voice('voice-study1', '스터디룸 1'),
        voice('voice-study2', '스터디룸 2', { msgs: m(5, 'voicechat', 'ko') }),
        voice('voice-music', 'Music 🎵'),
        voice('voice-meeting', '회의실', { msgs: m(8, 'voicechat', 'ko') }),
        stage('stage', 'Town Hall 타운홀', { msgs: m(14, 'voicechat', 'mixed'), topic: '월간 타운홀 / Monthly town hall' }),
      ],
    },
    { key: 'cat-archive', name: '🗃️ ARCHIVE', pos: 12, channels: [] },
    {
      key: 'cat-staff',
      name: '🛡️ STAFF ONLY',
      pos: 3,
      overwrites: STAFF_ONLY,
      channels: [
        text('mod-only', 'mod-only', { overwrites: STAFF_ONLY, msgs: m(90, 'plain', 'en') }),
        text('mod-log', 'mod-log', { overwrites: STAFF_ONLY, msgs: m(60, 'bots', 'en') }),
        voice('staff-voice', 'staff-voice', { overwrites: STAFF_ONLY }),
      ],
    },
  ],
  threads: [
    { key: 'forum-ts-generics', name: 'TypeScript 5.x strict 모드에서 제네릭 추론이 안 돼요', parent: 'forum', msgs: m(42, 'thread', 'ko', { spanDays: 5 }) },
    { key: 'forum-vite-chunk', name: '[해결됨] Vite 빌드 시 청크 크기 경고', parent: 'forum', msgs: m(28, 'thread', 'ko', { spanDays: 3 }) },
    { key: 'forum-mv3-worker', name: 'Chrome extension MV3 service worker keeps dying', parent: 'forum', msgs: m(36, 'thread', 'en', { spanDays: 4 }) },
    { key: 'forum-first-pr', name: '🎉 첫 번째 PR 올렸어요! 리뷰 부탁드려요', parent: 'forum', msgs: m(12, 'thread', 'ko', { spanDays: 2 }) },
    {
      key: 'forum-long-title',
      name: 'A very long forum post title that keeps going and going to check how titles wrap in the sidebar list view okay',
      parent: 'forum',
      msgs: m(7, 'thread', 'en', { spanDays: 1 }),
    },
    { key: 'general-lunch-poll', name: '점심 메뉴 투표 🍜', parent: 'general', msgs: m(24, 'thread', 'ko', { spanDays: 1 }) },
    { key: 'general-release-notes', name: 'v2.0 릴리즈 노트 토론', parent: 'general', msgs: m(60, 'thread', 'mixed', { spanDays: 6 }) },
    { key: 'showcase-a', name: 'showcase thread A', parent: 'showcase', msgs: m(8, 'thread', 'en', { spanDays: 1 }) },
    { key: 'showcase-single', name: 'Thread with a single message', parent: 'showcase', msgs: m(1, 'thread', 'en', { spanDays: 1 }) },
    { key: 'frontend-react19', name: '리액트 19 마이그레이션', parent: 'frontend', msgs: m(30, 'thread', 'mixed', { spanDays: 4 }) },
    { key: 'announce-questions', name: '공지 질문 스레드', parent: 'announcements', type: ChannelType.AnnouncementThread, msgs: m(5, 'thread', 'ko', { spanDays: 1 }) },
  ],
};

const LONG_GUILD_NAME = 'The Extremely Long Server Name That Keeps Going On And On Until It Surely Overflows Every Single Layout Container Ever Made'.slice(0, 100);

const SMALL_GUILDS: readonly GuildDef[] = [
  {
    key: 'open-source-garage',
    name: 'Open Source Garage',
    icon: true,
    owner: true,
    lang: 'en',
    authors: ['alex', 'sam', 'me', 'jordan', 'morgan', 'casey', 'riley'],
    loose: [text('welcome-sm', '👋-welcome', { msgs: m(20, 'welcome', 'en') })],
    categories: [
      {
        key: 'projects',
        name: 'Projects',
        pos: 0,
        channels: [
          text('ui-kit', 'ui-kit', { msgs: m(120, 'code', 'en') }),
          text('core-lib', 'core-lib', { msgs: m(80, 'code', 'en') }),
          text('docs', 'docs', { msgs: m(45, 'plain', 'en') }),
        ],
      },
      {
        key: 'community',
        name: 'Community',
        pos: 1,
        channels: [
          text('hangout', 'hangout', { msgs: m(150, 'chatty', 'en') }),
          text('help-wanted', 'help-wanted', { msgs: m(60, 'code', 'en') }),
          text('show-and-tell', 'show-and-tell', { msgs: m(30, 'photos', 'en') }),
        ],
      },
    ],
    threads: [{ key: 'garage-rfc', name: 'RFC: new plugin API', parent: 'core-lib', msgs: m(30, 'thread', 'en', { spanDays: 3 }) }],
  },
  {
    key: 'game-night',
    name: '🎮🔥 Game Night 🎲✨',
    icon: false,
    lang: 'mixed',
    authors: ['pizza', 'minjun', 'alex', 'mina', 'me', 'sua', 'jiho'],
    loose: [
      text('lobby-g', '🎮-lobby', { msgs: m(90, 'chatty', 'mixed') }),
      text('boards', '🎲-board-games', { msgs: m(70, 'chatty', 'mixed') }),
      text('scores', '🏆-leaderboard', { msgs: m(20, 'bots', 'en') }),
    ],
    categories: [{ key: 'voice-g', name: '🔊 Voice', pos: 0, channels: [voice('party1', '🎧 Party 1'), voice('party2', '🎧 Party 2')] }],
    threads: [],
  },
  {
    key: 'long-name',
    name: LONG_GUILD_NAME,
    icon: true,
    lang: 'en',
    authors: ['jordan', 'taylor', 'me', 'sam'],
    loose: [text('general-l', 'general', { msgs: m(30, 'chatty', 'en') }), text('off-topic-l', 'off-topic', { msgs: m(12, 'plain', 'en') }), news('news-l', 'announcements', { msgs: m(6, 'announce', 'en') })],
    categories: [],
    threads: [],
  },
  {
    key: 'special-chars',
    name: 'A/B:C*?',
    icon: false,
    lang: 'mixed',
    authors: ['riley', 'casey', 'me', 'seoyeon'],
    loose: [text('a-b-c', 'a-b-c', { msgs: m(25, 'chatty', 'mixed') }), text('questions', 'questions', { msgs: m(10, 'plain', 'en') })],
    categories: [],
    threads: [],
  },
  {
    key: 'reserved-con',
    name: 'CON',
    icon: true,
    lang: 'en',
    authors: ['sam', 'alex', 'me'],
    loose: [
      text('general-c', 'general', { msgs: m(20, 'chatty', 'en') }),
      text('com1', 'com1', { msgs: m(10, 'plain', 'en') }),
      text('lpt1', 'lpt1', { msgs: m(5, 'plain', 'en') }),
      text('prn', 'prn', { msgs: m(0, 'plain', 'en') }),
      text('aux', 'aux', { msgs: m(8, 'plain', 'en') }),
    ],
    categories: [],
    threads: [],
  },
  {
    key: 'hostile-name',
    name: '<b>bold</b> & "quotes" <script>alert(1)</script>',
    icon: true,
    lang: 'en',
    authors: ['muller', 'evil', 'me'],
    loose: [
      text('img', '<img src=x onerror=alert(1)>', { msgs: m(12, 'chatty', 'en'), topic: "<script>alert('topic')</script> & \"quotes\"" }),
      text('normal-h', 'normal', { msgs: m(8, 'plain', 'en') }),
    ],
    categories: [],
    threads: [],
  },
  {
    key: 'rtl',
    name: 'مجتمع المطورين',
    icon: true,
    lang: 'en',
    authors: ['ahmad', 'me', 'alex'],
    loose: [text('ar-general', 'عام', { msgs: m(30, 'chatty', 'en') }), text('en-general', 'general', { msgs: m(10, 'plain', 'en') })],
    categories: [],
    threads: [],
  },
  {
    key: 'dots',
    name: 'Archive of 2024...',
    icon: false,
    lang: 'en',
    authors: ['me', 'minjun'],
    loose: [text('dots-general', 'general', { msgs: m(5, 'plain', 'mixed') })],
    categories: [],
    threads: [],
  },
];

const GUILD_DEFS: readonly GuildDef[] = [DEV_LOUNGE, ...SMALL_GUILDS];

// DM partners with their message counts (most recent conversations first); 30 one-to-one DMs.
const DM_FRIENDS: readonly (readonly [string, number])[] = [
  ['minjun', 400], ['seoyeon', 250], ['alex', 180], ['jiho', 120], ['haeun', 90], ['sam', 75], ['sua', 60], ['woojin', 55],
  ['pizza', 40], ['mina', 33], ['dohyun', 28], ['jordan', 24], ['yerin', 20], ['legacy', 17], ['taylor', 14], ['jiwoo', 12],
  ['morgan', 10], ['long', 9], ['sehun', 8], ['ahmad', 7], ['casey', 6], ['riley', 5], ['muller', 4], ['hajun', 3],
  ['doyun', 3], ['seojun', 2], ['emma', 2], ['noah', 1], ['olivia', 1], ['liam', 0],
];

interface GroupDef {
  key: string;
  name: string | null;
  icon: boolean;
  recipients: string[];
  msgs: MsgDef;
}

const GROUP_DMS: readonly GroupDef[] = [
  { key: 'group-board-games', name: '주말 보드게임 모임 🎲', icon: true, recipients: ['alex', 'sua', 'jiho', 'mina'], msgs: m(180, 'group-dm', 'mixed', { endAgoDays: 1 }) },
  { key: 'group-trip', name: null, icon: false, recipients: ['alex', 'sam', 'jordan'], msgs: m(90, 'group-dm', 'en', { endAgoDays: 6 }) },
  {
    key: 'group-large',
    name: null,
    icon: false,
    recipients: ['minjun', 'seoyeon', 'jiho', 'sua', 'woojin', 'haeun', 'dohyun', 'yerin'],
    msgs: m(40, 'group-dm', 'ko', { endAgoDays: 14 }),
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// building

function endMsOf(seedKey: string, def: MsgDef): number {
  const ago = def.endAgoDays !== undefined ? def.endAgoDays * DAY : (hashString(`end:${seedKey}`) % 2500) * (DAY / 100);
  return WORLD_NOW_MS - Math.round(ago);
}

function spanMsOf(count: number, def: MsgDef): number {
  const days = def.spanDays ?? Math.min(220, Math.max(1, count / 5));
  return Math.round(days * DAY);
}

function authorPool(def: GuildDef, seedKey: string, flavour: Flavour, lang: Lang, count: number): User[] {
  let keys: string[];
  if (flavour === 'showcase') keys = [...SHOWCASE_AUTHORS];
  else if (flavour === 'bots') keys = ['minjun', 'me', 'alex'];
  else if (flavour === 'announce') keys = ['seoyeon', 'minjun', 'me'];
  else {
    const byLang = def.authors.filter((k) => k === 'me' || lang === 'mixed' || prefersKorean(person(k)) === (lang === 'ko'));
    const size = count < 30 ? 4 : count < 100 ? 8 : byLang.length;
    keys = createRng(`authors/${seedKey}`).shuffle(byLang.filter((k) => k !== 'me')).slice(0, Math.max(1, size - 1));
    keys.splice(Math.min(2, keys.length), 0, 'me'); // the demo user takes part in every conversation
  }
  return keys.map(person);
}

interface ProfileInput {
  seedKey: string;
  channelId: Snowflake;
  guild: GuildDef | null;
  guildCtx: GuildCtx | null;
  def: MsgDef;
  fallbackFlavour: Flavour;
  authors?: User[];
  threads?: readonly Channel[];
  firstKind?: KindName;
  group?: boolean;
  /** Fixes the newest message to this time (threads) instead of deriving it from the definition. */
  endMs?: number;
}

function makeProfile(input: ProfileInput): MessageProfile {
  const { seedKey, def } = input;
  const flavour = def.flavour ?? input.fallbackFlavour;
  const lang = def.lang ?? input.guild?.lang ?? 'mixed';
  const script: ScriptEntry[] | null = def.showcase ? buildShowcaseScript() : null;
  const count = script ? script.length : def.n;

  const pinnedGaps: Record<number, number> = {};
  for (const [index, days] of Object.entries(def.gapsDays ?? {})) pinnedGaps[Number(index)] = Math.round(days * DAY);
  script?.forEach((entry, index) => {
    if (entry.gapBeforeMs !== undefined && index > 0) pinnedGaps[index] = entry.gapBeforeMs;
  });

  return {
    seedKey,
    channelId: input.channelId,
    guild: input.guildCtx,
    flavour,
    lang,
    count,
    endMs: input.endMs ?? endMsOf(seedKey, def),
    spanMs: spanMsOf(count, def),
    pinnedGaps,
    authors: input.authors ?? (input.guild ? authorPool(input.guild, seedKey, flavour, lang, count) : []),
    script,
    threads: input.threads ?? [],
    ...(input.firstKind ? { firstKind: input.firstKind } : {}),
    group: input.group === true,
  };
}

const READABLE_TYPES: ReadonlySet<number> = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const MENTIONABLE_TYPES: ReadonlySet<number> = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

function buildGuild(def: GuildDef, entries: Map<Snowflake, ChannelEntry>): GuildData {
  const gid = guildId(def.key);
  const roleDefs = def.fullRoles ? FULL_ROLES : BASIC_ROLES;
  const myRoleKeys: RoleKey[] = def.fullRoles ? ['member', 'developer'] : ['member'];
  const owner = def.owner === true;

  const roles: Role[] = roleDefs.map((r, position) => ({
    id: roleId(def.key, r.key),
    name: r.name,
    permissions: r.permissions.toString(),
    position,
    color: r.color,
  }));

  let basePermissions = 0n;
  for (const r of roleDefs) if (r.key === 'everyone' || myRoleKeys.includes(r.key)) basePermissions |= r.permissions;

  const summary: GuildSummary = {
    id: gid,
    name: def.name,
    icon: def.icon ? iconDataUri(def.name, def.key) : null,
    owner,
    permissions: (owner ? OWNER_PERMISSIONS : basePermissions).toString(),
    features: def.features ?? [],
  };

  // Channel objects ---------------------------------------------------------------------------------------------
  interface Pending {
    def: ChDef;
    channel: Channel;
    access: Access;
  }
  const pending: Pending[] = [];
  const channels: Channel[] = [];

  const addChannel = (c: ChDef, parent: CatDef | null, autoPosition: number): void => {
    const overwrites = overwritesOf(def.key, c.overwrites ?? []);
    const channel: Channel = {
      id: channelId(def.key, c.key),
      type: c.type,
      guild_id: gid,
      name: c.name,
      parent_id: parent ? channelId(def.key, parent.key) : null,
      position: c.pos ?? autoPosition,
      topic: c.topic ?? null,
      nsfw: c.nsfw === true,
      last_message_id: null,
      permission_overwrites: overwrites,
    };
    let access: Access;
    if (c.type === ChannelType.GuildForum) access = 'unreadable';
    else if (!userCanView(def.key, roleDefs, myRoleKeys, owner, overwrites) || c.forbidden === true) access = 'forbidden';
    else access = 'ok';
    pending.push({ def: c, channel, access });
    channels.push(channel);
  };

  def.loose.forEach((c, i) => addChannel(c, null, i * 3 + 1));
  for (const cat of def.categories) {
    const overwrites = overwritesOf(def.key, cat.overwrites ?? []);
    const category: Channel = {
      id: channelId(def.key, cat.key),
      type: ChannelType.GuildCategory,
      guild_id: gid,
      name: cat.name,
      parent_id: null,
      position: cat.pos,
      permission_overwrites: overwrites,
    };
    channels.push(category);
    entries.set(category.id, { channel: category, access: 'unreadable', profile: null });
    cat.channels.forEach((c, i) => addChannel(c, cat, i * 3 + 1));
  }

  const guildCtx: GuildCtx = {
    id: gid,
    roleIds: roles.filter((r) => r.id !== gid).map((r) => r.id),
    channels: pending.filter((p) => p.access === 'ok' && MENTIONABLE_TYPES.has(p.channel.type)).map((p) => ({ id: p.channel.id, name: p.channel.name ?? '' })),
  };

  // Threads -----------------------------------------------------------------------------------------------------
  const threadsByParent = new Map<Snowflake, Channel[]>();
  const threadChannels: Channel[] = [];
  const threadProfiles: { channel: Channel; def: ThreadDef; parent: Pending }[] = [];
  for (const t of def.threads) {
    const parent = pending.find((p) => p.def.key === t.parent);
    if (!parent) throw new Error(`mock: thread "${t.key}" has unknown parent "${t.parent}"`);
    const id = threadId(def.key, t.key);
    const startMs = snowflakeToTimestamp(id);
    const channel: Channel = {
      id,
      type: t.type ?? ChannelType.PublicThread,
      guild_id: gid,
      parent_id: parent.channel.id,
      name: t.name,
      owner_id: person(t.owner ?? def.authors[0]).id,
      last_message_id: null,
      message_count: t.msgs.n,
      thread_metadata: { archived: false, locked: false, archive_timestamp: new Date(startMs).toISOString() },
    };
    threadChannels.push(channel);
    threadProfiles.push({ channel, def: t, parent });
    const siblings = threadsByParent.get(parent.channel.id);
    if (siblings) siblings.push(channel);
    else threadsByParent.set(parent.channel.id, [channel]);
  }

  // Message profiles --------------------------------------------------------------------------------------------
  for (const p of pending) {
    let profile: MessageProfile | null = null;
    if (READABLE_TYPES.has(p.channel.type)) {
      const seedKey = `${def.key}/${p.def.key}`;
      profile = makeProfile({
        seedKey,
        channelId: p.channel.id,
        guild: def,
        guildCtx,
        def: p.def.msgs ?? m(0),
        fallbackFlavour: 'plain',
        threads: threadsByParent.get(p.channel.id),
      });
      p.channel.last_message_id = lastMessageIdOf(profile);
    }
    entries.set(p.channel.id, { channel: p.channel, access: p.access, profile });
  }

  for (const { channel, def: t, parent } of threadProfiles) {
    const seedKey = `${def.key}/thread/${t.key}`;
    const startMs = snowflakeToTimestamp(channel.id);
    const spanMs = spanMsOf(t.msgs.n, t.msgs);
    const profile = makeProfile({
      seedKey,
      channelId: channel.id,
      guild: def,
      guildCtx,
      def: t.msgs,
      fallbackFlavour: 'thread',
      endMs: Math.min(startMs + spanMs, WORLD_NOW_MS - DAY),
      firstKind: parent.def.type === ChannelType.GuildForum ? 'long' : undefined,
    });
    channel.last_message_id = lastMessageIdOf(profile);
    // Forum posts are readable whenever the forum itself is visible; its own 'unreadable' only means "has no messages".
    entries.set(channel.id, { channel, access: parent.access === 'unreadable' ? 'ok' : parent.access, profile });
  }

  // API order: shuffled on purpose; consumers must sort by `position`.
  const shuffled = createRng(`shuffle/${def.key}`).shuffle(channels);
  return { summary, channels: shuffled, threads: threadChannels, roles, myRoles: myRoleKeys.map((k) => roleId(def.key, k)) };
}

function buildDms(entries: Map<Snowflake, ChannelEntry>): Channel[] {
  const dms: Channel[] = [];

  DM_FRIENDS.forEach(([key, count], i) => {
    const friend = person(key);
    const id = dmId(key);
    const channel: Channel = { id, type: ChannelType.DM, name: null, last_message_id: null, recipients: [friend] };
    const profile = makeProfile({
      seedKey: `dm/${key}`,
      channelId: id,
      guild: null,
      guildCtx: null,
      def: m(count, 'dm', key === 'minjun' ? 'mixed' : prefersKorean(friend) ? 'ko' : 'en', {
        endAgoDays: Math.round((i * 2.5 + (hashString(`dm-end:${key}`) % 20) / 10) * 10) / 10,
        spanDays: Math.max(1, Math.round(count / 3)),
      }),
      fallbackFlavour: 'dm',
      authors: [MOCK_ME, friend],
    });
    channel.last_message_id = lastMessageIdOf(profile);
    entries.set(id, { channel, access: 'ok', profile });
    dms.push(channel);
  });

  for (const g of GROUP_DMS) {
    const id = dmId(g.key);
    const recipients = g.recipients.map(person);
    const channel: Channel = {
      id,
      type: ChannelType.GroupDM,
      name: g.name,
      icon: g.icon ? iconDataUri(g.name ?? g.key, g.key) : null,
      owner_id: MOCK_ME.id,
      last_message_id: null,
      recipients,
    };
    const profile = makeProfile({
      seedKey: `dm/${g.key}`,
      channelId: id,
      guild: null,
      guildCtx: null,
      def: g.msgs,
      fallbackFlavour: 'group-dm',
      authors: [MOCK_ME, ...recipients],
      group: true,
    });
    channel.last_message_id = lastMessageIdOf(profile);
    entries.set(id, { channel, access: 'ok', profile });
    dms.push(channel);
  }

  return createRng('shuffle/dms').shuffle(dms);
}

let cached: World | undefined;

/** The demo world. Immutable and shared; the client hands out copies. Built on first use. */
export function getWorld(): World {
  if (cached) return cached;
  const entries = new Map<Snowflake, ChannelEntry>();
  const guilds = GUILD_DEFS.map((def) => buildGuild(def, entries));
  const dms = buildDms(entries);
  cached = { guilds, guildById: new Map(guilds.map((g) => [g.summary.id, g])), dms, entries };
  return cached;
}
