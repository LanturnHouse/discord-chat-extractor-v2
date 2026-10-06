import { MessageType } from '../types';
import type {
  Attachment,
  Channel,
  Embed,
  EmbedMedia,
  Message,
  MessageReference,
  MessageSnapshotMessage,
  PartialEmoji,
  Poll,
  Reaction,
  Snowflake,
  StickerItem,
  User,
} from '../types';
import { CUSTOM_EMOJIS, HELPER_BOT, WEBHOOK_USER, emojiMarkup, person } from './cast';
import {
  EN_CASUAL,
  EN_SENTENCES,
  KO_CASUAL,
  KO_SENTENCES,
  LINKS,
  LONG_EN,
  LONG_KO,
  LONG_MIXED,
  MARKDOWN_SAMPLES,
  MULTILINGUAL,
  SERVER_NAMES,
  SHORT_EN,
  SHORT_KO,
  nearLimitText,
} from './content';
import { DAY, HOUR, MINUTE, SECOND, isoOf, keyId, mintId, syntheticId } from './ids';
import type { Rng } from './prng';
import { iconDataUri, imageDataUri } from './svg';
import type { GuildCtx, KindName, Lang, MessageParts } from './types';

/** Everything a builder may look at. Randomness only through `rng` (seeded per message) so output is deterministic. */
export interface BuildCtx {
  rng: Rng;
  index: number;
  ts: number;
  id: Snowflake;
  channelId: Snowflake;
  guild: GuildCtx | null;
  author: User;
  pool: readonly User[];
  lang: Lang;
  /** DM-style small talk instead of workplace chatter. */
  casual: boolean;
  variant: number;
  me: User;
  /** The earlier message this one replies to / pins. */
  target: Message | undefined;
  threads: readonly Channel[];
}

export interface KindDef {
  variants: number;
  /** Variants 0..randomVariants-1 may occur in ordinary channels; the rest is reserved for the showcase (default: all). */
  randomVariants?: number;
  /** System messages cannot be replied to or pinned. */
  system?: true;
  /** `undefined` => not possible in this context (e.g. no thread to announce): the generator falls back to plain text. */
  build(c: BuildCtx): MessageParts | undefined;
}

const UNICODE_REACTIONS: readonly string[] = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '🔥', '😮', '😢', '✅', '💯', '🤔', '👏', '🚀'];

const MESSAGE_FLAGS = { crossposted: 1, suppressEmbeds: 4, voiceMessage: 8192, hasSnapshot: 16384 } as const;

// ---------------------------------------------------------------------------------------------------------------------
// text helpers

function sentencePool(c: BuildCtx): readonly string[] {
  const ko = c.casual ? KO_CASUAL : KO_SENTENCES;
  const en = c.casual ? EN_CASUAL : EN_SENTENCES;
  if (c.lang === 'ko') return ko;
  if (c.lang === 'en') return en;
  return c.rng.chance(0.6) ? ko : en;
}

/** One or two sentences, always in the same language (the language is chosen once per message). */
function pickText(c: BuildCtx): string {
  const pool = sentencePool(c);
  const count = c.rng.chance(0.22) ? 2 : 1;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(c.rng.pick(pool));
  return parts.join(c.rng.chance(0.15) ? '\n' : ' ');
}

function pickShort(c: BuildCtx): string {
  const ko = c.lang === 'ko' || (c.lang === 'mixed' && c.rng.chance(0.6));
  return c.rng.pick(ko ? SHORT_KO : SHORT_EN);
}

function isKorean(c: BuildCtx): boolean {
  return c.lang === 'ko' || (c.lang === 'mixed' && c.rng.chance(0.5));
}

function others(c: BuildCtx): readonly User[] {
  const list = c.pool.filter((u) => u.id !== c.author.id);
  return list.length > 0 ? list : [c.me];
}

function reference(c: BuildCtx, messageId: Snowflake | undefined, type?: number): MessageReference {
  const ref: MessageReference = { channel_id: c.channelId };
  if (type !== undefined) ref.type = type;
  if (messageId !== undefined) ref.message_id = messageId;
  if (c.guild) ref.guild_id = c.guild.id;
  return ref;
}

// ---------------------------------------------------------------------------------------------------------------------
// attachment / embed helpers

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
};

function contentTypeOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function attachmentId(c: BuildCtx, slot: number): Snowflake {
  return mintId(c.ts, c.index * 8 + slot + 1, 1021);
}

function signedUrl(c: BuildCtx, host: string, id: Snowflake, filename: string): string {
  const issued = Math.floor(c.ts / SECOND);
  const signature = Array.from({ length: 8 }, () => c.rng.int(0, 0xffffffff).toString(16).padStart(8, '0')).join('');
  return `https://${host}/attachments/${c.channelId}/${id}/${encodeURIComponent(filename)}?ex=${(issued + 86400).toString(16)}&is=${issued.toString(16)}&hm=${signature}&`;
}

/** Images are self-contained data URIs (offline demo); `width`/`height` are set like for real image attachments. */
function imageAttachment(c: BuildCtx, slot: number, filename: string, width: number, height: number, extra: Partial<Attachment> = {}): Attachment {
  const uri = imageDataUri({ width, height, label: filename.replace(/^SPOILER_/, '').replace(/\.[a-z]+$/i, ''), seed: `photo${(c.index + slot) % 16}` });
  return {
    id: attachmentId(c, slot),
    filename,
    content_type: contentTypeOf(filename),
    size: Math.round((width * height) / 4),
    url: uri,
    proxy_url: uri,
    width,
    height,
    ...extra,
  };
}

function fileAttachment(c: BuildCtx, slot: number, filename: string, size: number, extra: Partial<Attachment> = {}): Attachment {
  const id = attachmentId(c, slot);
  return {
    id,
    filename,
    content_type: contentTypeOf(filename),
    size,
    url: signedUrl(c, 'cdn.discordapp.com', id, filename),
    proxy_url: signedUrl(c, 'media.discordapp.net', id, filename),
    ...extra,
  };
}

function media(c: BuildCtx, width: number, height: number, label: string, play = false): EmbedMedia {
  const uri = imageDataUri({ width, height, label, seed: `embed${c.index % 8}`, play });
  return { url: uri, proxy_url: uri, width, height };
}

function articleEmbed(c: BuildCtx, link: readonly [string, string, string, string]): Embed {
  const [url, title, description, provider] = link;
  return { type: 'article', url, title, description, provider: { name: provider }, thumbnail: media(c, 480, 270, provider) };
}

function richEmbed(c: BuildCtx): Embed {
  const icon = iconDataUri('Status Page', 'status-page');
  const ko = isKorean(c);
  return {
    type: 'rich',
    color: c.rng.pick([0x5865f2, 0x57f287, 0xfee75c, 0xeb459e, 0xed4245]),
    title: ko ? '서버 점검 안내' : 'Scheduled maintenance',
    url: 'https://example.com/status',
    description: ko
      ? '**오늘 02:00 ~ 04:00 (KST)** 에 점검이 진행됩니다.\n점검 중에는 일부 기능이 제한될 수 있어요. [자세히 보기](https://example.com/status)'
      : '**Tonight 02:00 - 04:00 (UTC)** the platform will be in maintenance mode.\nSome features may be unavailable. [Details](https://example.com/status)',
    author: { name: 'Status Page', url: 'https://example.com', icon_url: icon, proxy_icon_url: icon },
    fields: [
      { name: ko ? '영향 범위' : 'Affected', value: 'API, Web', inline: true },
      { name: ko ? '예상 시간' : 'Duration', value: ko ? '2시간' : '2 hours', inline: true },
      { name: ko ? '담당' : 'Owner', value: ko ? '인프라팀' : 'Infra team', inline: true },
      { name: ko ? '참고' : 'Notes', value: ko ? '점검 전에 작업 내용을 저장해 주세요.\n`rollback` 은 자동으로 진행됩니다.' : 'Please save your work before the window.\n`rollback` is automatic.', inline: false },
    ],
    thumbnail: media(c, 256, 256, 'status'),
    image: media(c, 800, 400, 'uptime chart'),
    footer: { text: 'Status Bot • example.com', icon_url: icon, proxy_icon_url: icon },
    timestamp: isoOf(c.ts - 5 * MINUTE),
  };
}

function thumbnailImageEmbed(c: BuildCtx): Embed {
  return { type: 'image', url: 'https://example.com/images/cat.png', thumbnail: media(c, 640, 480, 'cat.png') };
}

// ---------------------------------------------------------------------------------------------------------------------
// reactions (applied as an overlay by the generator)

export function makeReactions(c: BuildCtx): Reaction[] {
  const wanted = c.rng.int(1, 4);
  const seen = new Set<string>();
  const out: Reaction[] = [];
  for (let i = 0; i < wanted; i++) {
    let emoji: PartialEmoji;
    if (c.rng.chance(0.3)) {
      const e = c.rng.pick(CUSTOM_EMOJIS);
      emoji = { id: e.id, name: e.name, animated: e.animated };
    } else {
      emoji = { id: null, name: c.rng.pick(UNICODE_REACTIONS) };
    }
    const key = `${emoji.id ?? ''}|${emoji.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ count: c.rng.chance(0.6) ? c.rng.int(1, 4) : c.rng.int(5, 24), me: c.rng.chance(0.3), emoji });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// polls

function makePoll(c: BuildCtx, opts: { finalized: boolean; multi: boolean; emoji: boolean }): Poll {
  const ko = isKorean(c);
  const texts = ko ? ['칼국수', '김치찌개', '샐러드', '분식'] : ['Ramen', 'Pizza', 'Salad', 'Tacos'];
  const emojis = ['🍜', '🍲', '🥗', '🌮'];
  const answers = texts.slice(0, opts.multi ? 4 : 3).map((text, i) => ({
    answer_id: i + 1,
    poll_media: opts.emoji ? { text, emoji: { id: null, name: emojis[i] } } : { text },
  }));
  return {
    question: { text: ko ? '점심 뭐 먹을까요?' : 'Where should we go for lunch?' },
    answers,
    expiry: isoOf(c.ts + (opts.finalized ? 2 : 24) * HOUR),
    allow_multiselect: opts.multi,
    results: {
      is_finalized: opts.finalized,
      answer_counts: answers.map((a, i) => ({ id: a.answer_id, count: c.rng.int(0, 9) + (i === 0 ? 3 : 0), me_voted: i === 1 })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// builders

const UNIX = (ms: number): number => Math.floor(ms / SECOND);
const TIMESTAMP_STYLES = ['t', 'T', 'd', 'D', 'f', 'F', 'R'] as const;
const GROUP_NAMES = ['주말 보드게임 모임 🎲', 'Weekend Plans', '제주도 여행 ✈️'];

function hostileBuilder(c: BuildCtx): MessageParts {
  const evil = person('evil');
  switch (c.variant) {
    case 0:
      return { content: '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>not bold</b> &amp; &lt; "double" \'single\' `<b>`' };
    case 1:
      return { content: '[click me](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) <javascript:alert(1)> [vb](vbscript:msgbox(1))' };
    case 2:
      return { author: evil, content: "=SUM(1+1)*cmd|' /C calc'!A0" };
    case 3:
      return { author: evil, content: '+SUM(A1:A9)' };
    case 4:
      return { author: evil, content: "-2+3+cmd|' /C calc'!A0" };
    case 5:
      return { author: evil, content: '@SUM(1+1)*cmd' };
    case 6:
      return { author: evil, content: '\t=1+1 (starts with a tab)' };
    case 7:
      return { content: 'control characters: bell:\u0007 vt:\u000B unit-separator:\u001F end (invalid in XML 1.0)' };
    case 8:
      return { content: '"quoted","comma, separated"\nnewline inside a cell; semicolon; and a trailing backslash \\' };
    case 9:
      return { content: 'paths: ../../etc/passwd and C:\\Windows\\System32\\con and /dev/null and %TEMP%\\..\\x' };
    default:
      return { content: '\r\ncarriage-return line breaks\r\nand a lone \r in the middle' };
  }
}

function attachmentBuilder(c: BuildCtx): MessageParts {
  const ko = isKorean(c);
  switch (c.variant) {
    case 0:
      return {
        content: ko ? '스크린샷 올려요' : 'screenshot of the settings page',
        attachments: [imageAttachment(c, 0, 'screenshot-2026-09-12 at 14.03.png', 1280, 720, { description: 'Screenshot of the settings page' })],
      };
    case 1:
      return { content: '', attachments: [imageAttachment(c, 0, 'IMG_2048.jpg', 1080, 1920)] };
    case 2:
      return {
        content: ko ? '여행 사진들' : 'photos from the trip',
        attachments: [
          imageAttachment(c, 0, 'beach.jpg', 1920, 1080),
          imageAttachment(c, 1, 'dinner.png', 800, 800),
          imageAttachment(c, 2, 'tall-poster.png', 600, 1200),
          imageAttachment(c, 3, 'panorama.jpg', 3000, 2000),
        ],
      };
    case 3:
      return {
        content: ko ? '데모 영상입니다' : 'demo recording',
        attachments: [fileAttachment(c, 0, 'demo-recording.mp4', 12_345_678, { width: 1920, height: 1080, duration_secs: 34.2 })],
      };
    case 4:
      return { content: '', attachments: [fileAttachment(c, 0, 'voice-note.mp3', 2_345_678, { duration_secs: 142.5 })] };
    case 5: {
      const waveform = btoa(String.fromCharCode(...Array.from({ length: 48 }, () => c.rng.int(8, 255))));
      return {
        content: '',
        flags: MESSAGE_FLAGS.voiceMessage,
        attachments: [fileAttachment(c, 0, 'voice-message.ogg', 14_212, { duration_secs: 7.2, waveform })],
      };
    }
    case 6:
      return { content: ko ? '분기 보고서입니다' : 'quarterly report', attachments: [fileAttachment(c, 0, 'report-Q3.pdf', 2_345_678)] };
    case 7:
      return { content: 'source', attachments: [fileAttachment(c, 0, 'source-code.zip', 148_000_000)] };
    case 8:
      return { content: ko ? '스포일러 주의' : 'spoiler alert', attachments: [imageAttachment(c, 0, 'SPOILER_secret.png', 640, 480)] };
    case 9:
      return { content: '', attachments: [fileAttachment(c, 0, 'notes.txt', 312)] };
    case 10:
      return {
        content: ko ? '파일 모음' : 'files attached',
        attachments: [fileAttachment(c, 0, 'design-spec.pdf', 905_000), fileAttachment(c, 1, 'assets.zip', 52_000_000), imageAttachment(c, 2, 'mockup.png', 1440, 900)],
      };
    default:
      // Hostile file names: only the showcase asks for this variant (see `randomVariants`).
      return {
        content: 'odd file names',
        attachments: [
          fileAttachment(c, 0, 'CON.txt', 1024),
          fileAttachment(c, 1, '..\\..\\windows\\system32\\evil.exe.pdf', 4096),
          fileAttachment(c, 2, '이름 있는 파일 #1 (최종).pdf', 80_000),
          fileAttachment(c, 3, 'report <final> "v2".pdf', 80_000),
        ],
      };
  }
}

function embedBuilder(c: BuildCtx): MessageParts {
  const link = LINKS[c.index % LINKS.length];
  switch (c.variant) {
    case 0:
      return { content: `${link[0]} ← ${isKorean(c) ? '이거 읽어보세요' : 'worth a read'}`, embeds: [articleEmbed(c, link)] };
    case 1:
      return { content: '', embeds: [richEmbed(c)] };
    case 2:
      return { content: 'https://example.com/images/cat.png', embeds: [thumbnailImageEmbed(c)] };
    case 3:
      return {
        content: 'https://example.com/watch?v=abc123',
        embeds: [
          {
            type: 'video',
            url: 'https://example.com/watch?v=abc123',
            title: '10 minute intro to message queues',
            description: 'A short, visual explanation of queues, topics and consumers.',
            provider: { name: 'ExampleTube', url: 'https://example.com' },
            thumbnail: media(c, 1280, 720, 'video', true),
            video: { url: 'https://example.com/embed/abc123', width: 1280, height: 720 },
          },
        ],
      };
    case 4:
      return {
        content: 'https://example.com/gif/dancing-cat',
        embeds: [
          {
            type: 'gifv',
            url: 'https://example.com/gif/dancing-cat',
            provider: { name: 'ExampleGIF', url: 'https://example.com' },
            thumbnail: media(c, 498, 278, 'gif'),
            video: { url: 'https://example.com/media/dancing-cat.mp4', width: 498, height: 278 },
          },
        ],
      };
    case 5:
      return { content: '', embeds: [{ type: 'rich', title: 'Minimal embed', description: 'Only a title and a description, no colour.' }] };
    case 6:
      return {
        content: '',
        embeds: [
          {
            type: 'rich',
            color: 0x57f287,
            fields: [
              { name: 'Build', value: '#1482', inline: true },
              { name: 'Branch', value: '`main`', inline: true },
              { name: 'Result', value: '✅ passed', inline: true },
              { name: 'Duration', value: '3m 12s', inline: true },
            ],
            footer: { text: 'CI • footer without icon' },
          },
        ],
      };
    case 7:
      return { content: `${link[0]}`, embeds: [articleEmbed(c, link), richEmbed(c)] };
    default:
      return {
        content: 'https://example.org/plain-link',
        embeds: [{ type: 'link', url: 'https://example.org/plain-link', title: 'A link preview without any image', description: 'Text only.' }],
      };
  }
}

function mentionBuilder(c: BuildCtx): MessageParts {
  const pool = others(c);
  const u1 = c.rng.pick(pool);
  const u2 = c.rng.pick(pool.filter((u) => u.id !== u1.id).concat(c.me));
  const role = c.guild && c.guild.roleIds.length > 0 ? c.rng.pick(c.guild.roleIds) : undefined;
  const channel = c.guild && c.guild.channels.length > 0 ? c.rng.pick(c.guild.channels) : undefined;
  const ko = isKorean(c);

  // Roles, channels and @everyone only exist in guilds; DMs fall back to a plain user mention.
  if (c.variant >= 2 && role && channel) {
    switch (c.variant) {
      case 2:
        return { content: `<@&${role}> ${ko ? '배포 준비 부탁드립니다' : 'please prepare the deployment'}`, mention_roles: [role] };
      case 3:
        return { content: `${ko ? '정리해뒀어요:' : 'notes are in'} <#${channel.id}>` };
      case 4:
        return { content: `@everyone ${ko ? '서버 점검 안내입니다' : 'maintenance notice'}`, mention_everyone: true };
      case 5:
        return { content: `@here ${ko ? '지금 접속 중인 분들 투표 부탁드려요' : 'quick vote for everyone online'}`, mention_everyone: true };
      default:
        return {
          content: `<@${u1.id}> <@&${role}> @here ${ko ? '자세한 내용은' : 'details are in'} <#${channel.id}>`,
          mentions: [u1],
          mention_roles: [role],
          mention_everyone: true,
        };
    }
  }
  if (c.variant === 1) {
    return {
      content: `<@!${u1.id}> ${ko ? '그리고' : 'and'} <@${u2.id}> ${ko ? '두 분 다 봐주세요' : 'could you both take a look'}`,
      mentions: u1.id === u2.id ? [u1] : [u1, u2],
    };
  }
  return { content: `<@${u1.id}> ${ko ? '이거 확인 가능해요?' : 'can you check this?'}`, mentions: [u1] };
}

function emojiBuilder(c: BuildCtx): MessageParts {
  const [happy, , thumbs, , parrot, cat] = CUSTOM_EMOJIS;
  switch (c.variant) {
    case 0:
      return { content: `${isKorean(c) ? '이거 보세요' : 'look at this'} ${emojiMarkup(happy)} ${isKorean(c) ? '대박' : 'amazing'}` };
    case 1:
      return { content: `${pickText(c)} ${emojiMarkup(parrot)}` };
    case 2:
      return { content: emojiMarkup(happy) };
    case 3:
      return { content: '🎉🎉🎉' };
    case 4:
      return { content: `${emojiMarkup(thumbs)}${emojiMarkup(thumbs)} 🔥 ${emojiMarkup(parrot)}${emojiMarkup(cat)}` };
    default:
      return { content: ':tada: :fire: :unknown_emoji: (shortcodes stay plain text)' };
  }
}

function timestampBuilder(c: BuildCtx): MessageParts {
  const style = TIMESTAMP_STYLES[c.variant % TIMESTAMP_STYLES.length];
  const unix = UNIX(c.ts + c.rng.int(-2 * DAY, 10 * DAY));
  return { content: isKorean(c) ? `다음 회의는 <t:${unix}:${style}> 입니다.` : `The next meeting is <t:${unix}:${style}>.` };
}

function linkBuilder(c: BuildCtx): MessageParts {
  const link = LINKS[c.index % LINKS.length];
  switch (c.variant) {
    case 0:
      return { content: `${link[0]}`, embeds: [articleEmbed(c, link)] };
    case 1:
      return { content: `<${link[0]}> (embed suppressed)`, flags: MESSAGE_FLAGS.suppressEmbeds };
    case 2:
      return { content: '(see https://example.org/wiki/한글_(문자)?lang=ko&ref=a#역사), and also https://example.com/a?b=1&c=2#frag.' };
    default: {
      const second = LINKS[(c.index + 1) % LINKS.length];
      return { content: `${link[0]} ${second[0]}`, embeds: [articleEmbed(c, link), articleEmbed(c, second)] };
    }
  }
}

function stickerBuilder(c: BuildCtx): MessageParts {
  const stickers: StickerItem[] = [
    { id: keyId('sticker', 'wave'), name: 'wave', format_type: 1 },
    { id: keyId('sticker', 'lottie-cat'), name: '웃는 고양이', format_type: 3 },
    { id: keyId('sticker', 'dance-gif'), name: 'dance', format_type: 4 },
  ];
  return { content: c.variant === 1 ? pickShort(c) : '', sticker_items: [stickers[c.variant % stickers.length]] };
}

function replyBuilder(c: BuildCtx): MessageParts | undefined {
  const target = c.target;
  if (!target) return undefined;
  const flat: Message = { ...target };
  delete flat.referenced_message; // Discord does not nest replies deeper than one level
  const pings = target.author.id !== c.author.id && c.rng.chance(0.7);
  return {
    type: MessageType.Reply,
    content: c.rng.chance(0.3) ? pickShort(c) : pickText(c),
    message_reference: reference(c, target.id, 0),
    referenced_message: flat,
    mentions: pings ? [target.author] : [],
  };
}

function replyDeletedBuilder(c: BuildCtx): MessageParts {
  return {
    type: MessageType.Reply,
    content: pickText(c),
    message_reference: reference(c, syntheticId(c.ts - c.rng.int(HOUR, 3 * DAY), c.index), 0),
    referenced_message: null,
  };
}

function botBuilder(c: BuildCtx): MessageParts {
  const server = c.rng.pick(SERVER_NAMES);
  switch (c.variant) {
    case 0:
      return {
        author: HELPER_BOT,
        application_id: HELPER_BOT.id,
        content: '',
        embeds: [
          {
            type: 'rich',
            color: 0x57f287,
            title: '✅ 배포 완료 / Deployment finished',
            description: `\`${server}\` 가 버전 **v2.${c.rng.int(0, 9)}.${c.rng.int(0, 20)}** 로 배포되었습니다.`,
            fields: [
              { name: 'Region', value: c.rng.pick(['ap-northeast-2', 'eu-west-1', 'us-east-1']), inline: true },
              { name: 'Duration', value: `${c.rng.int(20, 200)}s`, inline: true },
            ],
            timestamp: isoOf(c.ts),
          },
        ],
      };
    case 1: {
      const interaction = { id: syntheticId(c.ts - 3 * SECOND, c.index), type: 2, name: 'status', user: c.author };
      return {
        author: HELPER_BOT,
        application_id: HELPER_BOT.id,
        type: MessageType.ChatInputCommand,
        content: `**${server}**: 🟢 online · ${c.rng.int(1, 99)} ms`,
        interaction,
        interaction_metadata: { id: interaction.id, type: 2, user: c.author },
      };
    }
    default:
      return {
        author: HELPER_BOT,
        application_id: HELPER_BOT.id,
        content: `⏰ <@${c.author.id}> 리마인더: 회의 10분 전입니다. / Reminder: meeting in 10 minutes.`,
        mentions: [c.author],
      };
  }
}

function webhookBuilder(c: BuildCtx): MessageParts {
  const base = { author: WEBHOOK_USER, webhook_id: WEBHOOK_USER.id };
  if (c.variant === 0) {
    return {
      ...base,
      content: '',
      embeds: [
        {
          type: 'rich',
          color: 0x5865f2,
          title: `Release v2.${c.rng.int(0, 9)}.0 published`,
          url: 'https://example.com/releases/latest',
          description: '- Faster exports\n- Fixed emoji rendering\n- **Breaking:** dropped Node 18',
          author: { name: 'example/demo-app', url: 'https://example.com', icon_url: WEBHOOK_USER.avatar ?? undefined },
          footer: { text: 'Release Notifier' },
          timestamp: isoOf(c.ts),
        },
      ],
    };
  }
  return { ...base, content: `🚨 **[ALERT]** \`${c.rng.pick(SERVER_NAMES)}\` error rate ${c.rng.int(21, 90) / 10}% > 2% (threshold)` };
}

function forwardBuilder(c: BuildCtx): MessageParts {
  const snapshot: MessageSnapshotMessage = {
    type: 0,
    content: c.variant === 0 ? pickText(c) : `${MARKDOWN_SAMPLES[1]}\n${pickText(c)}`,
    timestamp: isoOf(c.ts - c.rng.int(2 * HOUR, 20 * DAY)),
    edited_timestamp: null,
    attachments: c.variant === 0 ? [] : [imageAttachment(c, 0, 'forwarded-photo.png', 1024, 768)],
    embeds: c.variant === 0 ? [] : [articleEmbed(c, LINKS[0])],
    mentions: [],
    mention_roles: [],
  };
  const source = c.guild?.channels.find((ch) => ch.id !== c.channelId)?.id ?? keyId('channel', 'forward-source');
  return {
    content: '',
    flags: MESSAGE_FLAGS.hasSnapshot,
    message_reference: { type: 1, message_id: syntheticId(c.ts - 5 * DAY, c.index), channel_id: source, ...(c.guild ? { guild_id: c.guild.id } : {}) },
    message_snapshots: [{ message: snapshot }],
  };
}

function callBuilder(c: BuildCtx): MessageParts {
  const other = others(c)[0];
  switch (c.variant) {
    case 0:
      return { type: MessageType.Call, content: '', call: { participants: [c.author.id, other.id], ended_timestamp: isoOf(c.ts + c.rng.int(30 * SECOND, 45 * MINUTE)) } };
    case 1:
      return { type: MessageType.Call, content: '', call: { participants: [c.author.id], ended_timestamp: isoOf(c.ts + 28 * SECOND) } };
    default:
      return { type: MessageType.Call, content: '', call: { participants: [c.author.id, other.id], ended_timestamp: null } };
  }
}

export const KINDS: Record<KindName, KindDef> = {
  text: { variants: 1, build: (c) => ({ content: pickText(c) }) },
  short: { variants: 1, build: (c) => ({ content: pickShort(c) }) },
  long: {
    variants: 4,
    build: (c) => ({ content: [LONG_KO, LONG_EN, LONG_MIXED, nearLimitText(c.lang === 'en' ? EN_SENTENCES : KO_SENTENCES)][c.variant] }),
  },
  multilingual: { variants: MULTILINGUAL.length, build: (c) => ({ content: MULTILINGUAL[c.variant] }) },
  markdown: { variants: MARKDOWN_SAMPLES.length, build: (c) => ({ content: MARKDOWN_SAMPLES[c.variant] }) },
  mention: { variants: 7, build: mentionBuilder },
  emoji: { variants: 6, build: emojiBuilder },
  timestamp: { variants: TIMESTAMP_STYLES.length, build: timestampBuilder },
  link: { variants: 4, build: linkBuilder },
  hostile: { variants: 11, build: hostileBuilder },
  attachment: { variants: 12, randomVariants: 11, build: attachmentBuilder },
  embed: { variants: 9, build: embedBuilder },
  sticker: { variants: 3, build: stickerBuilder },
  reply: { variants: 1, build: replyBuilder },
  'reply-deleted': { variants: 1, build: replyDeletedBuilder },
  bot: { variants: 3, build: botBuilder },
  webhook: { variants: 2, build: webhookBuilder },
  poll: {
    variants: 3,
    build: (c) => ({
      content: '',
      poll: makePoll(c, { finalized: c.variant === 1, multi: c.variant === 2, emoji: c.variant !== 0 }),
    }),
  },
  forward: { variants: 2, build: forwardBuilder },
  'sys-join': { variants: 1, system: true, build: () => ({ type: MessageType.UserJoin, content: '' }) },
  'sys-pin': {
    variants: 1,
    system: true,
    build: (c) => (c.target ? { type: MessageType.ChannelPinnedMessage, content: '', message_reference: reference(c, c.target.id) } : undefined),
  },
  'sys-boost': { variants: 1, system: true, build: () => ({ type: MessageType.GuildBoost, content: '' }) },
  'sys-thread': {
    variants: 2,
    system: true,
    build: (c) => {
      if (c.threads.length === 0 || !c.guild) return undefined;
      const thread = c.threads[c.variant % c.threads.length];
      return { type: MessageType.ThreadCreated, content: thread.name ?? '', message_reference: { channel_id: thread.id, guild_id: c.guild.id } };
    },
  },
  'sys-call': { variants: 3, system: true, build: callBuilder },
  'sys-recipient-add': {
    variants: 1,
    system: true,
    build: (c) => ({ type: MessageType.RecipientAdd, content: '', mentions: [c.rng.pick(others(c))] }),
  },
  'sys-recipient-remove': {
    variants: 1,
    system: true,
    build: (c) => ({ type: MessageType.RecipientRemove, content: '', mentions: [c.rng.pick(others(c))] }),
  },
  'sys-name-change': { variants: 1, system: true, build: (c) => ({ type: MessageType.ChannelNameChange, content: c.rng.pick(GROUP_NAMES) }) },
  'sys-icon-change': { variants: 1, system: true, build: () => ({ type: MessageType.ChannelIconChange, content: '' }) },
};
