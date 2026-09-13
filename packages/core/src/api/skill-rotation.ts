import type { GameState } from '../state/game-state.js';
import type { Monster } from '../state/types.js';

export interface CombatContext {
  state: GameState;
  /** Current combat round, 1-based. */
  round: number;
  aliveMonsters: Monster[];
  target: Monster | undefined;
  /** How many times each slot has fired in this battle. */
  usesThisBattle: ReadonlyMap<number, number>;
}

/**
 * One entry in a rotation. Rules are evaluated in order and the first one
 * that is both *usable* (off cooldown, affordable) and *permitted* by its
 * guards fires. Everything is optional except the slot, so a plain
 * `{ slot: 2 }` behaves like "use skill 2 whenever it is up".
 */
export interface SkillRule {
  /** Hotbar slot, 1-based. */
  slot: number;
  label?: string;
  /** Only fire while the player's HP percentage is at or below this. */
  playerHpBelow?: number;
  /** Only fire while the player's HP percentage is at or above this. */
  playerHpAbove?: number;
  /** Only fire while the target's HP percentage is at or below this. */
  targetHpBelow?: number;
  /** Only fire while the target's HP percentage is at or above this. */
  targetHpAbove?: number;
  /** Require at least this many living monsters (for cleave-style skills). */
  minMonstersAlive?: number;
  /** Fire at most once every N rounds (1 = every round). */
  everyRounds?: number;
  /** Hard cap on uses within a single battle. */
  maxUsesPerBattle?: number;
  /** Escape hatch for anything the declarative guards do not cover. */
  when?: (ctx: CombatContext) => boolean;
}

export interface SkillDecision {
  slot: number;
  targetIndex: number;
  rule: SkillRule;
}

/** Slot 1 is the free basic attack in DragonFable; always a safe fallback. */
export const BASIC_ATTACK_SLOT = 1;

/**
 * Parses a Skua-style rotation string into rules.
 *
 * `"1 | 2 | 4"` becomes three rules; `|` and `,` both separate entries.
 * A slot may carry a short guard suffix:
 *   `4:hp<40`  - only below 40% player HP
 *   `3:mobs>1` - only with more than one monster alive
 *   `2:every2` - at most once every two rounds
 */
export function parseRotation(input: string): SkillRule[] {
  return input
    .split(/[|,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [slotText, ...guards] = part.split(':');
      const slot = Number.parseInt((slotText ?? '').trim(), 10);
      if (!Number.isFinite(slot)) throw new Error(`Invalid rotation entry "${part}": expected a skill slot number`);
      const rule: SkillRule = { slot };
      for (const guard of guards) {
        const g = guard.trim().toLowerCase();
        let match: RegExpMatchArray | null;
        if ((match = g.match(/^hp<(\d+)$/))) rule.playerHpBelow = Number(match[1]);
        else if ((match = g.match(/^hp>(\d+)$/))) rule.playerHpAbove = Number(match[1]);
        else if ((match = g.match(/^target<(\d+)$/))) rule.targetHpBelow = Number(match[1]);
        else if ((match = g.match(/^target>(\d+)$/))) rule.targetHpAbove = Number(match[1]);
        else if ((match = g.match(/^mobs>(\d+)$/))) rule.minMonstersAlive = Number(match[1]) + 1;
        else if ((match = g.match(/^mobs>=(\d+)$/))) rule.minMonstersAlive = Number(match[1]);
        else if ((match = g.match(/^every(\d+)$/))) rule.everyRounds = Number(match[1]);
        else if ((match = g.match(/^max(\d+)$/))) rule.maxUsesPerBattle = Number(match[1]);
        else throw new Error(`Unknown rotation guard ":${guard}" in "${part}"`);
      }
      return rule;
    });
}

function hpPercent(monster: Monster | undefined): number {
  if (!monster || monster.maxHp <= 0) return 0;
  return (monster.hp / monster.maxHp) * 100;
}

/**
 * Stateful rotation driver. Holds per-battle bookkeeping (use counts, the
 * round a slot last fired) so guards like `everyRounds` and
 * `maxUsesPerBattle` work, and resets it when a battle ends.
 */
export class SkillRotation {
  private uses = new Map<number, number>();
  private lastRound = new Map<number, number>();

  constructor(
    private rules: SkillRule[] = [{ slot: BASIC_ATTACK_SLOT }],
    /** Fall back to the basic attack when no rule is eligible. */
    private readonly fallbackToBasicAttack = true,
  ) {}

  static fromString(input: string, fallbackToBasicAttack = true): SkillRotation {
    return new SkillRotation(parseRotation(input), fallbackToBasicAttack);
  }

  get currentRules(): readonly SkillRule[] {
    return this.rules;
  }

  setRules(rules: SkillRule[]): void {
    this.rules = rules;
    this.reset();
  }

  /** Call when a battle starts or ends; clears per-battle counters. */
  reset(): void {
    this.uses.clear();
    this.lastRound.clear();
  }

  /** Choose the next action, or null when nothing at all is usable. */
  decide(state: GameState): SkillDecision | null {
    const combat = state.combat;
    const aliveMonsters = state.aliveMonsters;
    if (aliveMonsters.length === 0) return null;

    // Prefer the selected target while it lives, else the weakest survivor so
    // wounded monsters get finished instead of spreading damage around.
    const selected = state.selectedMonster;
    const target =
      selected && selected.alive
        ? selected
        : [...aliveMonsters].sort((a, b) => a.hp - b.hp)[0];

    const ctx: CombatContext = {
      state,
      round: combat.round,
      aliveMonsters,
      target,
      usesThisBattle: this.uses,
    };

    for (const rule of this.rules) {
      if (!state.isSkillReady(rule.slot)) continue;
      if (!this.permits(rule, ctx)) continue;
      return this.commit(rule, ctx);
    }

    if (this.fallbackToBasicAttack && state.isSkillReady(BASIC_ATTACK_SLOT)) {
      return this.commit({ slot: BASIC_ATTACK_SLOT, label: 'fallback attack' }, ctx);
    }
    return null;
  }

  private commit(rule: SkillRule, ctx: CombatContext): SkillDecision {
    this.uses.set(rule.slot, (this.uses.get(rule.slot) ?? 0) + 1);
    this.lastRound.set(rule.slot, ctx.round);
    return { slot: rule.slot, targetIndex: ctx.target?.index ?? 0, rule };
  }

  private permits(rule: SkillRule, ctx: CombatContext): boolean {
    const playerHp = ctx.state.hpPercent;
    if (rule.playerHpBelow !== undefined && playerHp > rule.playerHpBelow) return false;
    if (rule.playerHpAbove !== undefined && playerHp < rule.playerHpAbove) return false;

    const targetHp = hpPercent(ctx.target);
    if (rule.targetHpBelow !== undefined && targetHp > rule.targetHpBelow) return false;
    if (rule.targetHpAbove !== undefined && targetHp < rule.targetHpAbove) return false;

    if (rule.minMonstersAlive !== undefined && ctx.aliveMonsters.length < rule.minMonstersAlive) return false;

    if (rule.maxUsesPerBattle !== undefined && (this.uses.get(rule.slot) ?? 0) >= rule.maxUsesPerBattle) return false;

    if (rule.everyRounds !== undefined) {
      const last = this.lastRound.get(rule.slot);
      if (last !== undefined && ctx.round - last < rule.everyRounds) return false;
    }

    if (rule.when && !rule.when(ctx)) return false;
    return true;
  }
}
