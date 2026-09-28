import { describe, expect, it } from 'vitest';
import { BridgeError } from '@dfh/core';
import { CallbackRegistry, discoverCallbacks } from './callbacks.js';

/** Mimics a <ruffle-player>: API on the prototype, game callbacks as own props. */
class FakePlayerBase {
  play() {}
  pause() {}
}

function makePlayer(callbacks: Record<string, (...args: unknown[]) => unknown> = {}) {
  const player = new FakePlayerBase() as FakePlayerBase & Record<string, unknown>;
  for (const [name, fn] of Object.entries(callbacks)) {
    Object.defineProperty(player, name, { value: fn, configurable: true });
  }
  (player as Record<string, unknown>).readyState = 2; // a non-function own prop
  return player;
}

describe('discoverCallbacks', () => {
  it('lists own callable properties and ignores the prototype API', () => {
    const player = makePlayer({ dfUseSkill: () => 1, dfRest: () => 2 });
    expect(discoverCallbacks(player)).toEqual(['dfRest', 'dfUseSkill']);
  });

  it('is empty for a player that registered nothing', () => {
    expect(discoverCallbacks(makePlayer())).toEqual([]);
  });
});

describe('CallbackRegistry', () => {
  it('resolves an action only when the configured callback really exists', () => {
    const player = makePlayer({ dfUseSkill: () => 1 });
    const registry = new CallbackRegistry(player, { useSkill: 'dfUseSkill', rest: 'dfRest' });
    expect(registry.has('useSkill')).toBe(true);
    expect(registry.has('rest')).toBe(false);
    expect(registry.has('flee')).toBe(false);
  });

  it('invokes with the player as receiver and forwards arguments', () => {
    let seen: unknown[] = [];
    const player = makePlayer({
      dfUseSkill(...args: unknown[]) {
        seen = args;
        return 'ok';
      },
    });
    const registry = new CallbackRegistry(player, { useSkill: 'dfUseSkill' });
    expect(registry.invoke('useSkill', [3], 'combat.useSkill')).toBe('ok');
    expect(seen).toEqual([3]);
  });

  it('explains exactly what is missing', () => {
    const player = makePlayer({ dfAttack: () => undefined });
    const registry = new CallbackRegistry(player, { rest: 'dfRest' });

    expect(() => registry.invoke('rest', [], 'player.rest')).toThrow(/does not expose "dfRest".*discovered callbacks: dfAttack/);
    expect(() => registry.invoke('flee', [], 'combat.flee')).toThrow(/No callback name configured for "flee"/);
    try {
      registry.invoke('flee', [], 'combat.flee');
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).call).toBe('combat.flee');
    }
  });

  it('wraps a throwing callback in a BridgeError', () => {
    const player = makePlayer({
      dfFlee: () => {
        throw new Error('not in combat');
      },
    });
    const registry = new CallbackRegistry(player, { flee: 'dfFlee' });
    expect(() => registry.invoke('flee', [], 'combat.flee')).toThrow(/"dfFlee" threw: not in combat/);
  });

  it('can be reconfigured at runtime', () => {
    const player = makePlayer({ doRest: () => undefined });
    const registry = new CallbackRegistry(player);
    expect(registry.has('rest')).toBe(false);
    registry.setNames({ rest: 'doRest' });
    expect(registry.has('rest')).toBe(true);
    expect(registry.configured).toEqual({ rest: 'doRest' });
  });
});
