import type { Channel, Message, Snowflake, User } from '../types';

/** Language of a channel's conversation: picks the sentence pool. */
export type Lang = 'ko' | 'en' | 'mixed';

/** Kind of conversation: decides which message kinds occur and how often (see plan.ts). */
export type Flavour =
  | 'general'
  | 'plain'
  | 'chatty'
  | 'announce'
  | 'code'
  | 'bots'
  | 'memes'
  | 'music'
  | 'photos'
  | 'welcome'
  | 'intro'
  | 'voicechat'
  | 'thread'
  | 'dm'
  | 'group-dm'
  | 'showcase';

export type KindName =
  | 'text'
  | 'short'
  | 'long'
  | 'multilingual'
  | 'markdown'
  | 'mention'
  | 'emoji'
  | 'timestamp'
  | 'link'
  | 'hostile'
  | 'attachment'
  | 'embed'
  | 'sticker'
  | 'reply'
  | 'reply-deleted'
  | 'bot'
  | 'webhook'
  | 'poll'
  | 'forward'
  | 'sys-join'
  | 'sys-pin'
  | 'sys-boost'
  | 'sys-thread'
  | 'sys-call'
  | 'sys-recipient-add'
  | 'sys-recipient-remove'
  | 'sys-name-change'
  | 'sys-icon-change';

/** What kinds of mentions / links a guild channel can use. */
export interface GuildCtx {
  id: Snowflake;
  /** Roles worth mentioning (not @everyone). */
  roleIds: readonly Snowflake[];
  /** Text channels the current user can open (targets for `<#id>`). */
  channels: readonly { id: Snowflake; name: string }[];
}

/** One hand-written message of a scripted channel (the showcase). */
export interface ScriptEntry {
  kind: KindName;
  variant?: number;
  /** Cast key of the author; default: picked from the channel's author pool. */
  author?: string;
  /** Exact gap to the previous message (ms). Not stretched when the timeline is fitted to the channel's span. */
  gapBeforeMs?: number;
  edited?: boolean;
  reactions?: boolean;
}

/** Everything needed to (re)generate one channel's history. */
export interface MessageProfile {
  /** Seed namespace; unique per channel. */
  seedKey: string;
  channelId: Snowflake;
  guild: GuildCtx | null;
  flavour: Flavour;
  lang: Lang;
  count: number;
  /** Timestamp of the newest message. */
  endMs: number;
  /** Time between the oldest and the newest message. */
  spanMs: number;
  /** Gap before message `index` in ms, keyed by index. */
  pinnedGaps: Readonly<Record<number, number>>;
  /** Posters ordered by how often they write (most active first). */
  authors: readonly User[];
  /** Hand-written messages; when set, `count` equals its length. */
  script: readonly ScriptEntry[] | null;
  /** Threads whose parent is this channel (targets of "thread created" messages). */
  threads: readonly Channel[];
  /** Forced kind of the first message (thread starters). */
  firstKind?: KindName;
  /** Group DM (recipient events). */
  group: boolean;
}

export type MessageParts = Partial<
  Pick<
    Message,
    | 'author'
    | 'content'
    | 'type'
    | 'attachments'
    | 'embeds'
    | 'mentions'
    | 'mention_roles'
    | 'mention_everyone'
    | 'sticker_items'
    | 'poll'
    | 'message_snapshots'
    | 'message_reference'
    | 'referenced_message'
    | 'flags'
    | 'webhook_id'
    | 'application_id'
    | 'interaction'
    | 'interaction_metadata'
    | 'thread'
    | 'call'
    | 'reactions'
    | 'edited_timestamp'
  >
>;
