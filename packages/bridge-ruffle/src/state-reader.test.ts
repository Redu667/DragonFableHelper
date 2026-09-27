import { describe, expect, it } from 'vitest';
import { emptySnapshot, type GameSnapshot } from '@dfh/core';
import { deriveEvents, readCombatPhase, toBool, toInt, toText } from './state-reader.js';

describe('value coercion', () => {
  it('parses integers and tolerates junk', () => {
    expect(toInt('42')).toBe(42);
    expect(toInt(' 17 ')).toBe(17);
    expect(toInt(null, 5)).toBe(5);
    expect(toInt('undefined', 3)).toBe(3);
    expect(toInt('', 9)).toBe(9);
  });

  it('parses the several ways ActionScript spells a boolean', () => {
    expect(toBool('true')).toBe(true);
    expect(toBool('1')).toBe(true);
    expect(toBool('false')).toBe(false);
    expect(toBool('0')).toBe(false);
    expect(toBool('')).toBe(false);
    expect(toBool(null, true)).toBe(true);
  });

  it('treats undefined/null text as empty', () => {
    expect(toText('Hero')).toBe('Hero');
    expect(toText('undefined')).toBe('');
    expect(toText('null')).toBe('');
    expect(toText(null, 'fallback')).toBe('fallback');
  });

});

describe('readCombatPhase', () => {
  const alive = [{ index: 0, id: 0, name: 'm', level: 1, hp: 10, maxHp: 10, element: 'none' as const, alive: true }];
  const dead = [{ ...alive[0]!, hp: 0, alive: false }];

  it('reports the player turn', () => {
    expect(readCombatPhase(true, true, alive, true)).toBe('playerTurn');
  });
  it('reports the enemy turn', () => {
    expect(readCombatPhase(true, false, alive, true)).toBe('enemyTurn');
  });
  it('reports defeat when the player is down', () => {
    expect(readCombatPhase(true, true, alive, false)).toBe('defeat');
    expect(readCombatPhase(false, false, alive, false)).toBe('defeat');
  });
  it('reports victory when combat ended with everything dead', () => {
    expect(readCombatPhase(false, false, dead, true)).toBe('victory');
  });
  it('is idle out of combat', () => {
    expect(readCombatPhase(false, false, [], true)).toBe('idle');
  });
});

describe('deriveEvents', () => {
  const base = emptySnapshot();

  const withCombat = (overrides: Partial<GameSnapshot['combat']>, player: Partial<GameSnapshot['player']> = {}): GameSnapshot => ({
    ...base,
    player: { ...base.player, hp: 100, maxHp: 100, ...player },
    combat: { ...base.combat, ...overrides },
  });

  it('emits nothing without a previous snapshot', () => {
    expect(deriveEvents(null, withCombat({}))).toEqual([]);
  });

  it('detects combat starting and ending', () => {
    const idle = withCombat({ inCombat: false });
    const fighting = withCombat({ inCombat: true, monsters: [] });

    expect(deriveEvents(idle, fighting).map((e) => e.name)).toContain('combatStart');
    expect(deriveEvents(fighting, withCombat({ inCombat: false, phase: 'victory' })).map((e) => e.name)).toContain('combatEnd');
  });

  it('reports victory in the combatEnd payload', () => {
    const fighting = withCombat({ inCombat: true });
    const won = withCombat({ inCombat: false, phase: 'victory' });
    const [event] = deriveEvents(fighting, won).filter((e) => e.name === 'combatEnd');
    expect(event?.payload).toEqual({ victory: true });
  });

  it('detects a new round', () => {
    const r1 = withCombat({ inCombat: true, round: 1 });
    const r2 = withCombat({ inCombat: true, round: 2 });
    expect(deriveEvents(r1, r2).find((e) => e.name === 'turnStart')?.payload).toEqual({ round: 2 });
    expect(deriveEvents(r2, r2).some((e) => e.name === 'turnStart')).toBe(false);
  });

  it('detects a monster dying exactly once', () => {
    const monster = { index: 0, id: 0, name: 'Sneevil', level: 1, hp: 10, maxHp: 10, element: 'none' as const, alive: true };
    const before = withCombat({ inCombat: true, monsters: [monster] });
    const after = withCombat({ inCombat: true, monsters: [{ ...monster, hp: 0, alive: false }] });

    expect(deriveEvents(before, after).filter((e) => e.name === 'monsterDefeated')).toHaveLength(1);
    expect(deriveEvents(after, after).filter((e) => e.name === 'monsterDefeated')).toHaveLength(0);
  });

  it('detects death and level ups', () => {
    const alive = withCombat({}, { hp: 50 });
    const dead = withCombat({}, { hp: 0 });
    expect(deriveEvents(alive, dead).some((e) => e.name === 'death')).toBe(true);

    const leveled = withCombat({}, { hp: 50, level: 2 });
    expect(deriveEvents(alive, leveled).find((e) => e.name === 'levelUp')?.payload).toEqual({ level: 2 });
  });

  it('does not report death before the client has sent stats', () => {
    const blank = { ...base, player: { ...base.player, hp: 0, maxHp: 0 } };
    expect(deriveEvents(blank, blank).some((e) => e.name === 'death')).toBe(false);
  });

  it('reports cutscenes opening and closing', () => {
    const off = { ...base, cutsceneActive: false };
    const on = { ...base, cutsceneActive: true };
    expect(deriveEvents(off, on).find((e) => e.name === 'cutscene')?.payload).toEqual({ active: true });
    expect(deriveEvents(on, off).find((e) => e.name === 'cutscene')?.payload).toEqual({ active: false });
  });
});
