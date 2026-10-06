/** The types the engine's modules share: what can be injected, and what one chat leaves behind. */
import type { ChatError, DiscordClient, LiveDiscordClientOptions, exportChat } from '@/lib';

/** Everything with a side effect that the engine reaches for; tests replace these (see tests/offscreen/engine/kit.ts). */
export interface EngineDeps {
  /**
   * Builds the Discord client of one job. It gets the options the engine needs (`getAuthorization`, `onAuthError`, `onPause`,
   * `onResume`). Default: the live client over `createFetchTransport()`.
   */
  createClient?: (options: LiveDiscordClientOptions) => DiscordClient;
  /** Exports one chat. Default: the library's `exportChat`. */
  exportChat?: typeof exportChat;
  /** Downloads an attachment into the ZIP. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Waits (the pause between two chats, the waits of the thread search). Default: a real, abortable timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Randomness of the pause between two chats, [0, 1). Default `Math.random`. */
  random?: () => number;
  /** Epoch ms. Default `Date.now`. */
  now?: () => number;
  /** Ids of the history entries. Default `crypto.randomUUID`. */
  newId?: () => string;
  /** Lower limits for the ZIP of a job (the limits of a plain ZIP apply when left out): lets the tests fill an archive. */
  zipLimits?: { maxEntries?: number; maxInputBytes?: number };
  /** Progress updates that only change a count (not a phase or a status) go out at most this often. Default 250 ms (4 a second). */
  progressIntervalMs?: number;
}

export type ResolvedDeps = Required<Omit<EngineDeps, 'zipLimits'>> & Pick<EngineDeps, 'zipLimits'>;

/** A file of a chat: where it was saved (a path below the downloads folder, or inside the ZIP) and Chrome's id of its download. */
export interface SavedFile {
  filename: string;
  /** null for what lives inside a ZIP (only the archive itself is a download). */
  downloadId: number | null;
}

/** What the saving step did with the files of one chat (the same shape in individual-file and ZIP mode). */
export interface SaveReport {
  /** Files `exportChat` produced for the chat. */
  outputs: number;
  /** ...of which reached the disk (individual) or the archive (ZIP). */
  savedOutputs: number;
  /** The files that were saved: outputs first, then attachments. */
  files: SavedFile[];
  /** Why the first output could not be saved. */
  outputError: ChatError | null;
  /** Attachments that could not be saved (the chat itself is fine). */
  attachmentsMissed: number;
  /** The ZIP ran full while the attachments were added. */
  limitError: ChatError | null;
}

/** How one chat ended (cancelled chats have no outcome: they are reported as cancelled and leave nothing behind). */
export interface ItemOutcome {
  status: 'done' | 'partial' | 'failed';
  /** Messages in the files that were saved. */
  messageCount: number;
  /** Newest exported message id: only a `done` chat has one (null: nothing new, or not done), so it is the incremental marker as it stands. */
  lastMessageId: string | null;
  files: SavedFile[];
  /** The first thing that went wrong, in the language of the job; for `done` a note about attachments that were left out. */
  error: ChatError | null;
  /** ZIP mode: the chat's files are in the archive, so the chat only counts as saved once the archive is. */
  inArchive: boolean;
}
