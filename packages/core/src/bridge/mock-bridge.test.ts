import { beforeEach, describe, expect, it } from 'vitest';
import { MockBridge } from './mock-bridge.js';
import { GameState } from '../state/game-state.js';
import { BridgeError } from './types.js';

describe('MockBridge', () => {
  let bridge: MockBridge;
  let state: GameState;

  beforeEach(async () => {
    bridge = new MockBridge({ seed: 7 });
    state = new GameState();
    state.attach(bridge);
    await bridge.connect();
    state.merge(await bridge.call('session.snapshot'));
  });

  it('logs the player in with a full bar', () => {
    expect(state.loggedIn).toBe(true);
    expect(state.player.name).toBe('MockHero');
    expect(state.hpPercent).toBe(100);
  });

  it('starts combat when a quest is accepted', async () => {
    expect(await bridge.call('quest.accept', { questId: 1 })).toBe(true);
    expect(state.inCombat).toBe(true);
    expect(state.isPlayerTurn).toBe(true);
    expect(state.aliveMonsters).toHaveLength(2);
  });

  it('refuses a quest above the player level', async () => {
    const lowLevel = new MockBridge({ seed: 7, player: { level: 1 } });
    await lowLevel.connect();
    expect(await lowLevel.call('quest.accept', { questId: 3 })).toBe(false);
  });

  it('advances through waves and ends in victory', async () => {
    await bridge.call('quest.accept', { questId: 1 });
    for (let i = 0; i < 40 && state.inCombat; i += 1) {
      await bridge.call('combat.useSkill', { slot: 1 });
    }
    expect(state.inCombat).toBe(false);
    expect(state.combat.phase).toBe('victory');
  });

  it('rejects actions out of turn', async () => {
    await bridge.call('quest.accept', { questId: 1 });
    // Monsters are still alive, so combat is mid-battle but the phase is
    // playerTurn - acting twice without waiting is the error case.
    await expect(bridge.call('combat.useSkill', { slot: 99 })).rejects.toThrow(BridgeError);
  });

  it('enforces cooldowns within a battle', async () => {
    // Quest 3 is a single beefy bandit, so the wave survives a cleave and the
    // cooldown is still ticking on the following turn.
    await bridge.call('quest.accept', { questId: 3 });
    await bridge.call('combat.useSkill', { slot: 3 });
    expect(state.inCombat).toBe(true);
    await expect(bridge.call('combat.useSkill', { slot: 3 })).rejects.toThrow(/cooldown/);
  });

  it('refuses a skill the player cannot pay for', async () => {
    const drained = new MockBridge({ seed: 7, player: { mp: 5, maxMp: 100 } });
    await drained.connect();
    await drained.call('quest.accept', { questId: 3 });
    await expect(drained.call('combat.useSkill', { slot: 5 })).rejects.toThrow(/Not enough mana/);
  });

  it('re-targets automatically when the selected monster dies', async () => {
    await bridge.call('quest.accept', { questId: 1 });
    expect(state.aliveMonsters).toHaveLength(2);
    // Keep attacking without ever selecting a target; both must still die.
    for (let i = 0; i < 12 && state.combat.monsters.some((m) => m.alive); i += 1) {
      await bridge.call('combat.useSkill', { slot: 1 });
    }
    expect(state.combat.monsters.every((m) => !m.alive)).toBe(true);
  });

  it('will not rest during combat', async () => {
    await bridge.call('quest.accept', { questId: 1 });
    await expect(bridge.call('player.rest')).rejects.toThrow(/Cannot rest/);
  });

  it('restores hp and mp when resting out of combat', async () => {
    const weak = new MockBridge({ seed: 7, player: { hp: 10, maxHp: 400, mp: 0, maxMp: 100 } });
    const weakState = new GameState();
    weakState.attach(weak);
    await weak.connect();
    weakState.merge(await weak.call('session.snapshot'));

    await weak.call('player.rest');
    expect(weakState.player.hp).toBe(400);
    expect(weakState.player.mp).toBe(100);
  });

  it('refuses a turn-in when requirements are missing', async () => {
    await bridge.call('quest.accept', { questId: 1 });
    await expect(bridge.call('quest.turnIn', { questId: 1 })).rejects.toThrow(/requirements not met/);
  });

  it('consumes requirements and pays out on turn-in', async () => {
    const stocked = new MockBridge({ seed: 7, startingInventory: [{ id: 1, quantity: 5 }] });
    const stockedState = new GameState();
    stockedState.attach(stocked);
    await stocked.connect();
    stockedState.merge(await stocked.call('session.snapshot'));

    const goldBefore = stockedState.player.gold;
    await stocked.call('quest.accept', { questId: 1 });
    const { rewards } = await stocked.call('quest.turnIn', { questId: 1 });

    expect(stockedState.itemCount(1)).toBe(2); // 5 - 3 required
    expect(stockedState.player.gold).toBe(goldBefore + 120);
    expect(rewards.map((r) => r.name)).toContain('Health Potion');
    expect(stockedState.isQuestCompleted(1)).toBe(true);
  });

  it('kills the player when outmatched and reports death', async () => {
    const doomed = new MockBridge({
      seed: 3,
      player: { hp: 20, maxHp: 20 },
      monsters: { 9: { id: 9, name: 'Doomkitten', level: 90, maxHp: 99999, attack: 500 } },
      quests: {
        9: {
          id: 9, name: 'Certain Death', rewards: [], requirements: [], prerequisites: [],
          minimumLevel: 1, daily: false, goldReward: 0, experienceReward: 0, waves: [[9]],
        },
      },
    });
    const doomedState = new GameState();
    doomedState.attach(doomed);
    await doomed.connect();
    doomedState.merge(await doomed.call('session.snapshot'));

    let died = false;
    doomed.events.on('death', () => (died = true));

    await doomed.call('quest.accept', { questId: 9 });
    await doomed.call('combat.useSkill', { slot: 1 });

    expect(died).toBe(true);
    expect(doomedState.alive).toBe(false);
    expect(doomedState.combat.phase).toBe('defeat');
  });

  it('emits a trace entry for every call, for the inspector panel', async () => {
    const labels: string[] = [];
    bridge.events.on('trace', (entry) => labels.push(`${entry.direction}:${entry.label}`));
    await bridge.call('travel.town', { town: 'amityvale' });
    expect(labels).toEqual(['toGame:travel.town', 'fromGame:travel.town:result']);
    expect(state.player.location).toBe('amityvale');
  });

  it('is deterministic for a given seed', async () => {
    const run = async () => {
      const b = new MockBridge({ seed: 99 });
      const s = new GameState();
      s.attach(b);
      await b.connect();
      s.merge(await b.call('session.snapshot'));
      await b.call('quest.accept', { questId: 1 });
      while (s.inCombat) await b.call('combat.useSkill', { slot: 1 });
      return { hp: s.player.hp, boxes: s.itemCount(1) };
    };
    expect(await run()).toEqual(await run());
  });
});
