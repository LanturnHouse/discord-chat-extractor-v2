// Types for the tests that import scripts/verify-dist.mjs (the script itself stays plain JavaScript so `node` runs it as is).
export function parseCsp(csp: string): Map<string, string[]>;
export function cspProblems(csp: unknown, options?: { dev?: boolean }): string[];
export function isDevManifest(manifest: unknown): boolean;
export function leadingImports(code: string): string[];
export function dynamicImports(code: string): string[];
export function importSpecifiers(code: string): { specifiers: string[]; hasDynamicNonLiteral: boolean };
export function verifyDist(options?: { distDir?: string; rootDir?: string }): { problems: string[]; notes: string[] };
