/**
 * Minimal typings for the bits of Ruffle we use.
 *
 * Ruffle (https://ruffle.rs) is the open-source Flash emulator that lets a
 * DragonFable client run in 2026, in both an Electron renderer and an Android
 * WebView - which is why the bot lives on the web side of this project rather
 * than in a platform-specific host.
 */

/** Ruffle honours the classic Flash plugin API for AVM1 (ActionScript 2) content. */
export interface FlashLegacyApi {
  /** Read an AS2 variable, e.g. `_root.myAvatar.objData.intHP`. */
  GetVariable?(path: string): string | null;
  /** Write an AS2 variable. */
  SetVariable?(path: string, value: string): void;
  /** Invoke an AS2 function using Flash's XML call format. */
  CallFunction?(requestXml: string): string | null;
}

/**
 * The `<ruffle-player>` element.
 *
 * Callbacks the movie registers via `ExternalInterface.addCallback` show up as
 * callable own properties, so the index signature is how we reach them.
 */
export interface RufflePlayerElement extends FlashLegacyApi {
  play?(): void;
  pause?(): void;
  readonly isPlaying?: boolean;
  [key: string]: unknown;
}

export interface RuffleSourceApi {
  createPlayer(): RufflePlayerElement;
}

export interface RuffleApi {
  newest(): RuffleSourceApi | null;
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

export const DF_GAME_BASE_URL = 'https://play.dragonfable.com/game/';
export const DF_LOADER_SWF = 'DFLoader.swf';

/**
 * Ruffle config known to load DragonFable.
 *
 * `urlRewriteRules` is the load-bearing part: the loader requests its assets
 * with paths relative to the game directory, so every request is rewritten
 * onto the real game origin. `allowScriptAccess` has to be on for
 * ExternalInterface - which is exactly what the bridge drives the game
 * through.
 */
export function dfRuffleConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    urlRewriteRules: [[/^(?:https?:\/\/[^/]+)?\/?(?:game\/)?(.*)$/i, `${DF_GAME_BASE_URL}$1`]],
    allowScriptAccess: true,
    autoplay: 'auto',
    unmuteOverlay: 'hidden',
    splashScreen: false,
    preloader: false,
    contextMenu: 'off',
    scrollingBehavior: 'never',
    upgradeToHttps: true,
    letterbox: 'off',
    preferredRenderer: 'webgl',
    quality: 'medium',
    logLevel: 'error',
    ...overrides,
  };
}
