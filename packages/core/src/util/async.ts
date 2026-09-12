/** Cancellation and waiting primitives. Every long-running bot operation takes a token. */

export class CancellationError extends Error {
  constructor(message = 'Operation was cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class CancellationToken {
  private cancelled = false;
  private readonly callbacks = new Set<() => void>();

  /** A token that is never cancelled, for fire-and-forget calls. */
  static readonly none = new CancellationToken();

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** @internal used by {@link CancellationSource} */
  _cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const cb of [...this.callbacks]) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
    this.callbacks.clear();
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new CancellationError();
  }

  onCancel(cb: () => void): () => void {
    if (this.cancelled) {
      cb();
      return () => {};
    }
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }
}

export class CancellationSource {
  readonly token = new CancellationToken();
  cancel(): void {
    this.token._cancel();
  }
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Clock indirection so tests can run bot loops without real time passing. */
export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Cancellable sleep. Rejects with {@link CancellationError} if the token trips first. */
export function sleep(
  ms: number,
  token: CancellationToken = CancellationToken.none,
  clock: Clock = systemClock,
): Promise<void> {
  if (token.isCancelled) return Promise.reject(new CancellationError());
  // Always go through a timer, even for 0ms. Resolving synchronously would
  // keep a zero-delay bot loop entirely in microtasks, starving timers and
  // input handling - the loop would spin forever and freeze the host UI.
  return new Promise<void>((resolve, reject) => {
    const handle = clock.setTimeout(() => {
      offCancel();
      resolve();
    }, Math.max(0, ms));
    const offCancel = token.onCancel(() => {
      clock.clearTimeout(handle);
      reject(new CancellationError());
    });
  });
}

export interface WaitOptions {
  /**
   * Give up after this many milliseconds. 0 checks the predicate exactly once
   * and returns; pass `Infinity` to wait indefinitely.
   */
  timeoutMs?: number;
  /** How often to re-test the predicate. */
  intervalMs?: number;
  token?: CancellationToken;
  clock?: Clock;
  /** Throw {@link TimeoutError} instead of resolving false when time runs out. */
  throwOnTimeout?: boolean;
  /** Included in the timeout message to make script failures diagnosable. */
  label?: string;
}

/**
 * Poll `predicate` until it returns true. Resolves true on success, false on
 * timeout (or throws when `throwOnTimeout` is set).
 */
export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  options: WaitOptions = {},
): Promise<boolean> {
  const {
    timeoutMs = 15_000,
    intervalMs = 100,
    token = CancellationToken.none,
    clock = systemClock,
    throwOnTimeout = false,
    label = 'condition',
  } = options;

  const deadline = clock.now() + Math.max(0, timeoutMs);
  for (;;) {
    token.throwIfCancelled();
    if (await predicate()) return true;
    if (clock.now() >= deadline) {
      if (throwOnTimeout) throw new TimeoutError(`Timed out after ${timeoutMs}ms waiting for ${label}`);
      return false;
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - clock.now())), token, clock);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
