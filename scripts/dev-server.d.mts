// Types for the tests that import scripts/dev-server.mjs (the script itself stays plain JavaScript so `node` runs it as is).
import type { Server } from 'node:http';

export const DEV_SERVER_PORT: number;
export const TRACKED_FILES: readonly string[];
export const SETTLE_MS: number;
export const PARENT_CHECK_MS: number;
export function snapshotBuild(distDir: string): { complete: false } | { complete: true; id: string; newestMtimeMs: number };
export function createBuildIdProvider(options?: { distDir?: string; settleMs?: number; now?: () => number }): () => string | null;
export function createDevServer(options?: { getBuildId?: () => string | null }): Server;
export function startDevServer(options?: {
  port?: number;
  host?: string;
  getBuildId?: () => string | null;
}): Promise<Server>;
export function watchParent(options: {
  onGone: () => void;
  ppid?: number;
  intervalMs?: number;
  kill?: (pid: number, signal: 0) => unknown;
}): () => void;
