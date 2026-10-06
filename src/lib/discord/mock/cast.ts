import type { User } from '../types';
import { keyId, userId } from './ids';
import { avatarDataUri } from './svg';

interface PersonSpec {
  key: string;
  username: string;
  /** Display name; null => the UI falls back to the username. */
  name: string | null;
  /** Legacy 4-digit discriminator (affects the default avatar). */
  discriminator?: string;
  /** false => `avatar: null` (default avatar fallback). */
  avatar: boolean;
  bot?: boolean;
}

const SPECS: readonly PersonSpec[] = [
  { key: 'me', username: 'demo_user', name: '데모 사용자', avatar: true },
  // Korean names
  { key: 'minjun', username: 'minjun_kim', name: '김민준', avatar: true },
  { key: 'seoyeon', username: 'seoyeon.lee', name: '이서연', avatar: true },
  { key: 'jiho', username: 'jiho_park', name: '박지호', avatar: true },
  { key: 'sua', username: 'suachoi', name: '최수아', avatar: true },
  { key: 'woojin', username: 'woojin', name: '정우진', avatar: true },
  { key: 'haeun', username: 'haeun_k', name: '강하은', avatar: false },
  { key: 'dohyun', username: 'dohyun99', name: '윤도현', avatar: true },
  { key: 'yerin', username: 'yerin', name: '장예린', avatar: true },
  { key: 'jiwoo', username: 'jiwoo_han', name: '한지우', avatar: false },
  { key: 'sehun', username: 'sehun', name: '오세훈', avatar: true },
  // English names
  { key: 'alex', username: 'alex_r', name: 'Alex Rivera', avatar: true },
  { key: 'sam', username: 'sampatel', name: 'Sam Patel', avatar: true },
  { key: 'jordan', username: 'jordan.lee', name: 'Jordan Lee', avatar: true },
  { key: 'taylor', username: 'taylorb', name: 'Taylor Brooks', avatar: false },
  { key: 'morgan', username: 'morgan_chen', name: 'Morgan Chen', avatar: true },
  { key: 'casey', username: 'caseyn', name: 'Casey Nguyen', avatar: true },
  { key: 'riley', username: 'riley', name: "Riley O'Connor", avatar: true },
  // Awkward display names
  { key: 'pizza', username: 'pizzalord', name: '🍕 Pizza Lord', avatar: true },
  { key: 'mina', username: 'mina_jp', name: 'ミナ (Mina)', avatar: true },
  { key: 'ahmad', username: 'ahmad_dev', name: 'أحمد', avatar: true },
  { key: 'muller', username: 'muller_sohne', name: 'Müller & Söhne <3', avatar: true },
  { key: 'legacy', username: 'legacy_user', name: null, discriminator: '4821', avatar: false },
  { key: 'evil', username: 'evil_user', name: '=HYPERLINK("https://evil.example","click")', avatar: true },
  {
    key: 'long',
    username: 'a_very_long_username_that_keeps_going',
    name: 'A Really Remarkably Long Display Name That Will Overflow Narrow Layouts',
    avatar: true,
  },
  // Friends that only exist as DM partners
  { key: 'hajun', username: 'hajun_kim', name: '김하준', avatar: true },
  { key: 'doyun', username: 'doyun.lee', name: '이도윤', avatar: false },
  { key: 'seojun', username: 'seojun_p', name: '박서준', avatar: true },
  { key: 'emma', username: 'emma_wilson', name: 'Emma Wilson', avatar: true },
  { key: 'noah', username: 'noahsmith', name: 'Noah Smith', avatar: false },
  { key: 'olivia', username: 'olivia.b', name: 'Olivia Brown', avatar: true },
  { key: 'liam', username: 'liamj', name: 'Liam Johnson', avatar: false },
  // Bots
  { key: 'helperbot', username: 'HelperBot', name: null, discriminator: '0', avatar: true, bot: true },
];

const BY_KEY = new Map<string, User>();

for (const spec of SPECS) {
  const user: User = {
    id: userId(spec.key),
    username: spec.username,
    discriminator: spec.discriminator ?? '0',
    global_name: spec.name,
    avatar: spec.avatar ? avatarDataUri(spec.name ?? spec.username, spec.key) : null,
  };
  if (spec.bot) user.bot = true;
  BY_KEY.set(spec.key, user);
}

/** Looks a cast member up by key; a typo is a programming error and throws. */
export function person(key: string): User {
  const user = BY_KEY.get(key);
  if (!user) throw new Error(`mock: unknown person "${key}"`);
  return user;
}

export const MOCK_ME: User = person('me');
export const HELPER_BOT: User = person('helperbot');

/** Author of webhook messages: webhook ids double as the (bot) user id, like on Discord. */
export const WEBHOOK_USER: User = {
  id: keyId('webhook', 'release-notifier'),
  username: 'Release Notifier',
  discriminator: '0000',
  global_name: null,
  avatar: avatarDataUri('Release Notifier', 'release-notifier'),
  bot: true,
};

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

export function prefersKorean(user: User): boolean {
  return HANGUL.test(user.global_name ?? user.username);
}

export interface CustomEmoji {
  id: string;
  name: string;
  animated: boolean;
}

function emoji(name: string, animated = false): CustomEmoji {
  return { id: keyId('emoji', name), name, animated };
}

export const CUSTOM_EMOJIS: readonly CustomEmoji[] = [
  emoji('pepe_happy'),
  emoji('pepe_sad'),
  emoji('thumbs_up_custom'),
  emoji('eyes_shaking'),
  emoji('party_parrot', true),
  emoji('cat_dance', true),
];

export function emojiMarkup(e: CustomEmoji): string {
  return `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`;
}
