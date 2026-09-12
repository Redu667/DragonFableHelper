import { describe, expect, it } from 'vitest';
import { GameState } from './game-state.js';
import { emptyCombat, type Item } from './types.js';

function item(id: number, name: string, quantity: number, overrides: Partial<Item> = {}): Item {
  return {
    id,
    name,
    quantity,
    maxStack: 999,
    category: 'quest',
    equipped: false,
    dragonCoinItem: false,
    sellable: true,
    level: 1,
    element: 'none',
    ...overrides,
  };
}

describe('GameState', () => {
  it('merges player patches without dropping untouched fields', () => {
    const state = new GameState();
    state.merge({ player: { ...state.player, name: 'Hero', maxHp: 500, hp: 500 } });
    state.merge({ player: { ...state.player, hp: 250 } });

    expect(state.player.name).toBe('Hero');
    expect(state.player.hp).toBe(250);
    expect(state.hpPercent).toBe(50);
  });

  it('reports 0% rather than NaN before the client sends stats', () => {
    expect(new GameState().hpPercent).toBe(0);
    expect(new GameState().mpPercent).toBe(0);
  });

  it('emits a change event on merge', () => {
    const state = new GameState();
    let seen = 0;
    state.events.on('changed', () => (seen += 1));
    state.merge({ loggedIn: true });
    expect(seen).toBe(1);
    expect(state.loggedIn).toBe(true);
  });

  it('finds items by id and by case-insensitive name', () => {
    const state = new GameState();
    state.merge({ inventory: [item(1, 'Sneevil Box', 7)] });

    expect(state.itemCount(1)).toBe(7);
    expect(state.itemCount('sneevil box')).toBe(7);
    expect(state.itemCount('Nonexistent')).toBe(0);
    expect(state.hasItem('Sneevil Box', 7)).toBe(true);
    expect(state.hasItem('Sneevil Box', 8)).toBe(false);
  });

  it('computes missing requirements', () => {
    const state = new GameState();
    state.merge({ inventory: [item(1, 'Sneevil Box', 2), item(2, 'Slime Residue', 5)] });

    const reqs = [
      { item: 1, quantity: 5 },
      { item: 2, quantity: 3 },
    ];
    expect(state.hasRequirements(reqs)).toBe(false);
    expect(state.missingRequirements(reqs)).toEqual([{ item: 1, quantity: 3 }]);

    state.merge({ inventory: [item(1, 'Sneevil Box', 5), item(2, 'Slime Residue', 5)] });
    expect(state.hasRequirements(reqs)).toBe(true);
    expect(state.missingRequirements(reqs)).toEqual([]);
  });

  it('treats a skill as ready only when off cooldown and affordable', () => {
    const state = new GameState();
    state.merge({
      player: { ...state.player, mp: 15, maxMp: 100 },
      combat: {
        ...emptyCombat(),
        skills: [
          { slot: 1, id: 1, name: 'Attack', manaCost: 0, cooldown: 0, cooldownRemaining: 0, target: 'enemy', isDragonSkill: false },
          { slot: 2, id: 2, name: 'Costly', manaCost: 30, cooldown: 0, cooldownRemaining: 0, target: 'enemy', isDragonSkill: false },
          { slot: 3, id: 3, name: 'Cooling', manaCost: 0, cooldown: 3, cooldownRemaining: 2, target: 'enemy', isDragonSkill: false },
        ],
      },
    });

    expect(state.isSkillReady(1)).toBe(true);
    expect(state.isSkillReady(2)).toBe(false);
    expect(state.isSkillReady(3)).toBe(false);
    expect(state.isSkillReady(9)).toBe(false);
  });

  it('tracks quest progress', () => {
    const state = new GameState();
    state.merge({ quests: [{ id: 42, active: true, completed: false, completionCount: 0 }] });
    expect(state.isQuestActive(42)).toBe(true);
    expect(state.isQuestCompleted(42)).toBe(false);
    expect(state.isQuestActive(99)).toBe(false);
  });
});
