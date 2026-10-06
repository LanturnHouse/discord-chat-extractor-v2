import type { Message, Snowflake, User } from '../discord/types';
import type { NameResolver } from '../markdown/types';
import { nonEmpty } from './text';

/** `global_name` (the display name) when it has visible text, else the account username. */
export function displayName(user: User): string {
  const global = nonEmpty(user?.global_name);
  if (global !== null) return global.trim();
  return typeof user?.username === 'string' ? user.username : '';
}

export interface MessageNameResolver extends NameResolver {
  /** Learns user names from authors and mentions (also inside replies, forward snapshots and interactions) and channel names from `mention_channels`. */
  addMessages(msgs: readonly Message[]): void;
  /** Replaces the explicitly known channel names (the channel tree of the open server). */
  setChannels(map: Record<string, string>): void;
  /** Replaces the known role names. */
  setRoles(map: Record<string, string>): void;
}

export interface NameResolverInit {
  channels?: Record<string, string>;
  roles?: Record<string, string>;
  users?: Record<string, string>;
}

/**
 * Maps use `Map`, never plain objects, so ids like "__proto__" or "constructor" cannot collide with
 * Object.prototype members.
 */
function toMap(record: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (record) {
    for (const [id, name] of Object.entries(record)) if (typeof name === 'string') map.set(id, name);
  }
  return map;
}

export function buildNameResolver(init: NameResolverInit = {}): MessageNameResolver {
  const users = toMap(init.users);
  let channels = toMap(init.channels);
  let roles = toMap(init.roles);
  // Names seen only through `mention_channels`; the channel tree (setChannels) always wins over them.
  const learnedChannels = new Map<string, string>();

  const learnUser = (user: User | null | undefined): void => {
    if (!user || typeof user.id !== 'string') return;
    const name = displayName(user);
    if (name) users.set(user.id, name);
  };

  const learnUsers = (list: readonly User[] | undefined): void => {
    if (!Array.isArray(list)) return;
    for (const user of list) learnUser(user);
  };

  const learnMessage = (msg: Message | null | undefined, depth: number): void => {
    if (!msg || typeof msg !== 'object') return;
    learnUser(msg.author);
    learnUsers(msg.mentions);
    learnUser(msg.interaction?.user);
    learnUser(msg.interaction_metadata?.user);
    if (Array.isArray(msg.mention_channels)) {
      for (const ch of msg.mention_channels) {
        if (ch && typeof ch.id === 'string' && typeof ch.name === 'string') learnedChannels.set(ch.id, ch.name);
      }
    }
    if (Array.isArray(msg.message_snapshots)) {
      for (const snap of msg.message_snapshots) learnUsers(snap?.message?.mentions);
    }
    // One level is enough: a referenced message's own reference is not delivered by the API.
    if (depth < 1) learnMessage(msg.referenced_message, depth + 1);
  };

  return {
    user: (id: Snowflake) => users.get(id),
    channel: (id: Snowflake) => channels.get(id) ?? learnedChannels.get(id),
    role: (id: Snowflake) => roles.get(id),
    addMessages(msgs) {
      for (const msg of msgs) learnMessage(msg, 0);
    },
    setChannels(map) {
      channels = toMap(map);
    },
    setRoles(map) {
      roles = toMap(map);
    },
  };
}
