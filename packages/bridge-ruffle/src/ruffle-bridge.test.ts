import { describe, expect, it } from 'vitest';
import { BridgeError, type BridgeEvents, type TraceEntry } from '@dfh/core';
import { RuffleBridge } from './ruffle-bridge.js';
import { NetworkTap, type CapturedExchange } from './network-tap.js';
import { MemoryProfileStore } from './profile.js';
import type { PixelSource, Rgb } from './pixels.js';
import type { InputTarget } from './input.js';
import type { RufflePlayerElement } from './ruffle-types.js';

const GAME = 'https://play.dragonfable.com/game';

/** A player element stand-in: callbacks as own props, trace observer capture. */
function fakePlayer(callbacks: Record<string, (...args: unknown[]) => unknown> = {}) {
  let observer: ((m: string) => void) | null = null;
  const player = {
    readyState: 2,
    set traceObserver(fn: ((m: string) => void) | null) {
      observer = fn;
    },
  } as unknown as RufflePlayerElement & Record<string, unknown>;
  for (const [name, fn] of Object.entries(callbacks)) Object.defineProperty(player, name, { value: fn, configurable: true });
  return { player, trace: (m: string) => observer?.(m) };
}

function fakeCanvas() {
  const dispatched: string[] = [];
  const target: InputTarget & { width: number; height: number } = {
    width: 750,
    height: 550,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 750, height: 550 }),
    dispatchEvent: (e) => (dispatched.push((e as Event).type), true),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return { target, dispatched };
}

function exchange(url: string, body: string, contentType = 'text/plain', extra: Partial<CapturedExchange> = {}): CapturedExchange {
  return { id: 1, url, method: 'POST', requestBody: 'x=1', status: 200, ok: true, contentType, responseBody: body, startedAt: 0, durationMs: 5, ...extra };
}

function makeBridge(opts: {
  callbacks?: Record<string, (...args: unknown[]) => unknown>;
  profile?: ConstructorParameters<typeof RuffleBridge>[0]['profile'];
  pixels?: (x: number, y: number) => Rgb;
} = {}) {
  const { player, trace } = fakePlayer(opts.callbacks);
  const { target, dispatched } = fakeCanvas();
  const tap = new NetworkTap({ target: { fetch: async () => new Response('') } });
  const store = new MemoryProfileStore();
  const paint = opts.pixels ?? (() => [0, 0, 0]);
  const source: PixelSource = { width: 750, height: 550, refresh: () => undefined, sample: (x, y) => paint(x, y) };
  const intervals: Array<() => void> = [];
  const bridge = new RuffleBridge({
    player,
    tap,
    store,
    profile: opts.profile,
    canvas: () => target,
    pixelSource: () => source,
    clock: () => 42,
    setInterval: (fn) => (intervals.push(fn), 1),
    clearInterval: () => undefined,
    sleep: async () => undefined,
    makeEvent: (type) => ({ type }) as unknown as Event,
  });
  const traces: TraceEntry[] = [];
  bridge.events.on('trace', (t) => traces.push(t));
  return { bridge, player, trace, tap, store, dispatched, traces, tickSensors: () => intervals.forEach((fn) => fn()) };
}

describe('RuffleBridge state from network', () => {
  it('turns a login reply into player state and a loggedIn event', async () => {
    const { bridge, tap } = makeBridge();
    const events: string[] = [];
    bridge.events.on('loggedIn', () => events.push('loggedIn'));
    await bridge.connect();

    tap.events.emit('exchange', exchange(`${GAME}/cf-login.asp`, 'strUsername=Hero&intLevel=20&intHP=500&intHPMax=600&intGold=1234'));

    const snap = await bridge.call('session.snapshot');
    expect(snap.player).toMatchObject({ name: 'Hero', level: 20, hp: 500, maxHp: 600, gold: 1234 });
    expect(snap.loggedIn).toBe(true);
    expect(events).toEqual(['loggedIn']);
  });

  it('records endpoints and matched fields for the discovery report, and traces both directions', async () => {
    const { bridge, tap, traces } = makeBridge();
    await bridge.connect();
    tap.events.emit('exchange', exchange(`${GAME}/cf-char.asp`, '<character intHP="9" intHPMax="10" strName="A"/>', 'text/xml'));

    const report = bridge.probe();
    expect(report.endpoints['cf-char.asp']).toMatchObject({ calls: 1, lastStatus: 200 });
    expect(report.endpoints['cf-char.asp']?.matched).toEqual(expect.arrayContaining(['hp', 'maxHp', 'name']));
    expect(report.endpoints['cf-char.asp']?.keys).toEqual(expect.arrayContaining(['intHP', 'strName']));

    const network = traces.filter((t) => t.kind === 'network');
    expect(network.map((t) => t.direction)).toEqual(['toGame', 'fromGame']);
    expect(network[1]?.meta).toMatchObject({ status: 200, matched: expect.arrayContaining(['hp']) });
  });

  it('replays exchanges captured before connect without re-tracing them', async () => {
    const { player } = fakePlayer();
    const tap = new NetworkTap({ target: { fetch: async () => new Response('') } });
    // Simulate an exchange the shared tap saw while the bridge did not exist yet.
    (tap as unknown as { record: (e: CapturedExchange) => void }).record(exchange(`${GAME}/cf-login.asp`, 'intHP=1&intHPMax=2&strName=Z'));
    const bridge = new RuffleBridge({ player, tap, canvas: () => null, pixelSource: () => null, setInterval: () => 1, clearInterval: () => undefined });
    const traces: TraceEntry[] = [];
    bridge.events.on('trace', (t) => traces.push(t));

    await bridge.connect();
    expect((await bridge.call('session.snapshot')).player.name).toBe('Z');
    expect(traces.filter((t) => t.kind === 'network')).toHaveLength(0);
  });

  it('surfaces the game\'s trace() output as trace entries', async () => {
    const { bridge, trace, traces } = makeBridge();
    await bridge.connect();
    trace('hello from AS');
    expect(traces.find((t) => t.kind === 'trace')?.payload).toBe('hello from AS');
    expect(bridge.probe().traceLines).toBe(1);
  });
});

describe('RuffleBridge state from pixels', () => {
  const RED: Rgb = [200, 0, 0];
  const GREEN: Rgb = [0, 200, 0];

  it('derives combat phase and monster hp from calibrated sensors', async () => {
    // A lit "turn" spot at (10,10); a monster bar at y=100, 50% full from x=100..199.
    const { bridge, tickSensors } = makeBridge({
      pixels: (x, y) => (x === 10 && y === 10 ? GREEN : y === 100 && x >= 100 && x < 150 ? RED : [0, 0, 0]),
      profile: {
        sensors: {
          points: [{ name: 'turn', x: 10, y: 10, color: GREEN }, { name: 'battle', x: 10, y: 10, color: GREEN }],
          bars: [{ name: 'mob0', from: { x: 100, y: 100 }, to: { x: 199, y: 100 }, color: RED }],
        },
        combat: { playerTurn: 'turn', inCombat: 'battle', monsterHp: ['mob0'] },
      },
    });
    const seen: string[] = [];
    (['combatStart', 'turnStart'] as (keyof BridgeEvents)[]).forEach((e) => bridge.events.on(e, () => seen.push(e)));
    await bridge.connect();
    // Player must be alive for the phase to be a turn rather than defeat.
    bridge.ingest(exchange(`${GAME}/cf-login.asp`, 'intHP=10&intHPMax=10&strName=H'));

    tickSensors();
    const snap = await bridge.call('session.snapshot');
    expect(snap.combat.inCombat).toBe(true);
    expect(snap.combat.phase).toBe('playerTurn');
    expect(snap.combat.monsters[0]).toMatchObject({ index: 0, hp: 50, maxHp: 100, alive: true });
    expect(seen).toContain('combatStart');
  });

  it('does nothing when no sensors are calibrated', async () => {
    const { bridge, tickSensors } = makeBridge();
    await bridge.connect();
    tickSensors();
    expect((await bridge.call('session.snapshot')).combat.inCombat).toBe(false);
    expect(bridge.probe().lastSensorReading).toBeNull();
  });
});

describe('RuffleBridge actions', () => {
  it('prefers a registered callback over a click', async () => {
    let used: unknown[] | null = null;
    const { bridge, dispatched } = makeBridge({
      callbacks: { dfSkill: (...a: unknown[]) => (used = a) },
      profile: { callbacks: { useSkill: 'dfSkill' }, input: { skill2: { x: 1, y: 1 } } },
    });
    await bridge.connect();
    await bridge.call('combat.useSkill', { slot: 2 });
    expect(used).toEqual([2]);
    expect(dispatched).toEqual([]);
  });

  it('falls back to a calibrated click and traces it as input', async () => {
    const { bridge, dispatched, traces } = makeBridge({ profile: { input: { attack: { x: 300, y: 500 } } } });
    await bridge.connect();
    await bridge.call('combat.attack', {});
    expect(dispatched).toEqual(['pointermove', 'pointerdown', 'pointerup']);
    expect(traces.find((t) => t.kind === 'input')?.label).toBe('attack');
  });

  it('selects a target before a targeted skill', async () => {
    const order: string[] = [];
    const { bridge } = makeBridge({
      callbacks: { sel: (i: unknown) => order.push(`sel:${i}`), sk: (s: unknown) => order.push(`sk:${s}`) },
      profile: { callbacks: { selectTarget: 'sel', useSkill: 'sk' } },
    });
    await bridge.connect();
    await bridge.call('combat.useSkill', { slot: 3, targetIndex: 1 });
    expect(order).toEqual(['sel:1', 'sk:3']);
  });

  it('explains exactly what is missing when neither channel exists', async () => {
    const { bridge } = makeBridge({ callbacks: { something: () => 1 } });
    await bridge.connect();
    await expect(bridge.call('player.rest')).rejects.toThrow(
      /"player.rest" has no way to reach the game yet.*no "rest" callback.*found: something.*record "rest"/,
    );
    await expect(bridge.call('player.rest')).rejects.toBeInstanceOf(BridgeError);
  });

  it('answers quest.load from what the network has shown, without throwing', async () => {
    const { bridge } = makeBridge();
    await bridge.connect();
    expect(await bridge.call('quest.load', { questId: 7 })).toBeNull();
  });

  it('routes callback-only calls and names the missing callback', async () => {
    const { bridge } = makeBridge();
    await bridge.connect();
    await expect(bridge.call('shop.buy', { shopId: 1, itemId: 2 })).rejects.toThrow(/No callback name configured for "buyItem"/);
  });
});

describe('RuffleBridge calibration and profile persistence', () => {
  it('records a point sensor from the live frame and persists the profile', () => {
    const { bridge, store } = makeBridge({ pixels: (x, y) => (x === 5 && y === 5 ? [1, 2, 3] : [9, 9, 9]) });
    const sensor = bridge.addPointSensor('lit', { x: 5, y: 5 });
    expect(sensor).toMatchObject({ name: 'lit', color: [1, 2, 3] });
    expect(store.load()?.sensors?.points).toHaveLength(1);
    expect(bridge.probe().sensors).toEqual(['lit']);

    bridge.removeSensor('lit');
    expect(store.load()?.sensors?.points).toHaveLength(0);
  });

  it('loads a stored profile and layers explicit overrides on top', () => {
    const store = new MemoryProfileStore();
    store.save({ ...bridge0().currentProfile, input: { rest: { x: 1, y: 2 } }, callbacks: { flee: 'dfFlee' } });
    const { player } = fakePlayer({ dfFlee: () => 1 });
    const bridge = new RuffleBridge({ player, store, profile: { callbacks: { rest: 'dfRest' } }, tap: new NetworkTap({ target: { fetch: async () => new Response('') } }), canvas: () => null, pixelSource: () => null, setInterval: () => 1, clearInterval: () => undefined });
    expect(bridge.currentProfile.input.rest).toEqual({ x: 1, y: 2 });
    expect(bridge.currentProfile.callbacks).toEqual({ flee: 'dfFlee', rest: 'dfRest' });
    expect(bridge.probe().inputRecorded).toEqual(['rest']);
    expect(bridge.probe().callbacksFound).toEqual(['dfFlee']);

    function bridge0() {
      return makeBridge().bridge;
    }
  });

  it('persists callback names and combat bindings', () => {
    const { bridge, store } = makeBridge();
    bridge.setCallbackNames({ attack: 'dfAttack' });
    bridge.setCombatBinding({ playerTurn: 'turn' });
    expect(store.load()).toMatchObject({ callbacks: { attack: 'dfAttack' }, combat: { playerTurn: 'turn' } });
  });
});
