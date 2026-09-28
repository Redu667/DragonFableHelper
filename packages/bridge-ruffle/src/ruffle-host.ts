import { getSharedNetworkTap } from './network-tap.js';
import {
  DF_GAME_BASE_URL,
  DF_LOADER_SWF,
  DF_STAGE_HEIGHT,
  DF_STAGE_WIDTH,
  dfRuffleConfig,
  type RufflePlayerElement,
  type RuffleSourceApi,
} from './ruffle-types.js';

export interface RuffleHostOptions {
  /** Element the game stage is mounted into. */
  container: HTMLElement;
  /** Where to load the Ruffle bundle from. Bundle it locally for offline use. */
  ruffleScriptUrl?: string;
  /** Defaults to the live DragonFable loader. */
  swfUrl?: string;
  /** Merged over {@link dfRuffleConfig}. */
  config?: Record<string, unknown>;
  /**
   * Render on Ruffle's canvas renderer so pixel sensors can read frames.
   * Costs some performance; leave off until sensors are being set up.
   */
  readablePixels?: boolean;
}

/**
 * Load the Ruffle bundle once and hand back its API.
 *
 * The global config has to be set *before* the script runs, because Ruffle
 * reads it at install time - this is the same ordering the DF Pocket project
 * relies on.
 */
export async function loadRuffle(
  scriptUrl = 'https://unpkg.com/@ruffle-rs/ruffle',
  config: Record<string, unknown> = dfRuffleConfig(),
): Promise<RuffleSourceApi> {
  window.RufflePlayer = window.RufflePlayer ?? {};
  window.RufflePlayer.config = { ...window.RufflePlayer.config, ...config };

  if (!window.RufflePlayer.newest) {
    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[data-ruffle="true"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Ruffle failed to load')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = scriptUrl;
      script.dataset.ruffle = 'true';
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error(`Could not load Ruffle from ${scriptUrl}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  const api = window.RufflePlayer?.newest?.();
  if (!api) throw new Error('Ruffle loaded but exposed no player API');
  return api;
}

/**
 * Mount DragonFable and return the player element to hand to `RuffleBridge`.
 *
 * The page must be served from - or given a base URL of - the game origin, or
 * the loader's relative asset requests and ExternalInterface access will be
 * blocked. `urlRewriteRules` in {@link dfRuffleConfig} handles the requests;
 * the host shells handle the origin.
 */
export async function mountDragonFable(options: RuffleHostOptions): Promise<RufflePlayerElement> {
  const { container, swfUrl = `${DF_GAME_BASE_URL}${DF_LOADER_SWF}`, config, ruffleScriptUrl, readablePixels } = options;

  // Observe fetch before the movie exists so its very first request is seen.
  getSharedNetworkTap().install();

  const api = await loadRuffle(ruffleScriptUrl, dfRuffleConfig({ readablePixels, overrides: config }));
  const player = api.createPlayer();
  const element = player as unknown as HTMLElement;

  element.style.width = `${DF_STAGE_WIDTH}px`;
  element.style.height = `${DF_STAGE_HEIGHT}px`;
  element.style.display = 'block';

  container.replaceChildren(element);
  await player.load?.({ url: swfUrl, allowScriptAccess: true, ...config });

  return player;
}

/**
 * Scale the fixed 750x550 stage to fit its container, preserving aspect.
 *
 * Returns a teardown function. This is what makes the same UI usable on a
 * phone screen and a desktop window.
 */
export function fitStage(stage: HTMLElement, container: HTMLElement = document.body): () => void {
  const resize = () => {
    const scale = Math.min(
      container.clientWidth / DF_STAGE_WIDTH,
      container.clientHeight / DF_STAGE_HEIGHT,
    );
    if (!Number.isFinite(scale) || scale <= 0) return;
    stage.style.transformOrigin = 'center center';
    stage.style.transform = `scale(${scale})`;
  };

  resize();
  window.addEventListener('resize', resize);
  const onOrientation = () => setTimeout(resize, 50);
  window.addEventListener('orientationchange', onOrientation);

  return () => {
    window.removeEventListener('resize', resize);
    window.removeEventListener('orientationchange', onOrientation);
  };
}
