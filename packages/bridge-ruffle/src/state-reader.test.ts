import { describe, expect, it } from 'vitest';
import { emptySnapshot, type GameSnapshot } from '@dfh/core';
import { defaultSymbolMap, probeSymbols, indexPath, type GameValueReader } from './df-symbols.js';
import { deriveEvents, readCombatPhase, readMonsters, readSnapshot, toBool, toInt, toText } from './state-reader.js';

/** A reader backed by a plain map, standing in for a live client. */
function fakeReader(values: Record<string, string>): GameValueReader {
  return { get: (path) => values[path] ?? null };
}

const S = defaultSymbolMap;

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

  it('substitutes monster indices into templated paths', () => {
    expect(indexPath('_root.arrMonsters.{i}.intHP', 2)).toBe('_root.arrMonsters.2.intHP');
  });
});

describe('readSnapshot', () => {
  it('reads the player out of raw client values', () => {
    const reader = fakeReader({
      [S.playerName]: 'Galanoth',
      [S.playerLevel]: '60',
      [S.playerHp]: '1200',
      [S.playerMaxHp]: '2400',
      [S.playerMp]: '80',
      [S.playerMaxMp]: '200',
      [S.playerGold]: '999999',
      [S.playerClass]: 'DragonLord',
      [S.playerLocation]: 'falconreach',
      [S.inCombat]: 'false',
    });

    const patch = readSnapshot(reader, S);
    expect(patch.player?.name).toBe('Galanoth');
    expect(patch.player?.level).toBe(60);
    expect(patch.player?.hp).toBe(1200);
    expect(patch.loggedIn).toBe(true);
    expect(patch.combat?.inCombat).toBe(false);
    expect(patch.combat?.phase).toBe('idle');
  });

  it('is not logged in before the client populates the avatar', () => {
    const patch = readSnapshot(fakeReader({}), S);
    expect(patch.loggedIn).toBe(false);
    expect(patch.connected).toBe(true);
  });

  it('reads the monster list during a battle', () => {
    const reader = fakeReader({
      [S.playerName]: 'Hero',
      [S.playerHp]: '500',
      [S.playerMaxHp]: '500',
      [S.inCombat]: 'true',
      [S.combatTurn]: 'true',
      [S.combatRound]: '3',
      [S.monsterCount]: '2',
      [indexPath(S.monsterName, 0)]: 'Sneevil',
      [indexPath(S.monsterHp, 0)]: '0',
      [indexPath(S.monsterMaxHp, 0)]: '60',
      [indexPath(S.monsterName, 1)]: 'Sneevil Bandit',
      [indexPath(S.monsterHp, 1)]: '120',
      [indexPath(S.monsterMaxHp, 1)]: '260',
    });

    const monsters = readMonsters(reader, S);
    expect(monsters).toHaveLength(2);
    expect(monsters[0]?.alive).toBe(false); // 0 hp and no explicit flag
    expect(monsters[1]?.alive).toBe(true);
    expect(monsters[1]?.name).toBe('Sneevil Bandit');

    const patch = readSnapshot(reader, S);
    expect(patch.combat?.phase).toBe('playerTurn');
    expect(patch.combat?.round).toBe(3);
  });

  it('keeps previous values when a read comes back empty', () => {
    const previous: GameSnapshot = {
      ...emptySnapshot(),
      player: { ...emptySnapshot().player, name: 'Hero', gold: 500, level: 12 },
    };
    const patch = readSnapshot(fakeReader({ [S.playerHp]: '100', [S.playerMaxHp]: '100' }), S, previous);
    expect(patch.player?.gold).toBe(500);
    expect(patch.player?.level).toBe(12);
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

describe('probeSymbols', () => {
  it('separates resolved paths from ones needing an override', () => {
    const result = probeSymbols(
      fakeReader({ [S.playerHp]: '300', [S.playerMaxHp]: '400', [S.playerName]: 'Hero' }),
    );
    expect(result.resolved.playerHp).toBe('300');
    expect(result.usable).toBe(true);
    expect(result.unresolved.some((entry) => entry.startsWith('playerGold'))).toBe(true);
  });

  it('is unusable when HP cannot be read', () => {
    expect(probeSymbols(fakeReader({})).usable).toBe(false);
  });

  it('lists the ExternalInterface callbacks the client actually exposes', () => {
    const player = { dfUseSkill: () => undefined, dfRest: 'not a function' } as never;
    const result = probeSymbols(fakeReader({}), player);
    expect(result.callbacksFound).toEqual(['dfUseSkill']);
  });
});
