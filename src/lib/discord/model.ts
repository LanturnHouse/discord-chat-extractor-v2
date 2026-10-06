import type { Snowflake } from './types';

/**
 * App-level view models. The UI and the export engine work with these (+ raw `Message`s),
 * never with raw `Channel` objects. Built by `tree.ts` from API responses.
 */

export type ChannelKind =
  | 'text'
  | 'announcement'
  | 'voice' // voice channels have a text chat too
  | 'stage'
  | 'forum' // container of posts (threads); has no messages itself
  | 'media' // like forum
  | 'thread' // thread / forum post / announcement thread
  | 'category'
  | 'dm'
  | 'group-dm'
  | 'other';

/** Kinds whose messages can be read & exported. */
export const READABLE_KINDS: ReadonlySet<ChannelKind> = new Set<ChannelKind>([
  'text',
  'announcement',
  'voice',
  'stage',
  'thread',
  'dm',
  'group-dm',
]);

export interface GuildNode {
  id: Snowflake;
  name: string;
  /** Ready-to-use CDN URL (already sized) or null => render the acronym fallback. */
  iconUrl: string | null;
  owner: boolean;
}

export interface ChannelNode {
  id: Snowflake;
  guildId: Snowflake | null;
  kind: ChannelKind;
  name: string;
  /** Category id (for channels) or parent channel id (for threads). */
  parentId: Snowflake | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  /** Best-effort result of permission computation: true = can read, false = hidden/no access, null = unknown. */
  canView: boolean | null;
  /** Threads only: archived flag (we only list active ones, so normally false). */
  archived?: boolean;
}

export interface CategoryNode {
  /** Category channel id. */
  id: Snowflake;
  name: string;
  position: number;
  channels: ChannelNode[]; // sorted exactly like Discord's sidebar
}

export interface GuildTree {
  guildId: Snowflake;
  /** Channels without a category (Discord shows them above all categories). */
  uncategorized: ChannelNode[];
  categories: CategoryNode[];
  /** threads/forum posts keyed by parent channel id, newest activity first. */
  threadsByParent: Record<Snowflake, ChannelNode[]>;
  /** Flat id -> node lookup for every non-category channel and thread. */
  byId: Record<Snowflake, ChannelNode>;
}

export interface DmRecipient {
  id: Snowflake;
  name: string; // global_name ?? username
  username: string;
  avatarUrl: string; // always resolvable (default avatar fallback)
}

export interface DmNode {
  id: Snowflake;
  kind: 'dm' | 'group-dm';
  /** 1:1 => the friend's display name; group => custom name or joined recipient names. */
  name: string;
  /** Friend avatar / group icon (default avatar fallback). */
  iconUrl: string;
  recipients: DmRecipient[];
  lastMessageId: Snowflake | null;
}
