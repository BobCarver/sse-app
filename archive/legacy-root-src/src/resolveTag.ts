import type { Scores } from "./types.ts";

// ============================================================================
// TYPE-SAFE TAG SYSTEM
// ============================================================================

/**
 * Define all possible tag patterns and their payload types
 * This ensures type safety when waiting for and resolving tags
 */
export interface TagPayloads {
  // Client connection tags - payload is undefined (just a signal)
  [key: `required:${string}`]: undefined;

  // Performance completion tags - payload is boolean (played vs skipped)
  [key: `perf:${string}:${string}`]: boolean; // perf:competitionId:position

  // Score submission tags - payload is the full score submission
  [key: `score:${string}:${string}:${string}`]: Scores; // score:competitionId:position:judgeId
}

/**
 * Extract the tag string literal type from TagPayloads
 */
export type TagKey = keyof TagPayloads;

/**
 * Get the payload type for a specific tag based on its pattern
 */
export type PayloadForTag<T extends string> = T extends `required:${string}`
  ? undefined
  : T extends `perf:${string}:${string}` ? boolean
  : T extends `score:${string}:${string}:${string}` ? Scores
  : never;

// ============================================================================
// RESOLVER REGISTRY
// ============================================================================

/**
 * Internal resolver storage - uses string keys at runtime but typed externally
 */
export const resolvers = new Map<string, (payload: unknown) => void>();

// ============================================================================
// TYPE-SAFE API
// ============================================================================

/**
 * Wait for a tag to be resolved
 * @param tag - The tag to wait for (type-checked against TagPayloads)
 * @param timeOut - Optional timeout in milliseconds (0 = no timeout)
 * @returns Promise that resolves with the correctly-typed payload
 *
 * @example
 * // Wait for client 5 to connect (payload: undefined)
 * await waitForTag('required:5');
 *
 * // Wait for performance completion (payload: boolean)
 * const played = await waitForTag('perf:10:2');
 *
 * // Wait for score submission (payload: ScoreSubmission)
 * const submission = await waitForTag('score:10:2:5', 30000);
 */
export function waitForTag<T extends TagKey>(
  tag: T,
  timeOut: number = 0,
): Promise<PayloadForTag<T>> {
  let timer: number | undefined = undefined;

  return new Promise<PayloadForTag<T>>((resolve, reject) => {
    resolvers.set(tag, (payload) => {
      resolve(payload as PayloadForTag<T>);
    });

    if (timeOut > 0) {
      timer = setTimeout(() => {
        resolvers.delete(tag);
        reject(new Error(`Timeout waiting for tag: ${tag}`));
      }, timeOut);
    }
  }).finally(() => {
    resolvers.delete(tag);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

/**
 * Resolve a tag with a payload
 * @param tag - The tag to resolve (type-checked against TagPayloads)
 * @param payload - The payload to send (type-checked against tag's expected type)
 *
 * @example
 * // Resolve client connection
 * resolveTag('required:5', undefined);
 *
 * // Resolve performance completion
 * resolveTag('perf:10:2', true);
 *
 * // Resolve score submission
 * resolveTag('score:10:2:5', { competition_id: 10, competitor_id: 2, judge_id: 5, scores: [...] });
 */
export function resolveTag<T extends TagKey>(
  tag: T,
  payload: PayloadForTag<T>,
): void {
  const resolver = resolvers.get(tag);

  if (resolver) {
    resolvers.delete(tag);
    resolver(payload);
  } else {
    console.warn(`resolveTag: no resolver waiting for tag "${tag}"`);
  }
}

/**
 * Check if anyone is waiting for a specific tag
 * Useful for debugging
 */
export function hasWaiter(tag: TagKey): boolean {
  return resolvers.has(tag);
}

/**
 * Get all currently pending tags
 * Useful for debugging
 */
export function getPendingTags(): string[] {
  return Array.from(resolvers.keys());
}

/**
 * Clear all pending resolvers
 * Use with caution - typically only needed for testing or shutdown
 */
export function clearAllResolvers(): void {
  const count = resolvers.size;
  resolvers.clear();
  if (count > 0) {
    console.warn(`Cleared ${count} pending resolvers`);
  }
}

// Debug helper: expose pending tags to devtools consoles when attached
// (temporary - intended for developer debugging)
if ((globalThis as any).__getPendingTags === undefined) {
  (globalThis as any).__getPendingTags = () => Array.from(resolvers.keys());
}
