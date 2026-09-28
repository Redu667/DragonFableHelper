import type { CombatPhase, GameSnapshot, Monster } from '@dfh/core';

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
