import { describe, expect, it } from 'vitest';
import { Bot } from './bot.js';
import { MockBridge, type MockWorldConfig } from '../bridge/mock-bridge.js';
import { Logger } from '../runtime/logger.js';

/** A bot wired to a deterministic mock game with all delays removed. */
async function makeBot(world: MockWorldConfig = {}, options = {}) {
  const bridge = new MockBridge({ seed: 42, ...world });
  const bot = new Bot({
    bridge,
    log: new Logger('test', 'error'),
    options: { actionDelayMs: 0, waitTimeoutMs: 2000, waveGapMs: 0, ...options },
  });
  await bot.start();
  return { bot, bridge };
}

describe('Bot', () => {
  it('connects, logs in and reports player state', async () => {
    const { bot } = await makeBot();
    expect(bot.player.loggedIn).toBe(true);
    expect(bot.player.name).toBe('MockHero');
    expect(bot.player.hpPercent).toBe(100);
    expect(bot.player.gold).toBe(1000);
  });

  it('fights a whole quest and turns it in', async () => {
    const { bot } = await makeBot({ startingInventory: [{ id: 1, quantity: 3 }] });
    const result = await bot.quests.runOnce(1, { waveGapMs: 0 });

    expect(result.accepted).toBe(true);
    expect(result.battlesWon).toBeGreaterThan(0);
    expect(result.died).toBe(false);
    expect(result.turnedIn).toBe(true);
    expect(bot.player.gold).toBe(1000 + 120);
  });

  it('skips the turn-in when requirements are not met instead of throwing', async () => {
    const { bot } = await makeBot();
    // Quest 2 needs 2x Slime Residue; drops may not cover it in one run.
    const result = await bot.quests.runOnce(2, { waveGapMs: 0 });
    expect(result.accepted).toBe(true);
    if (!bot.inventory.contains(2, 2)) {
      expect(result.turnedIn).toBe(false);
    }
  });

  it('reports a refused quest rather than hanging', async () => {
    const { bot } = await makeBot({ player: { level: 1 } });
    const result = await bot.quests.runOnce(3, { waveGapMs: 0 });
    expect(result.accepted).toBe(false);
    expect(result.battlesFought).toBe(0);
  });

  it('uses the configured rotation during a fight', async () => {
    const { bot, bridge } = await makeBot();
    const used: number[] = [];
    bridge.events.on('trace', (entry) => {
      if (entry.direction === 'toGame' && entry.label === 'combat.useSkill') {
        used.push((entry.payload as { slot: number }).slot);
      }
    });

    await bot.quests.runOnce(3, { rotation: '3 | 2 | 1', waveGapMs: 0 });
    // Cleave (3) leads the rotation, so it must open the battle.
    expect(used[0]).toBe(3);
    expect(used.length).toBeGreaterThan(1);
  });

  it('rests between runs when HP drops below the threshold', async () => {
    const { bot, bridge } = await makeBot({}, { restBelowHpPercent: 99, restBelowMpPercent: 0 });
    let rests = 0;
    bridge.events.on('trace', (entry) => {
      if (entry.direction === 'toGame' && entry.label === 'player.rest') rests += 1;
    });

    await bot.grind({ questId: 1, runs: 2, turnIn: false, restBetweenRuns: true });
    // Run 1 takes damage, so run 2 must be preceded by a rest.
    expect(rests).toBeGreaterThanOrEqual(1);
    expect(bot.player.hpPercent).toBeGreaterThan(0);
  });

  it('grinds until an item goal is met', async () => {
    const { bot } = await makeBot();
    const stats = await bot.grind({
      questId: 1,
      until: [{ item: 'Sneevil Box', quantity: 5 }],
      turnIn: false, // turning in would consume the boxes we are collecting
      restBetweenRuns: true,
    });

    expect(stats.stoppedReason).toBe('goalMet');
    expect(bot.inventory.count('Sneevil Box')).toBeGreaterThanOrEqual(5);
    expect(stats.itemsGained['Sneevil Box']).toBeGreaterThanOrEqual(5);
    expect(stats.runs).toBeGreaterThan(0);
  });

  it('respects a run limit', async () => {
    const { bot } = await makeBot();
    const stats = await bot.grind({ questId: 1, runs: 3, turnIn: false });
    expect(stats.runs).toBe(3);
    expect(stats.stoppedReason).toBe('runLimit');
    expect(stats.battlesFought).toBeGreaterThanOrEqual(3);
  });

  it('does nothing when the goal is already satisfied', async () => {
    const { bot } = await makeBot({ startingInventory: [{ id: 1, quantity: 10 }] });
    const stats = await bot.grind({ questId: 1, until: [{ item: 1, quantity: 5 }] });
    expect(stats.runs).toBe(0);
    expect(stats.stoppedReason).toBe('goalMet');
  });

  it('tracks gold gained across a grind', async () => {
    const { bot } = await makeBot({ startingInventory: [{ id: 1, quantity: 30 }] });
    const stats = await bot.grind({ questId: 1, runs: 2 });
    expect(stats.completed).toBe(2);
    expect(stats.goldGained).toBe(240);
  });

  const doomedWorld: MockWorldConfig = {
    seed: 5,
    player: { hp: 30, maxHp: 30 },
    monsters: { 9: { id: 9, name: 'Doomkitten', level: 90, maxHp: 99999, attack: 400 } },
    quests: {
      9: {
        id: 9, name: 'Certain Death', rewards: [], requirements: [], prerequisites: [],
        minimumLevel: 1, daily: false, goldReward: 0, experienceReward: 0, waves: [[9]],
      },
    },
  };

  it('stops the grind on death by default', async () => {
    const { bot } = await makeBot(doomedWorld);
    const stats = await bot.grind({ questId: 9, runs: 5 });

    expect(stats.deaths).toBe(1);
    expect(stats.runs).toBe(1);
    expect(stats.stoppedReason).toBe('death');
  });

  it('keeps going after death when stopOnDeath is off', async () => {
    const { bot } = await makeBot(doomedWorld);
    const stats = await bot.grind({ questId: 9, runs: 3, stopOnDeath: false });

    expect(stats.runs).toBe(3);
    expect(stats.deaths).toBe(3);
    expect(stats.stoppedReason).toBe('runLimit');
    // It must rest after each death, or every later run dies instantly.
    expect(bot.player.hp).toBeGreaterThan(0);
  });

  it('flees instead of dying when a flee threshold is set', async () => {
    const { bot } = await makeBot(
      { ...doomedWorld, player: { hp: 400, maxHp: 400 }, monsters: { 9: { id: 9, name: 'Doomkitten', level: 90, maxHp: 99999, attack: 120 } } },
      { fleeBelowHpPercent: 50, stopOnDeath: true },
    );
    const result = await bot.quests.runOnce(9, { waveGapMs: 0 });

    expect(result.died).toBe(false);
    expect(bot.player.alive).toBe(true);
    expect(bot.combat.active).toBe(false);
  });

  it('drinks a potion mid-battle when configured', async () => {
    const { bot, bridge } = await makeBot(
      {
        ...doomedWorld,
        player: { hp: 400, maxHp: 400 },
        monsters: { 9: { id: 9, name: 'Doomkitten', level: 90, maxHp: 99999, attack: 120 } },
        startingInventory: [{ id: 3, quantity: 5 }],
      },
      { usePotionBelowHpPercent: 60, potionItemId: 3, stopOnDeath: true },
    );
    let potions = 0;
    bridge.events.on('trace', (entry) => {
      if (entry.direction === 'toGame' && entry.label === 'player.useItem') potions += 1;
    });

    await bot.quests.runOnce(9, { waveGapMs: 0 });
    expect(potions).toBeGreaterThan(0);
    expect(bot.inventory.count(3)).toBeLessThan(5);
  });

  it('reports grind progress as it goes', async () => {
    const { bot } = await makeBot();
    const seen: number[] = [];
    await bot.grind({ questId: 1, runs: 2, turnIn: false }, (progress) => seen.push(progress.runs));
    expect(seen).toContain(1);
    expect(seen).toContain(2);
  });
});
