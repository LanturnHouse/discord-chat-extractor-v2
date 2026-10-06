// Types for the tests that import scripts/pack.mjs (the script itself stays plain JavaScript so `node` runs it as is).
export class PackError extends Error {}
export function packDist(options?: { rootDir?: string; distDir?: string }): { zipPath: string; fileCount: number; bytes: number };
