// Offscreen document entry (offscreen.html, reason BLOBS): the download engine runs here.
//
// The host (host.ts) does the messaging with the background worker, blob URLs and keep-alive; the engine behind it is an
// `EngineRunner` (runner.ts documents the contract): the real pipeline of engine/ (docs/PLAN.md §6). The placeholder of step A1
// stays in stubEngine.ts for the tests of the background.
import { createEngineRunner } from './engine';
import { startOffscreenHost } from './host';

startOffscreenHost({ runtime: chrome.runtime, runner: createEngineRunner() });
