import { describe, expect, it } from 'vitest';
import { defaultTapFilter, NetworkTap, type CapturedExchange } from './network-tap.js';

/** A fetch stand-in that answers from a table of URL -> response factory. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Request[] = [];
  const target = {
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      calls.push(request);
      const key = new URL(request.url).pathname;
      const make = routes[key];
      if (!make) throw new TypeError(`fetch failed: no route for ${key}`);
      return make();
    },
  };
  return { target, calls };
}

const GAME = 'https://play.dragonfable.com/game';

function waitForExchange(tap: NetworkTap): Promise<CapturedExchange> {
  return new Promise((resolve) => tap.events.once('exchange', resolve));
}

describe('defaultTapFilter', () => {
  it('records game endpoints and ignores asset downloads', () => {
    expect(defaultTapFilter(`${GAME}/cf-login.asp`)).toBe(true);
    expect(defaultTapFilter(`${GAME}/DFLoader.swf?ver=1`)).toBe(false);
    expect(defaultTapFilter(`${GAME}/gfx/hero.png`)).toBe(false);
    expect(defaultTapFilter('https://unpkg.com/@ruffle-rs/ruffle')).toBe(false);
    expect(defaultTapFilter('not a url')).toBe(false);
  });
});

describe('NetworkTap', () => {
  it('captures request and response bodies without disturbing the caller', async () => {
    const { target, calls } = fakeFetch({
      '/game/cf-login.asp': () =>
        new Response('intHP=350&intHPMax=400&strName=Hero', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    });
    const tap = new NetworkTap({ target, clock: () => 1000 });
    tap.install();

    const pending = waitForExchange(tap);
    const response = await target.fetch(`${GAME}/cf-login.asp`, { method: 'POST', body: 'user=hero&pass=x' });

    // The game still receives a readable, untouched body.
    expect(await response.text()).toBe('intHP=350&intHPMax=400&strName=Hero');
    expect(calls).toHaveLength(1);

    const exchange = await pending;
    expect(exchange.method).toBe('POST');
    expect(exchange.requestBody).toBe('user=hero&pass=x');
    expect(exchange.responseBody).toBe('intHP=350&intHPMax=400&strName=Hero');
    expect(exchange.status).toBe(200);
    expect(exchange.ok).toBe(true);
    expect(tap.history).toHaveLength(1);
  });

  it('passes asset requests straight through without recording', async () => {
    const { target } = fakeFetch({
      '/game/DFLoader.swf': () => new Response(new Uint8Array([0x46, 0x57, 0x53]), { status: 200 }),
    });
    const tap = new NetworkTap({ target });
    tap.install();

    const response = await target.fetch(`${GAME}/DFLoader.swf`);
    expect((await response.arrayBuffer()).byteLength).toBe(3);
    await new Promise((r) => setTimeout(r, 5));
    expect(tap.history).toHaveLength(0);
  });

  it('records a failed fetch and rethrows it', async () => {
    const { target } = fakeFetch({});
    const tap = new NetworkTap({ target });
    tap.install();

    const pending = waitForExchange(tap);
    await expect(target.fetch(`${GAME}/cf-quest.asp`)).rejects.toThrow(/no route/);
    const exchange = await pending;
    expect(exchange.error).toMatch(/no route/);
    expect(exchange.status).toBe(0);
  });

  it('truncates oversized bodies and bounds the history', async () => {
    const { target } = fakeFetch({
      '/game/big.asp': () => new Response('x'.repeat(5000), { status: 200 }),
    });
    const tap = new NetworkTap({ target, maxBodyLength: 100, historySize: 2 });
    tap.install();

    for (let i = 0; i < 3; i += 1) {
      const pending = waitForExchange(tap);
      await target.fetch(`${GAME}/big.asp`);
      await pending;
    }
    expect(tap.history).toHaveLength(2);
    expect(tap.history[0]?.responseBody).toHaveLength(100);
    expect(tap.history[1]?.id).toBe(3);
  });

  it('accepts a Request object as input, the way Ruffle calls fetch', async () => {
    const { target } = fakeFetch({
      '/game/cf-char.asp': () => new Response('<character intHP="12"/>', { status: 200 }),
    });
    const tap = new NetworkTap({ target });
    tap.install();

    const pending = waitForExchange(tap);
    await target.fetch(new Request(`${GAME}/cf-char.asp`, { method: 'POST', body: 'a=1' }));
    const exchange = await pending;
    expect(exchange.url).toBe(`${GAME}/cf-char.asp`);
    expect(exchange.requestBody).toBe('a=1');
  });

  it('installs once and restores the original on uninstall', async () => {
    const { target } = fakeFetch({});
    const original = target.fetch;
    const tap = new NetworkTap({ target });
    tap.install();
    const wrapped = target.fetch;
    tap.install();
    expect(target.fetch).toBe(wrapped);
    expect(tap.installed).toBe(true);

    tap.uninstall();
    expect(target.fetch).toBe(original);
    expect(tap.installed).toBe(false);
  });
});
