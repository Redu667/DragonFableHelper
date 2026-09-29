import { describe, expect, it } from 'vitest';
import { DF_GAME_BASE_URL, DF_LOADER_SWF, dfRuffleConfig } from './ruffle-types.js';

/**
 * Model how Ruffle turns a URL written in the SWF into a request: resolve it
 * against `base` when configured, otherwise against the page, then apply the
 * first matching rewrite rule.
 */
function requestUrlFor(swfUrl: string, pageUrl: string, config: Record<string, unknown>): string {
  const base = typeof config.base === 'string' ? config.base : pageUrl;
  const resolved = new URL(swfUrl, base).toString();
  const rules = (config.urlRewriteRules ?? []) as [RegExp, string][];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(resolved)) return resolved.replace(pattern, replacement);
  }
  return resolved;
}

const ENGINE = 'gamefiles/engine.swf';
const EXPECTED = 'https://play.dragonfable.com/game/gamefiles/engine.swf';

describe('dfRuffleConfig', () => {
  it('resolves relative loader URLs against the game directory', () => {
    expect(dfRuffleConfig().base).toBe(DF_GAME_BASE_URL);
  });

  it.each([
    ['the desktop page', 'https://play.dragonfable.com/__dfh/index.html'],
    ['the Android page', 'https://play.dragonfable.com/__dfh/index.html'],
    ['the old desktop page', 'app://dfh/index.html'],
    ['a dev server', 'http://localhost:5273/__dfh/index.html'],
  ])('sends the engine request to /game/ from %s', (_label, page) => {
    expect(requestUrlFor(ENGINE, page, dfRuffleConfig())).toBe(EXPECTED);
  });

  it('would have sent it elsewhere without a base', () => {
    const { base: _base, ...withoutBase } = dfRuffleConfig();
    // This is the "Error loading Game Engine" case: the rewrite rule cannot
    // repair a URL that was resolved against the wrong page.
    expect(requestUrlFor(ENGINE, 'app://dfh/index.html', withoutBase)).not.toBe(EXPECTED);
    expect(requestUrlFor(ENGINE, 'https://play.dragonfable.com/__dfh/index.html', withoutBase)).not.toBe(EXPECTED);
  });

  it('leaves absolute game URLs where they are', () => {
    expect(requestUrlFor(EXPECTED, 'app://dfh/index.html', dfRuffleConfig())).toBe(EXPECTED);
  });

  it('lets callers override any key', () => {
    expect(dfRuffleConfig({ overrides: { base: 'https://example.test/' } }).base).toBe('https://example.test/');
    expect(dfRuffleConfig({ readablePixels: true }).preferredRenderer).toBe('canvas');
  });
});

describe('DF_LOADER_SWF', () => {
  it('carries the same ver query as the DF Pocket client', () => {
    expect(new URL(DF_LOADER_SWF, DF_GAME_BASE_URL).searchParams.get('ver')).toBe('393831');
  });
});
