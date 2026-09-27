import { TypedEmitter } from '@dfh/core';
import { DF_GAME_BASE_URL } from './ruffle-types.js';

/**
 * One request/response pair the game exchanged with its server.
 *
 * Bodies are kept as text because everything DragonFable's client sends and
 * receives is text: URL-encoded form posts and XML or key=value replies.
 */
export interface CapturedExchange {
  id: number;
  url: string;
  method: string;
  requestBody: string | null;
  status: number;
  ok: boolean;
  contentType: string | null;
  responseBody: string | null;
  startedAt: number;
  durationMs: number;
  /** Set when the fetch itself failed (network error), not a non-2xx status. */
  error?: string;
}

export interface NetworkTapEvents {
  /** A request finished (successfully or not) and its bodies are available. */
  exchange: CapturedExchange;
}

export interface NetworkTapOptions {
  /** Which URLs to record. Defaults to game-server calls, excluding assets. */
  filter?: (url: string) => boolean;
  /** Longest body kept per exchange; longer bodies are truncated. */
  maxBodyLength?: number;
  /** Ring buffer size for {@link NetworkTap.history}. */
  historySize?: number;
  /** The object whose `fetch` is wrapped. `window` in the app; a fake in tests. */
  target?: { fetch: typeof fetch };
  clock?: () => number;
}

/** File types the loader streams that are never worth reading as text. */
const ASSET_EXTENSIONS = /\.(swf|png|jpe?g|gif|mp3|wav|ogg|woff2?|ttf|wasm)(\?|$)/i;

/**
 * Record calls to the game host that are not plain asset downloads.
 *
 * `Request.url` is always absolute, so a string that does not parse on its
 * own is not something the game sent and is ignored.
 */
export function defaultTapFilter(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.host === new URL(DF_GAME_BASE_URL).host && !ASSET_EXTENSIONS.test(parsed.pathname);
}

/**
 * Observes every HTTP request the running SWF makes.
 *
 * Ruffle performs the movie's `loadVars` / `URLLoader` traffic through the
 * page's own `window.fetch`, so replacing that one function before the
 * player is created sees the whole conversation between DragonFable's client
 * and its server - the same way on desktop and Android, with no native code.
 * Server replies are where the authoritative character data lives, which is
 * what makes this the bridge's primary source of state.
 *
 * The wrapper never delays or alters the game's request: bodies are read from
 * clones, and the original response object is handed straight back.
 */
export class NetworkTap {
  readonly events = new TypedEmitter<NetworkTapEvents>();

  private filter: (url: string) => boolean;
  private readonly maxBodyLength: number;
  private readonly historySize: number;
  private readonly target: { fetch: typeof fetch };
  private readonly clock: () => number;

  private original: typeof fetch | null = null;
  private nextId = 1;
  private buffer: CapturedExchange[] = [];

  constructor(options: NetworkTapOptions = {}) {
    this.filter = options.filter ?? defaultTapFilter;
    this.maxBodyLength = options.maxBodyLength ?? 256 * 1024;
    this.historySize = options.historySize ?? 200;
    this.target = options.target ?? (globalThis as unknown as { fetch: typeof fetch });
    this.clock = options.clock ?? (() => Date.now());
  }

  get installed(): boolean {
    return this.original !== null;
  }

  /** Change which URLs are recorded, e.g. to widen it while diagnosing. */
  setFilter(filter: (url: string) => boolean): void {
    this.filter = filter;
  }

  /** Exchanges seen so far, oldest first. */
  get history(): readonly CapturedExchange[] {
    return this.buffer;
  }

  /** Replace `fetch` with the observing wrapper. Safe to call twice. */
  install(): void {
    if (this.original) return;
    const original = this.target.fetch;
    this.original = original;
    const target = this.target;

    const wrapped: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!this.filter(request.url)) {
        return original.call(target, request);
      }

      const startedAt = this.clock();
      const requestBody = await this.readBody(request.method === 'GET' || request.method === 'HEAD' ? null : request.clone());

      let response: Response;
      try {
        response = await original.call(target, request);
      } catch (error) {
        this.record({
          id: this.nextId++,
          url: request.url,
          method: request.method,
          requestBody,
          status: 0,
          ok: false,
          contentType: null,
          responseBody: null,
          startedAt,
          durationMs: this.clock() - startedAt,
          error: (error as Error).message,
        });
        throw error;
      }

      const contentType = response.headers.get('content-type');
      const durationMs = this.clock() - startedAt;
      // Read from a clone so the game still gets an unconsumed body.
      void this.readBody(response.clone(), contentType).then((responseBody) => {
        this.record({
          id: this.nextId++,
          url: request.url,
          method: request.method,
          requestBody,
          status: response.status,
          ok: response.ok,
          contentType,
          responseBody,
          startedAt,
          durationMs,
        });
      });
      return response;
    };

    this.target.fetch = wrapped;
  }

  /** Put the original `fetch` back. */
  uninstall(): void {
    if (!this.original) return;
    this.target.fetch = this.original;
    this.original = null;
  }

  clear(): void {
    this.buffer = [];
  }

  private async readBody(source: Request | Response | null, contentType?: string | null): Promise<string | null> {
    if (!source) return null;
    if (contentType && /^(image|audio|video|font)\//i.test(contentType)) return null;
    try {
      const text = await source.text();
      return text.length > this.maxBodyLength ? text.slice(0, this.maxBodyLength) : text;
    } catch {
      return null;
    }
  }

  private record(exchange: CapturedExchange): void {
    this.buffer.push(exchange);
    if (this.buffer.length > this.historySize) {
      this.buffer.splice(0, this.buffer.length - this.historySize);
    }
    this.events.emit('exchange', exchange);
  }
}

let shared: NetworkTap | null = null;

/**
 * The tap the host installs before creating the player, so no early request
 * is missed, and the one the bridge reads from afterwards.
 */
export function getSharedNetworkTap(): NetworkTap {
  if (!shared) shared = new NetworkTap();
  return shared;
}
