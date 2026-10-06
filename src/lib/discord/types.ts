/**
 * Raw Discord API shapes (only the fields this project uses).
 * Snowflakes are ALWAYS strings. Never convert them to `number` (precision loss) — use `snowflake.ts` (BigInt) helpers.
 * Everything optional/nullable here really can be missing in API responses; never assume presence.
 */

export type Snowflake = string;

export const ChannelType = {
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildDirectory: 14,
  GuildForum: 15,
  GuildMedia: 16,
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType] | (number & {});

export const MessageType = {
  Default: 0,
  RecipientAdd: 1,
  RecipientRemove: 2,
  Call: 3,
  ChannelNameChange: 4,
  ChannelIconChange: 5,
  ChannelPinnedMessage: 6,
  UserJoin: 7,
  GuildBoost: 8,
  GuildBoostTier1: 9,
  GuildBoostTier2: 10,
  GuildBoostTier3: 11,
  ChannelFollowAdd: 12,
  GuildDiscoveryDisqualified: 14,
  GuildDiscoveryRequalified: 15,
  ThreadCreated: 18,
  Reply: 19,
  ChatInputCommand: 20,
  ThreadStarterMessage: 21,
  GuildInviteReminder: 22,
  ContextMenuCommand: 23,
  AutoModerationAction: 24,
  RoleSubscriptionPurchase: 25,
  InteractionPremiumUpsell: 26,
  StageStart: 27,
  StageEnd: 28,
  StageSpeaker: 29,
  StageTopic: 31,
  GuildApplicationPremiumSubscription: 32,
  PurchaseNotification: 44,
  PollResult: 46,
} as const;

export interface User {
  id: Snowflake;
  username: string;
  discriminator?: string; // "0" for migrated usernames
  global_name?: string | null; // display name
  avatar?: string | null; // hash
  bot?: boolean;
  system?: boolean;
}

/** `GET /users/@me/guilds` item. */
export interface GuildSummary {
  id: Snowflake;
  name: string;
  icon: string | null; // hash
  owner?: boolean;
  /** Permission bitfield of the current user in the guild (base permissions, no channel overwrites), decimal string. */
  permissions?: string;
  features?: string[];
}

export interface Role {
  id: Snowflake;
  name: string;
  /** Permission bitfield, decimal string. */
  permissions: string;
  position: number;
  color?: number;
}

export interface PermissionOverwrite {
  id: Snowflake; // role id or user id
  type: 0 | 1; // 0 = role, 1 = member
  allow: string; // bitfield, decimal string
  deny: string;
}

export interface ThreadMetadata {
  archived?: boolean;
  locked?: boolean;
  archive_timestamp?: string;
}

export interface Channel {
  id: Snowflake;
  type: ChannelType;
  guild_id?: Snowflake;
  name?: string | null; // null for 1:1 DMs and unnamed group DMs
  parent_id?: Snowflake | null; // category for channels, parent channel for threads
  position?: number;
  topic?: string | null;
  nsfw?: boolean;
  last_message_id?: Snowflake | null;
  permission_overwrites?: PermissionOverwrite[];
  /** DM / group DM only. */
  recipients?: User[];
  /** Group DM icon hash. */
  icon?: string | null;
  owner_id?: Snowflake;
  thread_metadata?: ThreadMetadata;
  message_count?: number;
}

export interface Attachment {
  id: Snowflake;
  filename: string;
  title?: string;
  description?: string;
  content_type?: string;
  size: number;
  url: string; // signed CDN url (expires!)
  proxy_url?: string;
  width?: number | null;
  height?: number | null;
  duration_secs?: number;
  waveform?: string;
  flags?: number;
}

export interface EmbedMedia {
  url?: string;
  proxy_url?: string;
  width?: number;
  height?: number;
}

export interface Embed {
  type?: string; // rich | image | video | gifv | article | link ...
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string; proxy_icon_url?: string };
  image?: EmbedMedia;
  thumbnail?: EmbedMedia;
  video?: EmbedMedia;
  provider?: { name?: string; url?: string };
  author?: { name: string; url?: string; icon_url?: string; proxy_icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface PartialEmoji {
  id: Snowflake | null; // null => unicode emoji
  name: string | null; // unicode char(s) or custom emoji name
  animated?: boolean;
}

export interface Reaction {
  count: number;
  me?: boolean;
  emoji: PartialEmoji;
}

export interface StickerItem {
  id: Snowflake;
  name: string;
  /** 1 PNG, 2 APNG, 3 LOTTIE, 4 GIF */
  format_type: number;
}

export interface MessageReference {
  type?: number; // 0 = default (reply), 1 = forward
  message_id?: Snowflake;
  channel_id?: Snowflake;
  guild_id?: Snowflake;
}

export interface PollAnswer {
  answer_id: number;
  poll_media: { text?: string; emoji?: PartialEmoji };
}

export interface Poll {
  question: { text?: string };
  answers: PollAnswer[];
  expiry?: string | null;
  allow_multiselect?: boolean;
  results?: { is_finalized: boolean; answer_counts: { id: number; count: number; me_voted?: boolean }[] };
}

/** Subset of a message that appears inside a forwarded message snapshot. */
export interface MessageSnapshotMessage {
  type?: number;
  content: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  attachments?: Attachment[];
  embeds?: Embed[];
  mentions?: User[];
  mention_roles?: Snowflake[];
  sticker_items?: StickerItem[];
}

export interface Message {
  id: Snowflake;
  channel_id: Snowflake;
  author: User;
  content: string;
  timestamp: string; // ISO8601
  edited_timestamp: string | null;
  tts?: boolean;
  mention_everyone?: boolean;
  mentions: User[];
  mention_roles: Snowflake[];
  mention_channels?: { id: Snowflake; guild_id: Snowflake; type: ChannelType; name: string }[];
  attachments: Attachment[];
  embeds: Embed[];
  reactions?: Reaction[];
  pinned?: boolean;
  type: number; // MessageType
  flags?: number;
  message_reference?: MessageReference;
  /** Present for replies. `null`/absent => original deleted or not loaded. */
  referenced_message?: Message | null;
  sticker_items?: StickerItem[];
  webhook_id?: Snowflake;
  application_id?: Snowflake;
  interaction?: { id: Snowflake; type: number; name: string; user: User };
  interaction_metadata?: { id: Snowflake; type: number; user: User };
  thread?: Channel;
  poll?: Poll;
  message_snapshots?: { message: MessageSnapshotMessage }[];
  call?: { participants: Snowflake[]; ended_timestamp?: string | null };
}
