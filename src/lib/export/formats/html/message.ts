import { dateTimeAttr, headerTimestamp } from './format';
import { MSG_ICON_PATHS, type MsgIconName } from './iconPaths';
import { getMessageLabels, type MessageLabels } from './labels';
import { EXTERNAL_LINK } from './links';
import { objectsOf } from './list';
import { fitBox, MEDIA_MAX_HEIGHT, MEDIA_MAX_WIDTH, type Size } from './media';
import { avatarUrl } from '../../../discord/cdn';
import type { Attachment, Embed, Message, Poll, Reaction, StickerItem, User } from '../../../discord/types';
import { isEmojiOnly, parseMarkdown } from '../../../markdown/parse';
import { escapeHtml, renderHtml } from '../../../markdown/renderHtml';
import type { MarkdownContext, NameResolver } from '../../../markdown/types';
import { isDiscordMediaUrl, safeMediaUrl, safeUrl } from '../../../markdown/url';
import {
  attachmentMediaUrl,
  classifyAttachment,
  displayName,
  forwardView,
  formatBytes,
  formatClock,
  formatDayLabel,
  formatFullTooltip,
  getStrings,
  isSameDay,
  isSpoilerAttachment,
  isSystemMessage,
  normalizeEmbed,
  pollView,
  reactionView,
  referenceView,
  shouldGroupWithPrevious,
  stickerView,
  systemMessageText,
  type EmbedMediaView,
  type ForwardSnapshotView,
  type MessageStrings,
  type NormalizedEmbed,
  type ReferenceView,
} from '../../../message';
import type { WriterContext } from '../../types';
import { localHref, localPathOf, markdownContext } from '../parts';
import { cleanText, oneLine, type ExportLocale } from '../text';

/**
 * One message of the HTML export, as markup string. The DOM and class names are the contract documented at the top of
 * message.css (the stylesheet shipped inside the export); tests/lib/export/formats/html.test.ts pins it.
 *
 * Everything that comes from Discord is attacker-controlled. Text goes through `escapeHtml`, single-line fields through
 * `oneLine` first, links through `safeUrl`, and media is only ever loaded from Discord's hosts (or an inline data:
 * image). Differences to the React view, all because the file has no script: spoiler media is revealed by :hover /
 * :focus-within instead of a click, and a picture that cannot be loaded (expired CDN link) stays a broken picture.
 */

export interface HtmlEnv {
  locale: ExportLocale;
  /** A valid IANA zone (see `resolveTimeZone`). */
  timeZone: string;
  md: MarkdownContext;
  labels: MessageLabels;
  strings: MessageStrings;
  /** Attachment id -> path of the saved copy, relative to the file (see `WriterOptions.attachmentPaths`). */
  paths: ReadonlyMap<string, string> | undefined;
}

/**
 * The renderer writes resolved names (mention chips) as they are given; the names are other people's user names,
 * so control and bidi-override characters have to go before they reach it.
 */
function singleLineNames(names: NameResolver): NameResolver {
  const clean = (name: string | undefined): string | undefined => (name === undefined ? undefined : oneLine(name) || undefined);
  return { user: (id) => clean(names.user(id)), channel: (id) => clean(names.channel(id)), role: (id) => clean(names.role(id)) };
}

export function createHtmlEnv(ctx: WriterContext): HtmlEnv {
  // An unexpected locale value falls back to English everywhere, the markdown renderer included.
  const locale: ExportLocale = ctx.options.locale === 'ko' ? 'ko' : 'en';
  const md: MarkdownContext = { ...markdownContext(ctx), locale, names: singleLineNames(ctx.names) };
  return { locale, timeZone: md.timeZone, md, labels: getMessageLabels(locale), strings: getStrings(locale), paths: ctx.options.attachmentPaths };
}

const e = escapeHtml;

/** Escaped single-line text. */
const line = (value: unknown): string => e(oneLine(value));

/** ` name="value"`, or nothing when there is no value. */
const attr = (name: string, value: string | number | undefined): string => (value === undefined ? '' : ` ${name}="${e(String(value))}"`);

const EXTERNAL = ` target="${EXTERNAL_LINK.target}" rel="${EXTERNAL_LINK.rel}"`;

const sizeAttrs = (box: Size | null): string => (box === null ? '' : ` width="${box.width}" height="${box.height}"`);

// ---------------------------------------------------------------------------------------------------------------------
// what may be loaded
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The export's CSP is `img-src https: data:`, so a plain-http URL would only show a broken picture; Discord serves
 * everything over https, which makes an http URL on its hosts a sign of something unusual anyway.
 */
export function loadableImage(url: string | null | undefined): string | null {
  const src = safeMediaUrl(url);
  return src !== null && (src.startsWith('https:') || src.startsWith('data:')) ? src : null;
}

/** Video and audio (`media-src https:`): https on a Discord host only; an inline data: URL is never a player source. */
export function loadableMedia(url: string | null | undefined): string | null {
  const src = safeUrl(url);
  return src !== null && src.startsWith('https:') && isDiscordMediaUrl(src) ? src : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// small pieces
// ---------------------------------------------------------------------------------------------------------------------

function iconSvg(name: MsgIconName, size: number, className?: string): string {
  const cls = className === undefined ? 'msg-icon' : `msg-icon ${className}`;
  return (
    `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<path fill="currentColor" fill-rule="evenodd" d="${MSG_ICON_PATHS[name]}"/></svg>`
  );
}

function timeHtml(className: string | null, iso: string, text: string, env: HtmlEnv): string {
  const cls = className === null ? '' : ` class="${className}"`;
  return `<time${cls}${attr('datetime', dateTimeAttr(iso))}${attr('title', formatFullTooltip(iso, env.timeZone, env.locale) || undefined)}>${e(text)}</time>`;
}

const messageIdAttr = (message: Message): string => (typeof message.id === 'string' ? attr('data-message-id', message.id) : '');

/** Discord markdown as a `div.md-root`; a message made only of emoji gets jumbo emoji, as in the app. */
function markdownHtml(content: string, env: HtmlEnv): string {
  const nodes = parseMarkdown(cleanText(content));
  return `<div class="md-root">${renderHtml(nodes, env.md, { jumbo: isEmojiOnly(nodes) })}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// avatar
// ---------------------------------------------------------------------------------------------------------------------

/** Number of colours of the fallback circle (the same palette size as Discord's default avatars). */
const TONES = 6;

function toneOf(id: unknown): number {
  const text = typeof id === 'string' ? id : '';
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) sum = (sum + text.charCodeAt(i)) % TONES;
  return sum;
}

function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? '?' : first.toUpperCase();
}

function avatarSrc(user: User, pixels: number): string | null {
  try {
    return loadableImage(avatarUrl(user, pixels));
  } catch {
    // The default avatar index is derived from the id with BigInt, which throws for ids that are not numeric.
    return null;
  }
}

/** Round avatar; without a loadable image a coloured circle with the initial of the display name. */
function avatarHtml(user: User, size: number, className: string): string {
  const src = avatarSrc(user, size * 2);
  if (src !== null) {
    return `<img class="${className}" src="${e(src)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async">`;
  }
  return `<span class="${className} msg-avatar-fallback msg-avatar-fallback--${toneOf(user?.id)}" aria-hidden="true">${e(initialOf(oneLine(displayName(user))))}</span>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// reply / forward header
// ---------------------------------------------------------------------------------------------------------------------

function referenceHtml(reference: ReferenceView, env: HtmlEnv): string {
  const { labels } = env;
  if (reference.kind === 'forward') {
    return `<div class="msg-forward-label">${iconSvg('forward', 14, 'msg-forward-label__icon')}<span>${e(labels.forwarded)}</span></div>`;
  }
  const { author, preview, deleted } = reference;
  const name = author === null ? null : oneLine(displayName(author)) || env.strings.unknownUser;
  let html = `<div class="${deleted ? 'msg-reply msg-reply--deleted' : 'msg-reply'}">`;
  if (author !== null) html += avatarHtml(author, 16, 'msg-reply__avatar');
  if (name !== null) {
    html += `<span class="msg-reply__name" dir="auto"><span class="msg-sr-only">${e(labels.replyingTo)} </span>@${e(name)}</span>`;
  }
  if (preview !== '') html += `<span class="msg-reply__text" dir="auto">${line(preview)}</span>`;
  return `${html}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------------------------------------------------

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

const nameOf = (attachment: Attachment, labels: MessageLabels): string => oneLine(textOf(attachment.filename)) || labels.unnamedFile;

/** A plain link target for the reader to click; unlike the media URL it may point at any http(s) host. */
const linkOf = (attachment: Attachment): string | null => safeUrl(textOf(attachment.url)) ?? safeUrl(textOf(attachment.proxy_url));

/**
 * The saved copy of an attachment as a URL reference relative to the file (percent-encoded), or null when the export did not
 * save one. A copy is a file next to the document: it is used for `src` and `href` in place of the CDN, and it is never subject
 * to the "Discord host only" rule of `loadableImage` / `loadableMedia` (the path comes from the exporter, not from a message).
 */
const localOf = (attachment: Attachment, env: HtmlEnv): string | null => localHref(localPathOf(attachment, env.paths));

/**
 * Cover of a spoiler picture or video. There is no script to toggle anything, so the frame reveals its content while
 * it is hovered or contains focus (see the `.msg-attachment--spoiler` rules in htmlCss.ts); `tabindex` makes the
 * cover focusable, which also covers taps on touch screens.
 */
function spoilerCover(labels: MessageLabels): string {
  return `<span class="msg-spoiler-cover" tabindex="0"${attr('title', labels.spoilerReveal)}><span class="msg-spoiler-cover__badge">${e(labels.spoilerBadge)}</span></span>`;
}

function mediaFrame(kind: 'image' | 'video', spoiler: boolean, inner: string, labels: MessageLabels): string {
  const state = spoiler ? ' msg-attachment--spoiler' : '';
  return `<div class="msg-attachment msg-attachment--${kind}${state}">${inner}${spoiler ? spoilerCover(labels) : ''}</div>`;
}

function fileHtml(attachment: Attachment, env: HtmlEnv, audioSrc?: string): string {
  const name = nameOf(attachment, env.labels);
  const href = localOf(attachment, env) ?? linkOf(attachment);
  const variant = audioSrc === undefined ? 'file' : 'audio';
  const title =
    href === null
      ? `<span class="msg-file__name" dir="auto">${e(name)}</span>`
      : `<a class="msg-file__name" dir="auto" href="${e(href)}"${EXTERNAL}>${e(name)}</a>`;
  const player =
    audioSrc === undefined ? '' : `<audio class="msg-audio" src="${e(audioSrc)}" controls preload="none"${attr('aria-label', name)}></audio>`;
  return (
    `<div class="msg-attachment msg-attachment--${variant} msg-file">${iconSvg(variant, 32, 'msg-file__icon')}` +
    `<div class="msg-file__info">${title}<div class="msg-file__size">${e(formatBytes(attachment.size, env.locale))}</div>${player}</div></div>`
  );
}

function imageHtml(attachment: Attachment, src: string, env: HtmlEnv): string {
  const { labels } = env;
  const spoiler = isSpoilerAttachment(attachment);
  const name = nameOf(attachment, labels);
  // The description of a spoiler could give the secret away, and nothing can swap it in later.
  const alt = spoiler ? '' : oneLine(textOf(attachment.description)) || name;
  const href = localOf(attachment, env) ?? linkOf(attachment);
  const image = `<img class="msg-image" src="${e(src)}" alt="${e(alt)}"${sizeAttrs(fitBox(attachment.width, attachment.height))} loading="lazy" decoding="async">`;
  const picture = href === null ? image : `<a class="msg-image-link" href="${e(href)}"${attr('title', labels.openOriginal)}${EXTERNAL}>${image}</a>`;
  return mediaFrame('image', spoiler, picture, labels);
}

function videoHtml(attachment: Attachment, src: string, env: HtmlEnv): string {
  const { labels } = env;
  const video =
    `<video class="msg-video" src="${e(src)}" controls preload="none" playsinline` +
    `${sizeAttrs(fitBox(attachment.width, attachment.height))}${attr('aria-label', nameOf(attachment, labels))}></video>`;
  return mediaFrame('video', isSpoilerAttachment(attachment), video, labels);
}

function attachmentHtml(attachment: Attachment, env: HtmlEnv): string {
  const kind = classifyAttachment(attachment);
  // A saved copy is shown from the file's own folder. Otherwise: automatic loading (img / video / audio) only from Discord's
  // own hosts; anything else is a plain link card.
  const local = localOf(attachment, env);
  const source = attachmentMediaUrl(attachment);
  if (kind === 'image') {
    const src = local ?? loadableImage(source);
    if (src !== null) return imageHtml(attachment, src, env);
  } else if (kind === 'video' || kind === 'audio') {
    const src = local ?? loadableMedia(source);
    if (src !== null) return kind === 'video' ? videoHtml(attachment, src, env) : fileHtml(attachment, env, src);
  }
  return fileHtml(attachment, env);
}

function attachmentsHtml(attachments: readonly Attachment[] | undefined, env: HtmlEnv): string {
  const items = objectsOf(attachments);
  if (items.length === 0) return '';
  let html = '<div class="msg-attachments">';
  for (const attachment of items) html += attachmentHtml(attachment, env);
  return `${html}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// embeds
// ---------------------------------------------------------------------------------------------------------------------

/** Fixed list so the type can become a CSS modifier without letting message data invent class names. */
const EMBED_TYPES: ReadonlySet<string> = new Set(['rich', 'image', 'video', 'gifv', 'article', 'link', 'poll_result']);

/** Picture-first embed types: the thumbnail is the main picture, not a small corner thumbnail. */
const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'gifv']);

const THUMBNAIL_BOX = 80;

/** `normalizeEmbed` already limits media to Discord hosts and inline images; the export also needs them to load under its CSP. */
function restrictEmbed(view: NormalizedEmbed): NormalizedEmbed {
  const picture = (media: EmbedMediaView | null): EmbedMediaView | null => {
    const url = media === null ? null : loadableImage(media.url);
    return media === null || url === null ? null : { ...media, url };
  };
  const image = picture(view.image);
  const thumbnail = picture(view.thumbnail);
  const video = view.video === null ? null : loadableMedia(view.video.url);
  return {
    ...view,
    image,
    thumbnail,
    video: video === null ? null : { url: video, posterUrl: thumbnail?.url ?? image?.url ?? null },
    author: view.author === null ? null : { ...view.author, iconUrl: loadableImage(view.author.iconUrl) },
    footer: view.footer === null ? null : { ...view.footer, iconUrl: loadableImage(view.footer.iconUrl) },
  };
}

interface EmbedPicture {
  media: EmbedMediaView;
  className: string;
  alt: string;
  /** Safe link target (the embed URL); null => not clickable. */
  href: string | null;
  /** Show a play badge (a video embed whose player cannot be loaded here: the picture links to the source). */
  play: boolean;
  maxWidth: number;
  maxHeight: number;
}

function embedPictureHtml(picture: EmbedPicture, env: HtmlEnv): string {
  const { media, href } = picture;
  const box = fitBox(media.width, media.height, picture.maxWidth, picture.maxHeight);
  const image = `<img class="msg-embed__image" src="${e(media.url)}" alt="${e(picture.alt)}"${sizeAttrs(box)} loading="lazy" decoding="async">`;
  let inner = image;
  if (href !== null) {
    const label = picture.play ? attr('aria-label', env.labels.openVideo) : '';
    const play = picture.play ? `<span class="msg-embed__play" aria-hidden="true">${iconSvg('play', 24)}</span>` : '';
    inner = `<a class="msg-embed__media-link" href="${e(href)}"${label}${EXTERNAL}>${image}${play}</a>`;
  }
  return `<div class="${picture.className}">${inner}</div>`;
}

function embedFieldsHtml(fields: NormalizedEmbed['fields'], env: HtmlEnv): string {
  // Inline fields share a row, three per row (a 12-column grid, four columns each); a block field resets the run.
  let run = 0;
  let html = '<div class="msg-embed__fields">';
  for (const field of fields) {
    let className = 'msg-embed__field';
    if (field.inline) {
      className += ` msg-embed__field--inline msg-embed__field--col${(run % 3) + 1}`;
      run += 1;
    } else {
      run = 0;
    }
    html += `<div class="${className}">`;
    if (field.name.trim() !== '') html += `<div class="msg-embed__field-name" dir="auto">${line(field.name)}</div>`;
    if (field.value.trim() !== '') html += `<div class="msg-embed__field-value">${markdownHtml(field.value, env)}</div>`;
    html += '</div>';
  }
  return `${html}</div>`;
}

function embedHtml(embed: Embed, env: HtmlEnv): string {
  const view = restrictEmbed(normalizeEmbed(embed));
  const kind = EMBED_TYPES.has(view.type) ? view.type : 'rich';

  const thumbnailIsMain = view.image === null && view.thumbnail !== null && MEDIA_TYPES.has(kind);
  const mainImage = view.image ?? (thumbnailIsMain ? view.thumbnail : null);
  const cornerThumbnail = thumbnailIsMain ? null : view.thumbnail;

  const hasText =
    view.title !== null || view.description !== null || view.author !== null || view.provider !== null || view.fields.length > 0;
  const hasFooter = view.footer !== null || view.timestamp !== null;
  const hasMedia = view.video !== null || mainImage !== null;
  if (!hasText && !hasFooter && !hasMedia && cornerThumbnail === null) return '';

  const alt = oneLine(view.title ?? view.provider ?? '');

  let media = '';
  if (view.video !== null) {
    const poster = [view.thumbnail, view.image].find((m) => m !== null && m.url === view.video?.posterUrl);
    media =
      `<div class="msg-embed__media"><video class="msg-video" src="${e(view.video.url)}"${attr('poster', view.video.posterUrl ?? undefined)}` +
      ` controls preload="none" playsinline${sizeAttrs(fitBox(poster?.width, poster?.height))}${attr('aria-label', alt === '' ? undefined : alt)}></video></div>`;
  } else if (mainImage !== null) {
    media = embedPictureHtml(
      { media: mainImage, className: 'msg-embed__media', alt, href: view.titleUrl, play: kind === 'video', maxWidth: MEDIA_MAX_WIDTH, maxHeight: MEDIA_MAX_HEIGHT },
      env,
    );
  }

  // A bare picture embed (an image link or GIF preview) is shown without the box, like Discord does.
  const bare =
    (kind === 'image' || kind === 'gifv') &&
    hasMedia &&
    view.title === null &&
    view.description === null &&
    view.author === null &&
    view.fields.length === 0 &&
    !hasFooter;
  if (bare) return `<div class="msg-embed msg-embed--${kind} msg-embed--bare">${media}</div>`;

  const { author, footer } = view;
  const colorStyle = view.colorHex === null ? '' : ` style="border-left-color:${view.colorHex}"`;
  let html = `<div class="msg-embed msg-embed--${kind}"${colorStyle}>`;

  if (hasText || cornerThumbnail !== null) {
    html += '<div class="msg-embed__top">';
    if (hasText) {
      html += '<div class="msg-embed__text">';
      if (view.provider !== null) html += `<div class="msg-embed__provider" dir="auto">${line(view.provider)}</div>`;
      if (author !== null) {
        html += '<div class="msg-embed__author">';
        if (author.iconUrl !== null) {
          html += `<img class="msg-embed__author-icon" src="${e(author.iconUrl)}" alt="" width="24" height="24" loading="lazy" decoding="async">`;
        }
        html +=
          author.url === null
            ? `<span class="msg-embed__author-name" dir="auto">${line(author.name)}</span>`
            : `<a class="msg-embed__author-name" dir="auto" href="${e(author.url)}"${EXTERNAL}>${line(author.name)}</a>`;
        html += '</div>';
      }
      if (view.title !== null) {
        const title =
          view.titleUrl === null
            ? line(view.title)
            : `<a class="msg-embed__title-link" href="${e(view.titleUrl)}"${EXTERNAL}>${line(view.title)}</a>`;
        html += `<div class="msg-embed__title" dir="auto">${title}</div>`;
      }
      if (view.description !== null) html += `<div class="msg-embed__description">${markdownHtml(view.description, env)}</div>`;
      if (view.fields.length > 0) html += embedFieldsHtml(view.fields, env);
      html += '</div>';
    }
    if (cornerThumbnail !== null) {
      html += embedPictureHtml(
        { media: cornerThumbnail, className: 'msg-embed__thumbnail', alt, href: null, play: false, maxWidth: THUMBNAIL_BOX, maxHeight: THUMBNAIL_BOX },
        env,
      );
    }
    html += '</div>';
  }

  html += media;

  if (hasFooter) {
    html += '<div class="msg-embed__footer">';
    if (footer !== null && footer.iconUrl !== null) {
      html += `<img class="msg-embed__footer-icon" src="${e(footer.iconUrl)}" alt="" width="20" height="20" loading="lazy" decoding="async">`;
    }
    html += '<span class="msg-embed__footer-text" dir="auto">';
    if (footer !== null) html += line(footer.text);
    if (footer !== null && view.timestamp !== null) html += '<span class="msg-embed__footer-sep" aria-hidden="true"> • </span>';
    if (view.timestamp !== null) html += timeHtml(null, view.timestamp, headerTimestamp(view.timestamp, env.timeZone, env.locale), env);
    html += '</span></div>';
  }
  return `${html}</div>`;
}

function embedsHtml(embeds: readonly Embed[] | undefined, env: HtmlEnv): string {
  const items = objectsOf(embeds);
  if (items.length === 0) return '';
  let html = '<div class="msg-embeds">';
  for (const embed of items) html += embedHtml(embed, env);
  return `${html}</div>`;
}

// ---------------------------------------------------------------------------------------------------------------------
// stickers, poll, reactions, forwards
// ---------------------------------------------------------------------------------------------------------------------

const STICKER_SIZE = 160;

function stickersHtml(stickers: readonly StickerItem[] | undefined, env: HtmlEnv): string {
  const items = objectsOf(stickers);
  if (items.length === 0) return '';
  let html = '<div class="msg-stickers">';
  for (const sticker of items) {
    const view = stickerView(sticker);
    const name = oneLine(view.name) || env.labels.stickerFallback;
    const src = loadableImage(view.imageUrl);
    html += '<div class="msg-sticker">';
    html +=
      src === null
        ? `<span class="msg-sticker__name" dir="auto">${e(name)}</span>`
        : `<img class="msg-sticker__image" src="${e(src)}" alt="${e(name)}" title="${e(name)}" width="${STICKER_SIZE}" height="${STICKER_SIZE}" loading="lazy" decoding="async">`;
    html += '</div>';
  }
  return `${html}</div>`;
}

function pollHtml(poll: Poll, env: HtmlEnv): string {
  const { labels } = env;
  const view = pollView(poll);
  const total = view.totalVotes;
  const leading = view.answers.reduce((max, answer) => Math.max(max, answer.votes ?? 0), 0);

  let html = `<div class="${view.finalized ? 'msg-poll msg-poll--closed' : 'msg-poll'}">`;
  if (view.question !== '') html += `<div class="msg-poll__question" dir="auto">${line(view.question)}</div>`;
  if (!view.finalized) html += `<div class="msg-poll__hint">${e(view.multiselect ? labels.pollMulti : labels.pollSingle)}</div>`;
  html += '<ul class="msg-poll__answers">';
  for (const answer of view.answers) {
    const votes = answer.votes;
    const percent = votes === null || total === null || total === 0 ? 0 : Math.round((votes / total) * 100);
    const winner = view.finalized && votes !== null && votes > 0 && votes === leading;
    html += `<li class="${winner ? 'msg-poll__answer msg-poll__answer--winner' : 'msg-poll__answer'}"><div class="msg-poll__answer-row">`;
    if (answer.emoji !== null) html += `<span class="msg-poll__emoji">${line(answer.emoji)}</span>`;
    html += `<span class="msg-poll__text" dir="auto">${line(answer.text)}</span>`;
    if (votes !== null) html += `<span class="msg-poll__votes">${e(labels.pollVotes(votes))} · ${percent}%</span>`;
    html += '</div>';
    if (votes !== null) {
      const max = total !== null && total > 0 ? total : 1;
      html += `<progress class="msg-poll__bar" max="${max}" value="${votes}"${attr('aria-label', `${labels.pollVotes(votes)}, ${percent}%`)}></progress>`;
    }
    html += '</li>';
  }
  html += '</ul>';
  if (total !== null) html += `<div class="msg-poll__footer">${e(labels.pollVotes(total))}${view.finalized ? ` · ${e(labels.pollClosed)}` : ''}</div>`;
  return `${html}</div>`;
}

function reactionsHtml(reactions: readonly Reaction[] | undefined, env: HtmlEnv): string {
  const items = objectsOf(reactions);
  if (items.length === 0) return '';
  const { labels } = env;
  let html = `<div class="msg-reactions" role="group"${attr('aria-label', labels.reactions)}>`;
  for (const reaction of items) {
    const view = reactionView(reaction);
    const label = oneLine(view.label);
    const src = loadableImage(view.imageUrl);
    const textEmoji = `<span class="msg-reaction__emoji msg-reaction__emoji--text" aria-hidden="true">${e(label)}</span>`;
    let emoji: string;
    if (src !== null) {
      emoji = `<img class="msg-reaction__img" src="${e(src)}" alt="${e(label)}" width="16" height="16" loading="lazy" decoding="async">`;
    } else {
      // Unicode emoji, or a custom emoji whose id is unusable (`:name:`).
      emoji = label.startsWith(':') ? textEmoji : `<span class="msg-reaction__emoji" aria-hidden="true">${e(label)}</span>`;
    }
    html +=
      `<span class="${view.me ? 'msg-reaction msg-reaction--me' : 'msg-reaction'}" role="img"${attr('aria-label', labels.reaction(label, view.count, view.me))}` +
      `${attr('title', label === '' ? undefined : label)}>${emoji}<span class="msg-reaction__count" aria-hidden="true">${view.count}</span></span>`;
  }
  return `${html}</div>`;
}

function forwardsHtml(snapshots: readonly ForwardSnapshotView[], env: HtmlEnv): string {
  let html = '';
  for (const snapshot of snapshots) {
    html += '<div class="msg-forward">';
    if (snapshot.content.trim() !== '') html += `<div class="msg-content" dir="auto">${markdownHtml(snapshot.content, env)}</div>`;
    html += attachmentsHtml(snapshot.attachments, env);
    html += embedsHtml(snapshot.embeds, env);
    if (snapshot.timestamp !== null) {
      html += timeHtml('msg-forward__time', snapshot.timestamp, headerTimestamp(snapshot.timestamp, env.timeZone, env.locale), env);
    }
    html += '</div>';
  }
  return html;
}

// ---------------------------------------------------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------------------------------------------------

/** Stand-in for a message without a usable author object. */
const UNKNOWN_AUTHOR: User = { id: '0', username: '' };

function dayDividerHtml(iso: string, env: HtmlEnv): string {
  const label = formatDayLabel(iso, env.timeZone, env.locale);
  if (label === '') return '';
  return `<div class="msg-day-divider" role="separator"${attr('aria-label', label)}><span class="msg-day-divider__label">${e(label)}</span></div>`;
}

interface SystemIcon {
  name: MsgIconName;
  /** CSS modifier `msg-system__icon--<tone>`. */
  tone: 'join' | 'leave' | 'pin' | 'boost' | 'neutral';
}

function systemIconOf(type: number): SystemIcon {
  switch (type) {
    case 1:
    case 7:
      return { name: 'join', tone: 'join' };
    case 2:
      return { name: 'leave', tone: 'leave' };
    case 3:
      return { name: 'call', tone: 'join' };
    case 4:
    case 5:
      return { name: 'edit', tone: 'neutral' };
    case 6:
      return { name: 'pin', tone: 'pin' };
    case 8:
    case 9:
    case 10:
    case 11:
      return { name: 'boost', tone: 'boost' };
    case 18:
      return { name: 'thread', tone: 'neutral' };
    default:
      return { name: 'info', tone: 'neutral' };
  }
}

/** The sentence with the actor's name emphasised. Falls back to plain text when the name is not found verbatim. */
function systemTextHtml(text: string, actor: string): string {
  const at = actor === '' ? -1 : text.indexOf(actor);
  if (at === -1) return e(text);
  return `${e(text.slice(0, at))}<span class="msg-system__actor">${e(actor)}</span>${e(text.slice(at + actor.length))}`;
}

function systemHtml(message: Message, env: HtmlEnv): string {
  const text = systemMessageText(message, env.locale) ?? '';
  const author: User | undefined = message.author;
  const actor = author ? displayName(author) : '';
  const icon = systemIconOf(typeof message.type === 'number' ? message.type : 0);
  const stamp = timeHtml('msg-timestamp', message.timestamp, headerTimestamp(message.timestamp, env.timeZone, env.locale), env);
  return (
    `<article class="msg msg--system"${messageIdAttr(message)}>` +
    `<span class="msg-system__icon msg-system__icon--${icon.tone}">${iconSvg(icon.name, 16)}</span>` +
    `<div class="msg-system__text">${systemTextHtml(text, actor)}${stamp}</div></article>`
  );
}

/** A user-authored message in Discord's cozy layout. */
function userMessageHtml(message: Message, prev: Message | undefined, env: HtmlEnv): string {
  const { labels, locale, timeZone } = env;
  const author = typeof message.author === 'object' && message.author !== null ? message.author : UNKNOWN_AUTHOR;
  const name = oneLine(displayName(author)) || env.strings.unknownUser;
  const grouped = shouldGroupWithPrevious(prev, message, timeZone);
  const reference = referenceView(message, locale);
  const content = typeof message.content === 'string' ? message.content : '';
  const hasText = content.trim() !== '';
  const edited = typeof message.edited_timestamp === 'string' && message.edited_timestamp !== '';
  const isApp = author.bot === true || message.webhook_id != null;
  const full = formatFullTooltip(message.timestamp, timeZone, locale);

  let className = grouped ? 'msg msg--grouped' : 'msg msg--first';
  if (reference?.kind === 'reply') className += ' msg--reply';
  if (reference?.kind === 'forward') className += ' msg--forward';
  if (isApp) className += ' msg--app';

  let html = `<article class="${className}"${messageIdAttr(message)}${attr('aria-label', full === '' ? name : `${name}, ${full}`)}>`;
  if (reference?.kind === 'reply') html += referenceHtml(reference, env);
  html += grouped ? timeHtml('msg-gutter-time', message.timestamp, formatClock(message.timestamp, timeZone, locale), env) : avatarHtml(author, 40, 'msg-avatar');

  html += '<div class="msg-body">';
  if (!grouped) {
    html += `<div class="msg-header"><span class="msg-author" dir="auto">${e(name)}</span>`;
    if (isApp) html += `<span class="msg-tag">${e(labels.appTag)}</span>`;
    html += `${timeHtml('msg-timestamp', message.timestamp, headerTimestamp(message.timestamp, timeZone, locale), env)}</div>`;
  }
  if (hasText || edited) {
    html += '<div class="msg-content" dir="auto">';
    if (hasText) html += markdownHtml(content, env);
    if (edited) {
      html += `<span class="msg-edited"${attr('title', formatFullTooltip(message.edited_timestamp ?? '', timeZone, locale) || undefined)}>${e(labels.edited)}</span>`;
    }
    html += '</div>';
  }
  if (reference?.kind === 'forward') html += referenceHtml(reference, env);
  html += forwardsHtml(forwardView(message), env);
  html += attachmentsHtml(message.attachments, env);
  html += embedsHtml(message.embeds, env);
  html += stickersHtml(message.sticker_items, env);
  if (typeof message.poll === 'object' && message.poll !== null) html += pollHtml(message.poll, env);
  html += reactionsHtml(message.reactions, env);
  return `${html}</div></article>`;
}

/**
 * One entry of the message list: an optional day divider followed by the message (or system notice). `prev` is the
 * message right above this one in the file (undefined for the first), which decides grouping and the day divider.
 */
export function renderMessageItem(message: Message, prev: Message | undefined, env: HtmlEnv): string {
  const divider = prev === undefined || !isSameDay(prev.timestamp, message.timestamp, env.timeZone) ? dayDividerHtml(message.timestamp, env) : '';
  return divider + (isSystemMessage(message) ? systemHtml(message, env) : userMessageHtml(message, prev, env));
}
