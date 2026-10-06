// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_PATH, DOWNLOAD_PATH, REMOVE_PATH, currentIcon } from '@/content/inject/icons';
import { LOCAL } from '@/shared/storageKeys';
import { ACCOUNT, boot, type Booted } from '../helpers/app';
import {
  CHANNEL_ICON_CLASS,
  CHANNEL_SVG_CLASS,
  DM_CLOSE_CLASS,
  DM_CLOSE_SVG_CLASS,
  FAVORITE_ICON,
  FORCE_CLASS,
  GUILD,
  ID,
  WAVE_ICON,
  allButtons,
  byKey,
  categoryRow,
  channelRow,
  dmRow,
  mirrored,
  mount,
  nativeChannelIcon,
  sidebar,
  threadRow,
} from '../helpers/fixtures';

let ctx: Booted | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  document.title = 'Discord';
  document.documentElement.className = '';
  document.documentElement.removeAttribute('lang');
  history.pushState({}, '', '/');
});

afterEach(() => {
  ctx?.app.destroy();
  ctx = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** The body as Discord rendered it: our nodes removed. */
function withoutOwnNodes(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const node of Array.from(clone.querySelectorAll('[data-dce]'))) node.remove();
  return clone.innerHTML;
}

describe('channel and voice rows', () => {
  it('the button is the LAST child of children_, after the invite icon and its hidden label, with the native classes and our own svg', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const container = document.querySelector('.children__2ea32')!;
    const button = container.lastElementChild as HTMLElement;

    expect(button.getAttribute('data-dce')).toBe('row-btn');
    expect(button.getAttribute('data-dce-key')).toBe(ID.general);
    expect(button.getAttribute('data-dce-kind')).toBe('channel');
    expect(button.getAttribute('data-dce-src')).toBe('native');
    expect(button.getAttribute('role')).toBe('button');
    expect(button.getAttribute('tabindex')).toBe('0');
    expect(button.getAttribute('draggable')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('다운로드 목록에 추가');
    expect(button.className).toBe(mirrored(CHANNEL_ICON_CLASS)); // iconItem + iconBase + iconNoChannelInfo copied as is, + ours
    expect(Array.from(container.children).map((el) => el.tagName)).toEqual(['SPAN', 'SPAN', 'DIV']); // invite, its label, ours
    expect(button.previousElementSibling?.className).toBe('hiddenVisually_b18fe2');
    expect(container.children).toHaveLength(3);

    const svg = button.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe(CHANNEL_SVG_CLASS); // actionIcon
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('data-dce-state')).toBe('idle');
  });

  it('never touches Discord`s own nodes: with ours removed the page is exactly as rendered', async () => {
    const html = sidebar(
      categoryRow({ id: ID.categoryA, name: 'Category A' }),
      channelRow({ id: ID.general, name: 'general', selected: true }),
      channelRow({ id: ID.voice, name: 'lounge', voice: true }),
    ) + dmRow({ id: ID.dm, name: 'Alex', before: FAVORITE_ICON + WAVE_ICON });
    mount(html);
    const baseline = document.body.innerHTML;
    const nativeIcon = document.querySelector('[class^="iconItem_"]')!;
    const nativeParent = nativeIcon.parentElement;
    ctx = await boot({});
    expect(allButtons()).toHaveLength(4);
    expect(withoutOwnNodes()).toBe(baseline);
    expect(nativeIcon.parentElement).toBe(nativeParent); // not moved, not wrapped
  });

  it('a selected row gets its button the same way', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', selected: true })) });
    const button = byKey(ID.general)!;
    expect(button.className).toBe(mirrored(CHANNEL_ICON_CLASS));
    expect(button.parentElement?.lastElementChild).toBe(button);
  });

  it('a voice row (no href) gets one in its icon container, last', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.voice, name: 'lounge', voice: true })) });
    const button = byKey(ID.voice)!;
    expect(button.getAttribute('data-dce-kind')).toBe('voice');
    expect(button.parentElement?.lastElementChild).toBe(button);
    expect(button.className).toBe(mirrored(CHANNEL_ICON_CLASS));
  });

  it('a row with several native icons (invite, edit, ...): ours comes after all of them', async () => {
    const edit = '<span><div class="iconItem_c69b6d iconBase_c69b6d" role="button" tabindex="0" aria-label="Edit channel"><svg class="actionIcon_c69b6d" width="16" height="16"></svg></div></span>';
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', icons: nativeChannelIcon() + edit })) });
    const container = document.querySelector('.children__2ea32')!;
    expect(container.lastElementChild).toBe(byKey(ID.general));
    expect(Array.from(container.children).filter((el) => el.hasAttribute('data-dce'))).toHaveLength(1);
    expect(container.children).toHaveLength(4);
    expect(container.children[2]?.querySelector('[aria-label="Edit channel"]')).not.toBeNull();
  });

  it('forum rows (a count badge in children_) get the button after the badge', async () => {
    const badge = '<div class="forumCount__2ea32">3</div>';
    ctx = await boot({ html: sidebar(channelRow({ id: ID.forum, name: 'ideas', icons: badge })) });
    const button = byKey(ID.forum)!;
    expect(button.previousElementSibling?.className).toBe('forumCount__2ea32');
    expect(button.parentElement?.lastElementChild).toBe(button);
    expect(button.getAttribute('data-dce-src')).toBe('fallback'); // no native icon in this row, nothing learned yet
  });

  it('every row gets exactly one button', async () => {
    ctx = await boot({
      html: sidebar(
        categoryRow({ id: ID.categoryA, name: 'Category A' }),
        channelRow({ id: ID.general, name: 'general' }),
        channelRow({ id: ID.random, name: 'random' }),
        channelRow({ id: ID.voice, name: 'lounge', voice: true }),
      ),
    });
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([ID.categoryA, ID.general, ID.random, ID.voice]);
  });
});

describe('thread rows', () => {
  it('get a button in their own container (not the parent`s), with the classes learned from the parent`s native icon', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general', threads: [threadRow({ id: ID.thread, name: 'Thread A' })] })),
    });
    expect(allButtons()).toHaveLength(2);
    const channelButton = byKey(ID.general)!;
    const threadButton = byKey(ID.thread)!;
    expect(channelButton.getAttribute('data-dce-src')).toBe('native');
    expect(threadButton.getAttribute('data-dce-kind')).toBe('thread');
    expect(threadButton.getAttribute('data-dce-src')).toBe('cache');
    expect(threadButton.className).toBe(mirrored(CHANNEL_ICON_CLASS));
    expect(threadButton.querySelector('svg')?.getAttribute('class')).toBe(CHANNEL_SVG_CLASS);
    const threadRowLi = document.querySelector('ul[role="group"] > li')!;
    expect(threadRowLi.contains(threadButton)).toBe(true);
    expect(threadRowLi.contains(channelButton)).toBe(false);
    expect(threadButton.parentElement?.lastElementChild).toBe(threadButton); // rightmost, like every row
  });

  it('a thread row has no native icons: with nothing learned yet it is drawn by our fallback CSS, always visible, rightmost', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general', icons: '', threads: [threadRow({ id: ID.thread, name: 'Thread A' })] })),
    });
    const threadButton = byKey(ID.thread)!;
    expect(threadButton.getAttribute('data-dce-src')).toBe('fallback');
    expect(threadButton.className).toBe(`dce-row-btn ${FORCE_CLASS}`);
    expect(threadButton.parentElement?.className).toBe('children__2ea32');
    expect(threadButton.parentElement?.lastElementChild).toBe(threadButton);
  });

  it('a thread row without a container gets nothing (and the parent is unaffected)', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general', threads: [threadRow({ id: ID.thread, name: 'Thread A', container: false })] })),
    });
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([ID.general]);
  });
});

describe('category rows', () => {
  it('sit OUTSIDE children_ (hidden until hover): the last child of the iconVisibility_ line, after children_, with our own look', async () => {
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    const button = byKey(ID.categoryA)!;
    const line = button.parentElement!;
    expect(line.className).toContain('iconVisibility__29444');
    expect(line.lastElementChild).toBe(button);
    expect(button.previousElementSibling?.className).toBe('children__29444');
    expect(document.querySelector('.children__29444')!.querySelector('[data-dce]')).toBeNull();
    expect(Array.from(line.children).map((el) => el.className.split(' ')[0])).toEqual(['mainContent__29444', 'children__29444', 'dce-row-btn']);
    expect(button.getAttribute('data-dce-kind')).toBe('category');
    expect(button.getAttribute('data-dce-src')).toBe('fallback'); // no channel icon classes learned yet
    expect(button.className).toBe(`dce-row-btn ${FORCE_CLASS}`);
    expect(button.getAttribute('aria-label')).toBe('이 카테고리 채널 전부 추가');
    expect(button.getAttribute('data-dce-state')).toBe('idle'); // no group known: not checked
    expect(button.querySelector('svg')?.getAttribute('class')).toBe('dce-row-icon');
    expect(button.querySelector('svg')?.getAttribute('width')).toBe('16');
  });

  it('take the look of the channel icons learned from other rows (cache), and the fallback while nothing is known', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general' }), categoryRow({ id: ID.categoryA, name: 'Category A' })),
    });
    expect(byKey(ID.general)!.getAttribute('data-dce-src')).toBe('native');
    const category = byKey(ID.categoryA)!;
    expect(category.getAttribute('data-dce-src')).toBe('cache');
    expect(category.className).toBe(mirrored(CHANNEL_ICON_CLASS));
    expect(category.querySelector('svg')?.getAttribute('class')).toBe(CHANNEL_SVG_CLASS);
    expect(category.parentElement?.lastElementChild).toBe(category); // still outside children_, still rightmost
  });

  it('a category that comes before any channel row is drawn by the fallback and switches to the learned look once one is seen', async () => {
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    expect(byKey(ID.categoryA)!.getAttribute('data-dce-src')).toBe('fallback');
    document.querySelector('ul')!.insertAdjacentHTML('beforeend', channelRow({ id: ID.general, name: 'general' }));
    await ctx.frame(); // the new row teaches the classes; a rescan (asked for by the pass itself) restyles the category
    expect(byKey(ID.categoryA)!.getAttribute('data-dce-src')).toBe('cache');
    expect(byKey(ID.categoryA)!.className).toBe(mirrored(CHANNEL_ICON_CLASS));
    expect(allButtons()).toHaveLength(2);
  });

  it('an admin`s "create channel" button stays inside children_, to the LEFT of ours (it only shows on hover)', async () => {
    const addButton = '<div class="addButton__29444" role="button" tabindex="0"></div>';
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A', children: addButton })) });
    const button = byKey(ID.categoryA)!;
    const children = document.querySelector('.children__29444')!;
    expect(children.firstElementChild?.className).toBe('addButton__29444');
    expect(button.parentElement).not.toBe(children);
    const line = Array.from(button.parentElement!.children);
    expect(line.indexOf(children)).toBeLessThan(line.indexOf(button));
  });
});

describe('DM rows', () => {
  it('the button is the LAST child of iconsContainer_: after the favourite and wave icons AND after the close button', async () => {
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex', before: FAVORITE_ICON + WAVE_ICON }) });
    const container = document.querySelector('.iconsContainer__972a0')!;
    const classes = Array.from(container.children).map((el) => el.className);
    expect(classes).toEqual(['favoriteButton__972a0', 'waveButton__972a0', DM_CLOSE_CLASS, mirrored(DM_CLOSE_CLASS)]);
    const kids = Array.from(container.children) as HTMLElement[];
    expect(kids[2]!.hasAttribute('data-dce')).toBe(false); // the native close button
    expect(kids[3]!.getAttribute('data-dce')).toBe('row-btn'); // ours
  });

  it('mirrors the close button`s classes, its inner wrapper and the closeIcon svg', async () => {
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }) });
    const button = byKey(ID.dm)!;
    expect(button.className).toBe(mirrored(DM_CLOSE_CLASS));
    expect(button.getAttribute('data-dce-kind')).toBe('dm');
    expect(button.getAttribute('data-dce-src')).toBe('native');
    expect(button.firstElementChild?.tagName).toBe('DIV'); // closeButton > div > svg
    expect(button.querySelector('svg')?.getAttribute('class')).toBe(DM_CLOSE_SVG_CLASS);
    expect(button.querySelector('svg')?.parentElement).toBe(button.firstElementChild);
    expect(button.previousElementSibling?.className).toBe(DM_CLOSE_CLASS); // the native close button is on our left
    expect(button.nextElementSibling).toBeNull();
  });

  it('a group DM is handled the same way, after its "leave group" button', async () => {
    ctx = await boot({ html: dmRow({ id: ID.groupDm, name: 'Sam, Kim, Lee', group: true }) });
    const button = byKey(ID.groupDm)!;
    expect(button.previousElementSibling?.getAttribute('aria-label')).toBe('Leave group');
    expect(button.parentElement?.lastElementChild).toBe(button);
  });

  it('a DM without a close button gets the button appended', async () => {
    ctx = await boot({ html: dmRow({ id: ID.newFriendDm, name: 'Robin', close: false, before: WAVE_ICON }) });
    const container = document.querySelector('.iconsContainer__972a0')!;
    expect(container.lastElementChild).toBe(byKey(ID.newFriendDm));
    expect(container.children).toHaveLength(2);
    expect(byKey(ID.newFriendDm)!.getAttribute('data-dce-src')).toBe('fallback');
  });

  it('a DM without a close button reuses the DM classes learned from another DM', async () => {
    ctx = await boot({
      html: dmRow({ id: ID.dm, name: 'Alex' }) + dmRow({ id: ID.newFriendDm, name: 'Robin', close: false, position: 12 }),
    });
    const button = byKey(ID.newFriendDm)!;
    expect(button.getAttribute('data-dce-src')).toBe('cache');
    expect(button.className).toBe(mirrored(DM_CLOSE_CLASS));
    expect(button.firstElementChild?.tagName).toBe('DIV');
    expect(button.querySelector('svg')?.getAttribute('class')).toBe(DM_CLOSE_SVG_CLASS);
  });

  it('DM rows never take the channel classes (and channel rows never take the DM ones)', async () => {
    ctx = await boot({
      html: dmRow({ id: ID.dm, name: 'Alex' }) + sidebar(channelRow({ id: ID.general, name: 'general', icons: '' })),
    });
    expect(byKey(ID.general)!.getAttribute('data-dce-src')).toBe('fallback'); // only a DM taught us something so far
  });
});

describe('fallback look and the class cache', () => {
  it('no native icon and nothing learned: our own CSS draws it (no Discord classes, 16px svg)', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', icons: '' })) });
    const button = byKey(ID.general)!;
    expect(button.getAttribute('data-dce-src')).toBe('fallback');
    expect(button.className).toBe(`dce-row-btn ${FORCE_CLASS}`); // no Discord class; ours only
    const svg = button.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('dce-row-icon');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
  });

  it('classes learned from one row are used for a row without native icons, and are stored (debounced) in classCache', async () => {
    vi.useFakeTimers();
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.random, name: 'random', icons: '' })),
    });
    expect(byKey(ID.general)!.getAttribute('data-dce-src')).toBe('native');
    const learned = byKey(ID.random)!;
    expect(learned.getAttribute('data-dce-src')).toBe('cache');
    expect(learned.className).toBe(mirrored(CHANNEL_ICON_CLASS));
    expect(learned.querySelector('svg')?.getAttribute('class')).toBe(CHANNEL_SVG_CLASS);

    const cacheWrites = (): Record<string, unknown>[] => ctx!.chrome.writes.filter((write) => LOCAL.classCache in write);
    expect(cacheWrites()).toEqual([]); // debounced
    await vi.advanceTimersByTimeAsync(1100);
    expect(cacheWrites()).toEqual([{ [LOCAL.classCache]: { channelIcon: CHANNEL_ICON_CLASS, channelSvg: CHANNEL_SVG_CLASS } }]);
  });

  it('writes the class cache once, however many rows teach the same thing', async () => {
    vi.useFakeTimers();
    ctx = await boot({
      html: sidebar(
        channelRow({ id: ID.general, name: 'general' }),
        channelRow({ id: ID.random, name: 'random' }),
        channelRow({ id: ID.voice, name: 'lounge', voice: true }),
      ) + dmRow({ id: ID.dm, name: 'Alex' }),
    });
    await vi.advanceTimersByTimeAsync(3000);
    const cacheWrites = ctx.chrome.writes.filter((write) => LOCAL.classCache in write);
    expect(cacheWrites).toHaveLength(1);
    expect(cacheWrites[0]![LOCAL.classCache]).toEqual({
      channelIcon: CHANNEL_ICON_CLASS,
      channelSvg: CHANNEL_SVG_CLASS,
      dmButton: DM_CLOSE_CLASS,
      dmSvg: DM_CLOSE_SVG_CLASS,
    });
  });

  it('a cache stored by an earlier visit serves the very first row, which has no native icon', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general', icons: '' })),
      stored: { [LOCAL.classCache]: { channelIcon: CHANNEL_ICON_CLASS, channelSvg: CHANNEL_SVG_CLASS } },
    });
    const button = byKey(ID.general)!;
    expect(button.getAttribute('data-dce-src')).toBe('cache');
    expect(button.className).toBe(mirrored(CHANNEL_ICON_CLASS));
  });

  it('a cache that is not made of class names for the right element is ignored', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general', icons: '' })),
      stored: { [LOCAL.classCache]: { channelIcon: 'unrelated_abc', channelSvg: '<script>', dmButton: 42 } },
    });
    expect(byKey(ID.general)!.getAttribute('data-dce-src')).toBe('fallback');
  });

  it('a row that later gets a native icon switches from the fallback look to the mirrored one', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general', icons: '' })) });
    expect(byKey(ID.general)!.getAttribute('data-dce-src')).toBe('fallback');
    const container = document.querySelector('.children__2ea32')!;
    container.insertAdjacentHTML('beforeend', nativeChannelIcon());
    await ctx.frame();
    const button = byKey(ID.general)!;
    expect(button.getAttribute('data-dce-src')).toBe('native');
    expect(button.className).toBe(mirrored(CHANNEL_ICON_CLASS));
    expect(allButtons()).toHaveLength(1);
    expect(button.parentElement?.lastElementChild).toBe(button); // after the icon that just appeared
  });
});

describe('always visible, hover icons stay on the left', () => {
  const kinds = (): string[] => allButtons().map((b) => b.getAttribute('data-dce-kind')!);

  it('every kind of row button carries the force class next to the mirrored ones, and no hover is needed', async () => {
    ctx = await boot({
      html: sidebar(
        categoryRow({ id: ID.categoryA, name: 'Category A' }),
        channelRow({ id: ID.general, name: 'general', threads: [threadRow({ id: ID.thread, name: 'Thread A' })] }),
        channelRow({ id: ID.voice, name: 'lounge', voice: true }),
        channelRow({ id: ID.forum, name: 'ideas', icons: '' }),
      ) + dmRow({ id: ID.dm, name: 'Alex' }),
    });
    expect(kinds().sort()).toEqual(['category', 'channel', 'channel', 'dm', 'thread', 'voice']);
    for (const button of allButtons()) {
      expect(button.classList.contains(FORCE_CLASS), button.getAttribute('data-dce-key')!).toBe(true);
      expect(button.hasAttribute('data-dce-force')).toBe(false); // the old per-state attribute is gone
    }
    // Discord's classes are still there (selected / hover / colour rules stay native); the force class comes last
    expect(byKey(ID.general)!.className).toBe(mirrored(CHANNEL_ICON_CLASS));
    expect(byKey(ID.dm)!.className).toBe(mirrored(DM_CLOSE_CLASS));
  });

  it('the force class does not depend on the state of the row (queued or not) or on the selection', async () => {
    ctx = await boot({
      html: sidebar(
        channelRow({ id: ID.general, name: 'general', selected: true }),
        channelRow({ id: ID.random, name: 'random' }),
      ),
      queue: [ID.random],
    });
    for (const id of [ID.general, ID.random]) expect(byKey(id)!.className).toBe(mirrored(CHANNEL_ICON_CLASS));
  });

  it('the stylesheet forces it with !important: block, and flex for a DM (Discord`s hover-only rules cannot hide it)', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const css = document.getElementById('dce-style')!.textContent!;
    expect(css).toMatch(/\.dce-always\s*\{[^}]*display:\s*block\s*!important/);
    expect(css).toMatch(/\.dce-always\[data-dce-kind="dm"\]\s*\{[^}]*display:\s*flex\s*!important/);
  });

  it('what Discord shows on hover (a new icon at the end of children_) appears to the LEFT of ours, which moves back to the end', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const container = document.querySelector('.children__2ea32')!;
    const button = byKey(ID.general)!;
    const hoverIcon = document.createElement('span');
    hoverIcon.id = 'hover-icon';
    container.appendChild(hoverIcon); // React appends after the last child it knows: after ours
    await ctx.frame();
    expect(container.lastElementChild).toBe(button);
    expect(button.previousElementSibling?.id).toBe('hover-icon');
    expect(allButtons()).toHaveLength(1);
  });

  it('hover icons that are inserted before ours (or around the native ones) simply stay before ours', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const container = document.querySelector('.children__2ea32')!;
    const edit = document.createElement('span');
    edit.id = 'edit-icon';
    container.insertBefore(edit, container.firstChild);
    await ctx.frame();
    expect(Array.from(container.children).map((el) => el.id || el.getAttribute('data-dce') || el.tagName)).toEqual([
      'edit-icon',
      'SPAN',
      'SPAN',
      'row-btn',
    ]);
  });

  it('DM: the icons Discord adds on hover (wave, favourite, close) end up on the left, ours stays the last', async () => {
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }) });
    const container = document.querySelector('.iconsContainer__972a0')!;
    const button = byKey(ID.dm)!;
    container.insertAdjacentHTML('beforeend', WAVE_ICON); // appended after ours
    await ctx.frame();
    expect(container.lastElementChild).toBe(button);
    expect(button.previousElementSibling?.className).toBe('waveButton__972a0');
  });

  it('a category: "create channel" shown on hover (children_ becomes visible) never moves our button', async () => {
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    const children = document.querySelector<HTMLElement>('.children__29444')!;
    const button = byKey(ID.categoryA)!;
    const line = button.parentElement!;
    const before = Array.from(line.children);
    children.insertAdjacentHTML('beforeend', '<div class="addButton__29444" role="button" tabindex="0"></div>');
    children.style.display = 'flex'; // what the row's :hover does
    await ctx.frame();
    expect(Array.from(line.children)).toEqual(before); // nothing of ours moved, and nothing was added
    expect(line.lastElementChild).toBe(button);
  });
});

describe('idempotency', () => {
  it('a repeated pass over the same rows writes nothing to the DOM', async () => {
    ctx = await boot({
      html: sidebar(
        categoryRow({ id: ID.categoryA, name: 'Category A' }),
        channelRow({ id: ID.general, name: 'general' }),
        channelRow({ id: ID.random, name: 'random', icons: '' }),
      ) + dmRow({ id: ID.dm, name: 'Alex', before: WAVE_ICON }),
      queue: [ID.general],
    });
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((r) => records.push(...r));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    ctx.app.injector.refreshAll();
    records.push(...observer.takeRecords());
    observer.disconnect();
    expect(records).toEqual([]);
    expect(allButtons()).toHaveLength(4);
  });

  it('rebuilding children_ while the li stays: the new container gets a button again', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const old = document.querySelector('.children__2ea32')!;
    const fresh = document.createElement('div');
    fresh.className = 'children__2ea32';
    fresh.innerHTML = nativeChannelIcon();
    old.replaceWith(fresh);
    await ctx.frame();
    expect(old.querySelector('[data-dce]')).not.toBeNull(); // the old container still holds the old button, detached
    expect(old.isConnected).toBe(false);
    expect(allButtons()).toHaveLength(1);
    expect(fresh.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
  });

  it('rebuilding a DM`s iconsContainer (a sibling of the link) works too', async () => {
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }) });
    const old = document.querySelector('.iconsContainer__972a0')!;
    const fresh = old.cloneNode(false) as HTMLElement;
    fresh.innerHTML = `<div class="${DM_CLOSE_CLASS}" role="button" tabindex="0"><div><svg class="${DM_CLOSE_SVG_CLASS}" width="16" height="16"></svg></div></div>`;
    old.replaceWith(fresh);
    await ctx.frame();
    expect(allButtons()).toHaveLength(1);
    expect(fresh.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
  });

  it('a category`s children_ that is rebuilt does not touch our button (it is not inside it): still one, still last', async () => {
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    const button = byKey(ID.categoryA)!;
    const old = document.querySelector('.children__29444')!;
    const fresh = document.createElement('div');
    fresh.className = 'children__29444';
    old.replaceWith(fresh);
    await ctx.frame();
    expect(allButtons()).toEqual([button]);
    expect(button.parentElement?.lastElementChild).toBe(button);
    expect(button.previousElementSibling).toBe(fresh);
  });

  it('a category line that is rebuilt (title and all) gets its button again', async () => {
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    const li = document.querySelector('li')!;
    const holder = document.createElement('div');
    holder.innerHTML = categoryRow({ id: ID.categoryA, name: 'Category A' });
    const fresh = holder.firstElementChild!;
    li.replaceWith(fresh);
    await ctx.frame();
    expect(allButtons()).toHaveLength(1);
    expect(fresh.querySelector('[class^="iconVisibility_"]')?.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
  });

  it('a button that Discord throws away (the container`s children are replaced) comes back', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const container = document.querySelector('.children__2ea32')!;
    container.replaceChildren(); // what a re-render that does not know our node could do
    expect(allButtons()).toHaveLength(0);
    await ctx.frame();
    expect(allButtons()).toHaveLength(1);
    expect(container.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
  });

  it('a category button that Discord throws away (the line`s children are replaced) comes back', async () => {
    ctx = await boot({ html: sidebar(categoryRow({ id: ID.categoryA, name: 'Category A' })) });
    const line = byKey(ID.categoryA)!.parentElement!;
    line.replaceChildren(...Array.from(line.children).filter((el) => !el.hasAttribute('data-dce')));
    expect(allButtons()).toHaveLength(0);
    await ctx.frame();
    expect(allButtons()).toHaveLength(1);
    expect(line.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
  });

  it('moves our button back to the last place when Discord puts a new icon after it', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const container = document.querySelector('.children__2ea32')!;
    const settings = document.createElement('span');
    settings.id = 'new-last-icon';
    container.appendChild(settings);
    await ctx.frame();
    expect(container.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
    expect(container.lastElementChild?.previousElementSibling?.id).toBe('new-last-icon');
    expect(allButtons()).toHaveLength(1);
  });

  it('moving our own button back into place does not trigger yet another pass', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const container = document.querySelector('.children__2ea32')!;
    const intruder = document.createElement('span');
    container.appendChild(intruder);
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(1); // Discord added a node: one pass
    ctx.scheduler.run(); // ...which moves our button back to the last place
    expect(container.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(0); // and that move is not news
  });

  it('DM: keeps the button the very last child when Discord adds icons around it', async () => {
    ctx = await boot({ html: dmRow({ id: ID.dm, name: 'Alex' }) });
    const container = document.querySelector('.iconsContainer__972a0')!;
    const button = byKey(ID.dm)!;
    const wave = document.createElement('div');
    wave.className = 'waveButton__972a0';
    container.insertBefore(wave, button); // before ours
    const late = document.createElement('div');
    late.className = 'lateIcon__972a0';
    container.appendChild(late); // after ours
    await ctx.frame();
    expect(container.lastElementChild).toBe(button);
    expect(Array.from(container.children).map((el) => el.className)).toEqual([
      DM_CLOSE_CLASS,
      'waveButton__972a0',
      'lateIcon__972a0',
      mirrored(DM_CLOSE_CLASS),
    ]);
  });

  it('duplicates of our button (two instances, a copy) are cleaned up on the next pass', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const container = document.querySelector('.children__2ea32')!;
    container.insertBefore(byKey(ID.general)!.cloneNode(true), container.firstChild);
    expect(allButtons()).toHaveLength(2);
    ctx.app.injector.requestFullScan();
    await ctx.frame();
    expect(allButtons()).toHaveLength(1);
    expect(container.lastElementChild?.getAttribute('data-dce')).toBe('row-btn');
  });

  it('markup without li rows works too: a rebuilt container is found through the nearest area that holds a row link', async () => {
    const row = (id: string): string =>
      `<div class="interactive_f88cfd"><a data-list-item-id="private-channels-uid_1___${id}" href="/channels/@me/${id}"><div class="name__20a53">x</div></a>` +
      `<div class="iconsContainer__972a0"><div class="${DM_CLOSE_CLASS}" role="button"><div><svg class="${DM_CLOSE_SVG_CLASS}" width="16" height="16"></svg></div></div></div></div>`;
    ctx = await boot({ html: `<div id="list">${row(ID.dm)}</div>` });
    expect(allButtons()).toHaveLength(1);
    const old = document.querySelector('.iconsContainer__972a0')!;
    const fresh = old.cloneNode(true) as HTMLElement;
    fresh.querySelector('[data-dce]')?.remove();
    old.replaceWith(fresh);
    await ctx.frame();
    expect(allButtons()).toHaveLength(1);
    expect(fresh.querySelector('[data-dce]')).not.toBeNull();
  });

  it('stale buttons of an earlier run are removed when the injector starts', async () => {
    const stale = '<div data-dce="row-btn" data-dce-key="123"></div>';
    mount(sidebar(channelRow({ id: ID.general, name: 'general' })) + stale);
    ctx = await boot({});
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([ID.general]);
  });

  it('our own nodes never cause a new pass (no feedback loop), neither the buttons nor the toast and tooltip', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    expect(ctx.scheduler.pending).toBe(0);
    ctx.app.toast.show('success', 'hello');
    ctx.app.tooltip.show(byKey(ID.general)!);
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(0);
  });

  it('one pass per animation frame, however many mutations arrive', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const list = document.querySelector('ul')!;
    for (let i = 0; i < 20; i++) list.insertAdjacentHTML('beforeend', `<li class="x"><div>noise ${i}</div></li>`);
    list.insertAdjacentHTML('beforeend', channelRow({ id: ID.random, name: 'random' }));
    await ctx.settle();
    expect(ctx.scheduler.pending).toBe(1);
    expect(byKey(ID.random)).toBeNull(); // nothing before the frame
    ctx.scheduler.run();
    expect(byKey(ID.random)).not.toBeNull();
  });
});

describe('virtualised lists', () => {
  it('rows that scroll away take their buttons along; rows that come in get new ones', async () => {
    ctx = await boot({
      html: sidebar(
        channelRow({ id: ID.general, name: 'general' }),
        channelRow({ id: ID.random, name: 'random' }),
        channelRow({ id: ID.voice, name: 'lounge', voice: true }),
      ),
    });
    expect(allButtons()).toHaveLength(3);
    const list = document.querySelector('ul')!;
    list.firstElementChild!.remove(); // "general" scrolls out
    list.insertAdjacentHTML('beforeend', channelRow({ id: ID.forum, name: 'ideas' })); // "ideas" scrolls in
    await ctx.frame();
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([ID.random, ID.voice, ID.forum]);
  });

  it('a server switch (the whole list is replaced) is rebuilt', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const other = '200000000000000099';
    document.querySelector('nav')!.innerHTML = `<ul aria-label="Channels">${categoryRow({ id: ID.categoryB, name: 'B' })}${channelRow({ id: other, name: 'other' })}</ul>`;
    await ctx.frame();
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([ID.categoryB, other]);
  });

  it('a row element that Discord recycles for another channel (link attributes change in place) follows the new id', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })), queue: [ID.random] });
    expect(byKey(ID.general)!.getAttribute('data-dce-state')).toBe('idle');
    const link = document.querySelector('a[data-list-item-id]')!;
    link.setAttribute('data-list-item-id', `channels___${ID.random}`);
    link.setAttribute('href', `/channels/${GUILD}/${ID.random}`);
    await ctx.frame();
    const button = byKey(ID.random)!;
    expect(button).not.toBeNull();
    expect(byKey(ID.general)).toBeNull();
    expect(button.getAttribute('data-dce-state')).toBe('queued'); // looked up by the new id
    expect(allButtons()).toHaveLength(1);
  });

  it('a detached row that was still pending is skipped without error', async () => {
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' })) });
    const list = document.querySelector('ul')!;
    list.insertAdjacentHTML('beforeend', channelRow({ id: ID.random, name: 'random' }));
    await ctx.settle();
    list.lastElementChild!.remove(); // gone before the frame
    expect(() => ctx!.scheduler.run()).not.toThrow();
    expect(allButtons().map((b) => b.getAttribute('data-dce-key'))).toEqual([ID.general]);
  });

  it('pages without any row (chat messages, noise) cost nothing and report nothing', async () => {
    ctx = await boot({ html: '<div id="chat"></div>' });
    document.getElementById('chat')!.insertAdjacentHTML('beforeend', '<ol><li data-list-item-id="chat-messages___a-b"><div class="children__2ea32"></div></li></ol>');
    await ctx.frame();
    expect(allButtons()).toEqual([]);
    expect(ctx.chrome.sent).toEqual([]);
  });
});

describe('state of the buttons', () => {
  it('queued rows show the check and the "remove" label; the others the arrow and the "add" label', async () => {
    ctx = await boot({
      html: sidebar(channelRow({ id: ID.general, name: 'general' }), channelRow({ id: ID.random, name: 'random' })),
      queue: [ID.general],
    });
    const queued = byKey(ID.general)!;
    const idle = byKey(ID.random)!;
    expect(queued.getAttribute('data-dce-state')).toBe('queued');
    expect(queued.getAttribute('aria-label')).toBe('다운로드 목록에서 빼기');
    expect(idle.getAttribute('data-dce-state')).toBe('idle');
    expect(idle.getAttribute('aria-label')).toBe('다운로드 목록에 추가');
    expect(queued.querySelector('path')?.getAttribute('d')).not.toBe(idle.querySelector('path')?.getAttribute('d'));
  });

  describe('the cross that a checked button shows on hover (pure CSS: both glyphs are in the DOM, the state attribute decides)', () => {
    const page = (): string =>
      sidebar(
        categoryRow({ id: ID.categoryA, name: 'Category A' }),
        channelRow({ id: ID.general, name: 'general', threads: [threadRow({ id: ID.thread, name: 'thread' })] }),
        channelRow({ id: ID.voice, name: 'lounge', voice: true }),
        channelRow({ id: ID.forum, name: 'ideas', icons: '<div class="forumCount__2ea32">3</div>' }), // no native icon: the cache / fallback look
        dmRow({ id: ID.dm, name: 'Alex' }),
      );
    const ids = [ID.categoryA, ID.general, ID.voice, ID.thread, ID.forum, ID.dm];
    const paths = (button: HTMLElement, name: string): Element[] => Array.from(button.querySelectorAll(`path[data-dce-glyph="${name}"]`));

    it('every kind of button (channel, voice, thread, forum, category, DM) has one state glyph and one cross, size unchanged', async () => {
      ctx = await boot({ html: page() });
      expect(allButtons()).toHaveLength(ids.length);
      for (const id of ids) {
        const button = byKey(id)!;
        expect(paths(button, 'state'), id).toHaveLength(1);
        expect(paths(button, 'remove'), id).toHaveLength(1);
        expect(button.querySelectorAll('path'), id).toHaveLength(2);
        expect(button.querySelector('path'), id).toBe(paths(button, 'state')[0]); // the state glyph comes first
        const svg = button.querySelector('svg')!;
        expect(svg.getAttribute('width'), id).toBe('16');
        expect(svg.getAttribute('height'), id).toBe('16');
        expect(button.getAttribute('data-dce-state'), id).toBe('idle'); // not checked: the stylesheet never swaps these
      }
    });

    it('the state decides which glyph the attribute-keyed CSS can reveal: the state glyph follows the list, the cross never changes', async () => {
      ctx = await boot({ html: page(), queue: [ID.general, ID.dm], groups: { [ID.categoryA]: [ID.general] } });
      for (const id of ids) {
        const button = byKey(id)!;
        const checked = [ID.general, ID.dm, ID.categoryA].includes(id as never);
        expect(button.getAttribute('data-dce-state'), id).toBe(checked ? 'queued' : 'idle');
        expect(currentIcon(button), id).toBe(checked ? 'check' : 'download'); // the STATE icon, hover or not
        expect(paths(button, 'state')[0]!.getAttribute('d'), id).toBe(checked ? CHECK_PATH : DOWNLOAD_PATH);
        expect(paths(button, 'remove')[0]!.getAttribute('d'), id).toBe(REMOVE_PATH);
      }
    });

    it('a button that toggles keeps its svg and both glyph nodes (no DOM churn under the pointer)', async () => {
      ctx = await boot({ html: page(), queue: [ID.general] });
      const button = byKey(ID.general)!;
      const svg = button.querySelector('svg')!;
      const [state, remove] = [paths(button, 'state')[0]!, paths(button, 'remove')[0]!];
      ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
      await ctx.settle();
      expect(byKey(ID.general)).toBe(button);
      expect(button.getAttribute('data-dce-state')).toBe('idle');
      expect(button.querySelector('svg')).toBe(svg);
      expect(paths(button, 'state')[0]).toBe(state);
      expect(paths(button, 'remove')[0]).toBe(remove);
      expect(state.getAttribute('d')).toBe(DOWNLOAD_PATH);
      ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [{ key: ID.general }] });
      await ctx.settle();
      expect(button.getAttribute('data-dce-state')).toBe('queued');
      expect(paths(button, 'state')[0]).toBe(state);
      expect(state.getAttribute('d')).toBe(CHECK_PATH);
      expect(button.querySelectorAll('path')).toHaveLength(2);
    });

    it('the DM wrapper is rebuilt with both glyphs, and a checked state survives the rebuild', async () => {
      ctx = await boot({ html: page(), queue: [ID.dm] });
      const button = byKey(ID.dm)!;
      expect(button.firstElementChild?.tagName).toBe('DIV'); // closeButton > div > svg
      expect(button.querySelector('div > svg')).not.toBeNull();
      expect(currentIcon(button)).toBe('check');
      // Discord replaces the close button's content: the next pass re-applies our look (the wrapper goes, comes back).
      button.replaceChildren();
      ctx.app.injector.requestFullScan();
      await ctx.frame();
      const again = byKey(ID.dm)!;
      expect(again.querySelectorAll('path')).toHaveLength(2);
      expect(paths(again, 'remove')).toHaveLength(1);
      expect(currentIcon(again)).toBe('check');
      expect(again.getAttribute('data-dce-state')).toBe('queued');
    });
  });

  it('English labels when the page language is not Korean', async () => {
    document.documentElement.lang = 'en-US';
    ctx = await boot({ html: sidebar(channelRow({ id: ID.general, name: 'general' }), categoryRow({ id: ID.categoryA, name: 'A' })) });
    expect(byKey(ID.general)!.getAttribute('aria-label')).toBe('Add to download list');
    expect(byKey(ID.categoryA)!.getAttribute('aria-label')).toBe('Add every channel in this category');
  });
});

describe('the check state of category buttons (PLAN §2: checked iff every channel of the group is in the list)', () => {
  const page = (): string =>
    sidebar(
      categoryRow({ id: ID.categoryA, name: 'Category A' }),
      channelRow({ id: ID.general, name: 'general' }),
      channelRow({ id: ID.random, name: 'random' }),
    );
  const stateOf = (): string | null => byKey(ID.categoryA)!.getAttribute('data-dce-state');
  const iconOf = (button: HTMLElement): string | null => button.querySelector('path')!.getAttribute('d');

  it('unchecked: the arrow and the "add" label; checked: the check mark and the "remove" label', async () => {
    ctx = await boot({ html: page(), queue: [ID.general, ID.random], groups: { [ID.categoryA]: [ID.general, ID.random] } });
    const checked = byKey(ID.categoryA)!;
    expect(checked.getAttribute('data-dce-state')).toBe('queued');
    expect(checked.getAttribute('aria-label')).toBe('이 카테고리 채널 전부 빼기');
    expect(iconOf(checked)).toBe(CHECK_PATH);
    ctx.app.destroy();

    document.body.innerHTML = '';
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [ID.categoryA]: [ID.general, ID.random] } });
    const partial = byKey(ID.categoryA)!;
    expect(partial.getAttribute('data-dce-state')).toBe('idle');
    expect(partial.getAttribute('aria-label')).toBe('이 카테고리 채널 전부 추가');
    expect(iconOf(partial)).toBe(DOWNLOAD_PATH);
  });

  it('English labels follow the state', async () => {
    document.documentElement.lang = 'en';
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [ID.categoryA]: [ID.general] } });
    expect(byKey(ID.categoryA)!.getAttribute('aria-label')).toBe('Remove every channel in this category');
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
    await ctx.settle();
    expect(byKey(ID.categoryA)!.getAttribute('aria-label')).toBe('Add every channel in this category');
  });

  it('a category with no known group is not checked, however full the list is', async () => {
    ctx = await boot({ html: page(), queue: [ID.general, ID.random, ID.categoryA] });
    expect(stateOf()).toBe('idle');
  });

  it('the force class and the look are the same in both states', async () => {
    ctx = await boot({ html: page(), queue: [ID.general], groups: { [ID.categoryA]: [ID.general] } });
    expect(byKey(ID.categoryA)!.classList.contains(FORCE_CLASS)).toBe(true);
    ctx.chrome.set({ [LOCAL.queue(ACCOUNT.id)]: [] });
    await ctx.settle();
    expect(byKey(ID.categoryA)!.classList.contains(FORCE_CLASS)).toBe(true);
  });
});
