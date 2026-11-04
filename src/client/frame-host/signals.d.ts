// Types for signals.js (plain JS: it serves into frames like bridge.js).
export const FRAME_BUDGET: { perSecond: number; perDoc: number; countsMs: number }
export const RESOURCE_TAGS: string[]
export function documentRecords(search?: string): boolean
export function periodMs(): number
export function formatConsole(args: readonly unknown[], max?: number): string
export function stackOfArgs(args: readonly unknown[]): string[] | undefined
export function viteEcho(args: readonly unknown[]): boolean
export function resourceUrl(raw: string, base?: string): string
export function resourceOf(target: unknown, base?: string): { tag: string; url: string } | null
export function createBudget<S extends string>(limits: { perSecond: number; perDoc: number }, refused: (source: S) => void, now?: () => number): { take(source: S, force?: boolean): boolean }
export function createCounter(ms: number, send: (counts: Record<string, number>, final: boolean) => void, now?: () => number): { add(key: string, n?: number): void; final(): void }
export function onConsoleError(fn: (args: unknown[]) => void): () => void
export function startDocumentSignals(o: { post: (msg: Record<string, unknown>) => void; id: string; gen: string; boot: string }): { take(source: 'frame' | 'console' | 'resource', force?: boolean): boolean } | null
export function frameRenders(post: (msg: Record<string, unknown>) => void, id: string, getBoot: () => string | undefined): ((id: string, phase: string, actualDuration: number) => void) | null
