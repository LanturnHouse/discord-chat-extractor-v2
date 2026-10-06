/**
 * Lifetime of the offscreen document that hosts the download engine (docs/PLAN.md §3, reason BLOBS): created for a job,
 * closed when no job runs and every blob download it served has settled (downloads.ts decides when).
 *
 * There can be only one offscreen document per extension, so `ensureOffscreen` checks with `chrome.runtime.getContexts`
 * first and serialises with `offscreenLock`. A freshly created document announces itself with `engine/ready` once its
 * message listener exists; that message can arrive BEFORE `chrome.offscreen.createDocument` resolves, so the wait is set up
 * first.
 */
import type { ToOffscreen } from '@/shared';
import { createMutex, describeError, isRecord } from './util';

export const OFFSCREEN_PATH = 'offscreen.html';
export const READY_TIMEOUT_MS = 10_000;
const JUSTIFICATION = 'Builds the export files (Blob objects) and hands them to the downloads API.';

/** Serialises creating and closing the document, and every check made right before closing it. Lock order: see store.ts. */
export const offscreenLock = createMutex();

const readyWaiters = new Set<() => void>();

/** `engine/ready` arrived: wake everyone waiting for a new document to come up. */
export function notifyEngineReady(): void {
  const waiters = [...readyWaiters];
  readyWaiters.clear();
  for (const wake of waiters) wake();
}

interface ReadyWait {
  promise: Promise<void>;
  cancel(): void;
}

function waitForEngineReady(timeoutMs: number): ReadyWait {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters.delete(wake);
      reject(new Error('The download engine did not start in time.'));
    }, timeoutMs);
    const wake = (): void => {
      clearTimeout(timer);
      resolve();
    };
    readyWaiters.add(wake);
    release = () => {
      clearTimeout(timer);
      readyWaiters.delete(wake);
      resolve();
    };
  });
  promise.catch(() => undefined); // a timeout while createDocument is still pending must not surface as an unhandled rejection
  return { promise, cancel: () => release() };
}

/**
 * Is there an offscreen document of this extension right now? (`chrome.runtime.getContexts`, Chrome 116+.) An extension can
 * have only one, so the context type is the whole filter: matching its URL as well would only add a way to get it wrong.
 */
export async function offscreenExists(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

/**
 * Makes sure an offscreen document with a listening engine exists. An existing document is reused (it announced itself when
 * it was created); a new one is awaited until `engine/ready`, at most 10 s. Throws when the document cannot be created or
 * does not come up (and closes a document that did not).
 */
export function ensureOffscreen(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  return offscreenLock.run(async () => {
    if (await offscreenExists()) return;
    const ready = waitForEngineReady(timeoutMs);
    try {
      await chrome.offscreen.createDocument({ url: OFFSCREEN_PATH, reasons: ['BLOBS'], justification: JUSTIFICATION });
    } catch (error) {
      ready.cancel();
      if (await offscreenExists()) return; // lost a race with another creation: the document is there
      throw new Error(`Could not create the download engine: ${describeError(error)}`);
    }
    try {
      await ready.promise;
    } catch (error) {
      await chrome.offscreen.closeDocument().catch(() => undefined);
      throw error;
    }
  });
}

/** Closes the offscreen document if there is one. Callers decide when that is safe (see downloads.ts `settleAndClose`). */
export async function closeOffscreenDocument(): Promise<void> {
  if (await offscreenExists()) await chrome.offscreen.closeDocument();
}

/** Sends an engine command and requires the engine's acknowledgement (`{ ok: true }`). Throws when nobody answers. */
export async function sendToOffscreen(message: ToOffscreen): Promise<void> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (error) {
    throw new Error(`The download engine is not reachable: ${describeError(error)}`);
  }
  if (!isRecord(response) || response.ok !== true) throw new Error('The download engine did not accept the message.');
}
