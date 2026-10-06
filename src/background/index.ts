// MV3 service worker entry (bundled as one un-hashed ES module file: background.js, no imports of other chunks).
//
// EVERY chrome event listener is registered here, synchronously, at the top level: Chrome only wakes a suspended worker
// for listeners that exist when its script first runs. The logic lives in the modules next to this file:
//   token.ts     capture of the Authorization value of Discord's own requests (v1 module) + compare-and-clear
//   account.ts   whose token is it (GET users/@me)             queue.ts      the download list of the current account
//   guild.ts     channels of a guild the account may read      status.ts     status/get and settings/patch
//   router.ts    message routing and sender checks
//   jobs.ts     job start / cancel / finish / recovery        engine.ts     messages of the offscreen download engine
//   downloads.ts chrome.downloads + blob URL cleanup           offscreen.ts  offscreen document lifetime
//   badge.ts     toolbar badge        notify.ts   completion notification  commands.ts  keyboard shortcut
import { SESSION } from '@/shared';
import { onTokenChanged } from './account';
import { affectsBadge, refreshBadge } from './badge';
import { handleCommand } from './commands';
import { startDevReload } from './devReload';
import { onDownloadChanged } from './downloads';
import { removeHealth } from './health';
import { startBootstrap } from './lifecycle';
import { onNotificationActivated } from './notify';
import { onMessage } from './router';
import { createTokenCapture, DISCORD_API_URL_PATTERNS } from './token';

// Development builds only: reload the extension (and the open Discord tabs) when `npm run dev` rebuilds dist/.
// `__DEV__` is replaced at build time, so production bundles contain neither this call nor devReload.ts.
if (__DEV__) {
  startDevReload();
}

const capture = createTokenCapture({ storage: chrome.storage.session, now: Date.now });

// Read-only observation of the page's own API traffic: no 'blocking', the request is never touched.
// 'extraHeaders' is required for Chrome to include headers such as Authorization in `requestHeaders`.
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    void capture.handle(details);
    return undefined;
  },
  { urls: DISCORD_API_URL_PATTERNS, types: ['xmlhttprequest'] },
  ['requestHeaders', 'extraHeaders'],
);

chrome.storage.onChanged.addListener((changes, areaName) => {
  capture.onStorageChanged(changes, areaName); // a token removed behind our back is captured again
  const token = changes[SESSION.token];
  if (areaName === 'session' && token !== undefined) onTokenChanged(token.newValue); // a new value: whose is it?
  if (affectsBadge(changes, areaName)) void refreshBadge();
});

chrome.runtime.onMessage.addListener(onMessage);

// Starting the worker for these two is what makes the start-up work (job recovery, badge) run after a browser start / update.
chrome.runtime.onStartup.addListener(() => void startBootstrap());
chrome.runtime.onInstalled.addListener(() => void startBootstrap());

chrome.downloads.onChanged.addListener((delta) => void onDownloadChanged(delta).catch(() => undefined));

chrome.notifications.onClicked.addListener((id) => void onNotificationActivated(id).catch(() => undefined));
chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
  if (buttonIndex === 0) void onNotificationActivated(id).catch(() => undefined); // the only button: "open folder"
});

chrome.commands.onCommand.addListener((command, tab) => void handleCommand(command, tab).catch(() => undefined));

chrome.tabs.onRemoved.addListener((tabId) => void removeHealth(tabId).catch(() => undefined));

void startBootstrap();
