import { sleep, waitUntil } from '../util/async.js';
import type { Monster } from '../state/types.js';
import { SkillRotation, type SkillRule } from './skill-rotation.js';
import type { ApiDeps } from './player.js';

export class CombatApi {
  /** The rotation used by {@link fight} when none is passed explicitly. */
  rotation = new SkillRotation();

  constructor(private readonly deps: ApiDeps) {}

  get active(): boolean {
    return this.deps.state.inCombat;
  }

  get isPlayerTurn(): boolean {
    return this.deps.state.isPlayerTurn;
  }

  get round(): number {
    return this.deps.state.combat.round;
  }

  get monsters(): readonly Monster[] {
    return this.deps.state.combat.monsters;
  }

  get aliveMonsters(): Monster[] {
    return this.deps.state.aliveMonsters;
  }

  /** Accepts rules, a rotation string (`"1|2:hp<50"`) or a rotation object. */
  setRotation(rotation: string | SkillRule[] | SkillRotation): void {
    if (rotation instanceof SkillRotation) this.rotation = rotation;
    else if (typeof rotation === 'string') this.rotation = SkillRotation.fromString(rotation);
    else this.rotation = new SkillRotation(rotation);
  }

  async selectTarget(targetIndex: number): Promise<void> {
    await this.deps.bridge.call('combat.selectTarget', { targetIndex });
  }

  async attack(targetIndex?: number): Promise<void> {
    await this.useSkill(1, targetIndex);
  }

  /** Fire one hotbar slot. Waits for the player's turn first. */
  async useSkill(slot: number, targetIndex?: number): Promise<void> {
    const { bridge, log, options, clock, token } = this.deps;
    if (!(await this.waitForTurn())) {
      log.warn(`Timed out waiting for a turn before using skill ${slot}`);
      return;
    }
    log.debug(`Using skill ${slot}${targetIndex !== undefined ? ` on target ${targetIndex}` : ''}`);
    await bridge.call('combat.useSkill', targetIndex === undefined ? { slot } : { slot, targetIndex });
    await sleep(options.actionDelayMs, token(), clock);
  }

  async flee(): Promise<boolean> {
    const { bridge, log, options, clock, token } = this.deps;
    if (!this.active) return false;
    log.info('Fleeing combat');
    const fled = await bridge.call('combat.flee');
    await sleep(options.actionDelayMs, token(), clock);
    return fled;
  }

  /** Clear the victory/defeat screen so the client accepts input again. */
  async acknowledge(): Promise<void> {
    const { bridge, state, options, clock, token } = this.deps;
    const phase = state.combat.phase;
    if (phase !== 'victory' && phase !== 'defeat') return;
    await bridge.call('combat.acknowledge');
    await sleep(options.actionDelayMs, token(), clock);
  }

  async waitForTurn(timeoutMs?: number): Promise<boolean> {
    const { state, options, clock, token } = this.deps;
    return waitUntil(() => state.isPlayerTurn || !state.inCombat, {
      timeoutMs: timeoutMs ?? options.waitTimeoutMs,
      token: token(),
      clock,
      label: 'player turn',
    }).then(() => state.isPlayerTurn);
  }

  async waitForCombatStart(timeoutMs?: number): Promise<boolean> {
    const { state, options, clock, token } = this.deps;
    return waitUntil(() => state.inCombat, {
      timeoutMs: timeoutMs ?? options.waitTimeoutMs,
      token: token(),
      clock,
      label: 'combat to start',
    });
  }

  async waitForCombatEnd(timeoutMs?: number): Promise<boolean> {
    const { state, options, clock, token } = this.deps;
    return waitUntil(() => !state.inCombat, {
      timeoutMs: timeoutMs ?? options.waitTimeoutMs,
      token: token(),
      clock,
      label: 'combat to end',
    });
  }

  /**
   * Fight the current battle to its conclusion.
   *
   * Each turn it applies the safety rules (potion, flee) and then whatever the
   * rotation picks. Returns true if the battle was won.
   */
  async fight(rotation?: string | SkillRule[] | SkillRotation): Promise<boolean> {
    const { state, log, options, clock, token } = this.deps;
    if (rotation) this.setRotation(rotation);
    this.rotation.reset();

    if (!this.active) {
      log.debug('fight() called with no battle in progress');
      return false;
    }

    while (this.active) {
      token().throwIfCancelled();

      if (!(await this.waitForTurn())) break;
      if (!this.active) break;

      if (options.stopOnDeath && !state.alive) {
        log.error('Player died');
        return false;
      }
      if (await this.applySafetyRules()) continue;

      const decision = this.rotation.decide(state);
      if (!decision) {
        // Nothing is off cooldown or affordable; let the turn tick over.
        log.debug('No usable skill this turn - waiting');
        await sleep(Math.max(options.actionDelayMs, 250), token(), clock);
        continue;
      }
      await this.useSkill(decision.slot, decision.targetIndex);
    }

    const won = state.combat.phase === 'victory';
    log.info(won ? 'Battle won' : `Battle ended (${state.combat.phase})`);
    this.rotation.reset();
    await this.acknowledge();
    return won;
  }

  /**
   * Applies mid-battle safety rules. Returns true when it consumed the turn,
   * so the caller should re-evaluate rather than also firing a skill.
   */
  private async applySafetyRules(): Promise<boolean> {
    const { state, log, options } = this.deps;
    const hp = state.hpPercent;

    if (options.fleeBelowHpPercent > 0 && hp <= options.fleeBelowHpPercent) {
      log.warn(`HP ${hp.toFixed(0)}% - fleeing`);
      await this.flee();
      return true;
    }

    if (
      options.usePotionBelowHpPercent > 0 &&
      hp <= options.usePotionBelowHpPercent &&
      options.potionItemId !== undefined &&
      state.hasItem(options.potionItemId)
    ) {
      log.warn(`HP ${hp.toFixed(0)}% - drinking potion`);
      await this.deps.bridge.call('player.useItem', { itemId: options.potionItemId });
      return true;
    }

    return false;
  }
}
