import type { CombatPhase, CombatState, GameSnapshot, Monster, Player } from '@dfh/core';
import { indexPath, type DfSymbolMap, type GameValueReader } from './df-symbols.js';

/** ActionScript hands everything back as a string; coerce defensively. */
export function toInt(raw: string | null, fallback = 0): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) ? value : fallback;
}

export function toBool(raw: string | null, fallback = false): boolean {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0' || value === '') return false;
  return fallback;
}

export function toText(raw: string | null, fallback = ''): string {
  if (raw === null) return fallback;
  const value = raw.trim();
  return value === 'undefined' || value === 'null' ? fallback : value;
}

/** Read the monster list for the current encounter. */
export function readMonsters(reader: GameValueReader, symbols: DfSymbolMap, max = 8): Monster[] {
  const count = Math.min(toInt(reader.get(symbols.monsterCount), 0), max);
  const monsters: Monster[] = [];

  for (let index = 0; index < count; index += 1) {
    const name = toText(reader.get(indexPath(symbols.monsterName, index)));
    const hp = toInt(reader.get(indexPath(symbols.monsterHp, index)), 0);
    const maxHp = toInt(reader.get(indexPath(symbols.monsterMaxHp, index)), 0);
    const aliveRaw = reader.get(indexPath(symbols.monsterAlive, index));

    monsters.push({
      index,
      id: 0, // the client does not expose a stable monster id to the bot
      name,
      level: 0,
      hp,
      maxHp: maxHp > 0 ? maxHp : hp,
      element: 'none',
      // Prefer an explicit alive flag; fall back to "has hp left".
      alive: aliveRaw !== null ? toBool(aliveRaw, hp > 0) : hp > 0,
    });
  }
  return monsters;
}

/** Work out the combat phase from the flags the client exposes. */
export function readCombatPhase(
  inCombat: boolean,
  playerTurn: boolean,
  monsters: readonly Monster[],
  playerAlive: boolean,
): CombatPhase {
  if (!inCombat) {
    if (!playerAlive) return 'defeat';
    if (monsters.length > 0 && monsters.every((m) => !m.alive)) return 'victory';
    return 'idle';
  }
  if (!playerAlive) return 'defeat';
  return playerTurn ? 'playerTurn' : 'enemyTurn';
}

/**
 * Read a snapshot patch out of a running client.
 *
 * Pure with respect to the reader, so tests drive it with a fake map of
 * values instead of a browser and a game.
 */
export function readSnapshot(
  reader: GameValueReader,
  symbols: DfSymbolMap,
  previous?: GameSnapshot,
): Partial<GameSnapshot> {
  const hp = toInt(reader.get(symbols.playerHp), previous?.player.hp ?? 0);
  const maxHp = toInt(reader.get(symbols.playerMaxHp), previous?.player.maxHp ?? 0);
  const name = toText(reader.get(symbols.playerName), previous?.player.name ?? '');

  const player: Player = {
    ...(previous?.player ?? ({} as Player)),
    name,
    level: toInt(reader.get(symbols.playerLevel), previous?.player.level ?? 1),
    hp,
    maxHp,
    mp: toInt(reader.get(symbols.playerMp), previous?.player.mp ?? 0),
    maxMp: toInt(reader.get(symbols.playerMaxMp), previous?.player.maxMp ?? 0),
    gold: toInt(reader.get(symbols.playerGold), previous?.player.gold ?? 0),
    dragonCoins: toInt(reader.get(symbols.playerDragonCoins), previous?.player.dragonCoins ?? 0),
    className: toText(reader.get(symbols.playerClass), previous?.player.className ?? ''),
    location: toText(reader.get(symbols.playerLocation), previous?.player.location ?? ''),
  };

  const inCombat = toBool(reader.get(symbols.inCombat), false);
  const playerTurn = toBool(reader.get(symbols.combatTurn), false);
  const monsters = inCombat || previous?.combat.inCombat ? readMonsters(reader, symbols) : [];

  const combat: CombatState = {
    ...(previous?.combat ?? ({} as CombatState)),
    inCombat,
    phase: readCombatPhase(inCombat, playerTurn, monsters, hp > 0),
    round: toInt(reader.get(symbols.combatRound), previous?.combat.round ?? 0),
    monsters,
    selectedTarget: previous?.combat.selectedTarget ?? 0,
    // Skill cooldowns are not readable through this path; the client enforces
    // them and a refused action is reported back as a call failure.
    skills: previous?.combat.skills ?? [],
  };

  return {
    connected: true,
    // A name only appears once the player is actually in the game world.
    loggedIn: name.length > 0 && maxHp > 0,
    player,
    combat,
    cutsceneActive: toBool(reader.get(symbols.cutsceneActive), false),
  };
}

export interface DerivedEvent {
  name:
    | 'combatStart'
    | 'combatEnd'
    | 'turnStart'
    | 'monsterDefeated'
    | 'death'
    | 'levelUp'
    | 'cutscene'
    | 'loggedIn';
  payload: unknown;
}

/**
 * Compare two snapshots and report what happened between them.
 *
 * The client does not push events, so polling plus this diff is what turns
 * raw variables into the event stream scripts and the UI listen to.
 */
export function deriveEvents(previous: GameSnapshot | null, next: GameSnapshot): DerivedEvent[] {
  const events: DerivedEvent[] = [];
  if (!previous) return events;

  if (!previous.loggedIn && next.loggedIn) {
    events.push({ name: 'loggedIn', payload: { name: next.player.name } });
  }

  if (!previous.combat.inCombat && next.combat.inCombat) {
    events.push({ name: 'combatStart', payload: { monsters: next.combat.monsters } });
  }

  if (previous.combat.inCombat && !next.combat.inCombat) {
    events.push({ name: 'combatEnd', payload: { victory: next.combat.phase === 'victory' } });
  }

  if (next.combat.inCombat && next.combat.round > previous.combat.round) {
    events.push({ name: 'turnStart', payload: { round: next.combat.round } });
  }

  for (const monster of next.combat.monsters) {
    const before = previous.combat.monsters.find((m) => m.index === monster.index);
    if (before?.alive && !monster.alive) {
      events.push({ name: 'monsterDefeated', payload: { monster } });
    }
  }

  if (previous.player.hp > 0 && next.player.hp <= 0 && next.player.maxHp > 0) {
    events.push({ name: 'death', payload: undefined });
  }

  if (next.player.level > previous.player.level) {
    events.push({ name: 'levelUp', payload: { level: next.player.level } });
  }

  if (previous.cutsceneActive !== next.cutsceneActive) {
    events.push({ name: 'cutscene', payload: { active: next.cutsceneActive } });
  }

  return events;
}
