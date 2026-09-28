/**
 * Typings for the parts of Ruffle this project uses, taken from Ruffle's
 * own sources rather than from memory - the important discovery being what
 * is *not* there: Ruffle has no `GetVariable` / `SetVariable`, so nothing in
 * a movie's ActionScript state can be read from JavaScript. What it does
 * offer: ExternalInterface callbacks as element properties, a trace
 * observer, and all of the movie's HTTP traffic through the page's `fetch`.
 */

/** The versioned player API returned by `element.ruffle(1)`. */
export interface RufflePlayerV1 {
  readonly readyState: number;
  readonly isPlaying: boolean;
  load(options: Record<string, unknown>): Promise<void>;
  reload(): Promise<void>;
  resume(): void;
  suspend(): void;
  callExternalInterface(name: string, ...args: unknown[]): unknown;
  set traceObserver(observer: ((message: string) => void) | null);
}

/**
 * The `<ruffle-player>` element.
 *
 * Callbacks the movie registers with `ExternalInterface.addCallback` are
 * defined as own properties of this element, hence the index signature.
 * Everything is optional so tests can stand in a plain object.
 */
export interface RufflePlayerElement {
  ruffle?(version?: number): RufflePlayerV1;
  readonly readyState?: number;
  readonly shadowRoot?: ShadowRoot | null;
  set traceObserver(observer: ((message: string) => void) | null);
  load?(options: Record<string, unknown>): Promise<void>;
  [key: string]: unknown;
}

export const enum RuffleReadyState {
  HaveNothing = 0,
  Loading = 1,
  Loaded = 2,
}

export interface RuffleSourceApi {
  createPlayer(): RufflePlayerElement;
}

declare global {
  interface Window {
    RufflePlayer?: {
      config?: Record<string, unknown>;
      newest?(): RuffleSourceApi | null;
    };
  }
}

/** Stage size DragonFable is authored for. */
export const DF_STAGE_WIDTH = 750;
export const DF_STAGE_HEIGHT = 550;

export const DF_GAME_ORIGIN = 'https://play.dragonfable.com';
export const DF_GAME_BASE_URL = `${DF_GAME_ORIGIN}/game/`;
export const DF_LOADER_SWF = 'DFLoader.swf';

export interface DfRuffleConfigOptions {
  /**
   * Use Ruffle's canvas renderer so frames can be read back for pixel
   * sensors. WebGL frames are not readable once presented.
   */
  readablePixels?: boolean;
  overrides?: Record<string, unknown>;
}

/**
 * Ruffle config known to load DragonFable. Every key here exists in Ruffle's
 * `DEFAULT_CONFIG`.
 *
 * - `urlRewriteRules` sends the loader's relative asset requests to the real
 *   game directory.
 * - `allowScriptAccess` enables ExternalInterface in both directions.
 * - `credentialAllowList` lets the movie's requests carry the game's cookies.
 * - `backgroundExecutionMode: mainThread` keeps the game - and the bot -
 *   running while the window is in the background.
 */
export function dfRuffleConfig(options: DfRuffleConfigOptions = {}): Record<string, unknown> {
  return {
    urlRewriteRules: [[/^(?:https?:\/\/[^/]+)?\/?(?:game\/)?(.*)$/i, `${DF_GAME_BASE_URL}$1`]],
    allowScriptAccess: true,
    allowNetworking: 'all',
    credentialAllowList: [DF_GAME_ORIGIN],
    backgroundExecutionMode: 'mainThread',
    autoplay: 'auto',
    unmuteOverlay: 'hidden',
    splashScreen: false,
    preloader: false,
    contextMenu: 'off',
    scrollingBehavior: 'never',
    upgradeToHttps: true,
    letterbox: 'off',
    preferredRenderer: options.readablePixels ? 'canvas' : 'webgl',
    quality: 'medium',
    logLevel: 'error',
    ...options.overrides,
  };
}
