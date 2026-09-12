import type { GameBridge } from '../bridge/types.js';
import type { GameState } from '../state/game-state.js';
import type { Logger } from '../runtime/logger.js';
import type { BotOptions } from './options.js';
import { CancellationToken, sleep, waitUntil, type Clock } from '../util/async.js';

export interface ApiDeps {
  bridge: GameBridge;
  state: GameState;
  log: Logger;
  options: BotOptions;
  clock: Clock;
  token: () => CancellationToken;
}

export class PlayerApi {
  constructor(private readonly deps: ApiDeps) {}

  get name(): string {
    return this.deps.state.player.name;
  }
  get level(): number {
    return this.deps.state.player.level;
  }
  get hp(): number {
    return this.deps.state.player.hp;
  }
  get maxHp(): number {
    return this.deps.state.player.maxHp;
  }
  get hpPercent(): number {
    return this.deps.state.hpPercent;
  }
  get mp(): number {
    return this.deps.state.player.mp;
  }
  get maxMp(): number {
    return this.deps.state.player.maxMp;
  }
  get mpPercent(): number {
    return this.deps.state.mpPercent;
  }
  get gold(): number {
    return this.deps.state.player.gold;
  }
  get alive(): boolean {
    return this.deps.state.alive;
  }
  get className(): string {
    return this.deps.state.player.className;
  }
  get location(): string {
    return this.deps.state.player.location;
  }
  get loggedIn(): boolean {
    return this.deps.state.loggedIn;
  }

  /** Full HP/MP restore. Only valid outside combat. */
  async rest(): Promise<void> {
    const { bridge, state, log, options, clock, token } = this.deps;
    if (state.inCombat) {
      log.warn('rest() called during combat - ignoring');
      return;
    }
    log.debug('Resting');
    await bridge.call('player.rest');
    await waitUntil(() => state.hpPercent >= 99 && state.mpPercent >= 99, {
      timeoutMs: options.waitTimeoutMs,
      token: token(),
      clock,
      label: 'rest to finish',
    });
    await sleep(options.actionDelayMs, token(), clock);
  }

  /** Rest only when the configured HP/MP thresholds say it is worth it. */
  async restIfNeeded(): Promise<boolean> {
    const { state, options } = this.deps;
    const needsHp = options.restBelowHpPercent > 0 && state.hpPercent < options.restBelowHpPercent;
    const needsMp = options.restBelowMpPercent > 0 && state.mpPercent < options.restBelowMpPercent;
    if (!needsHp && !needsMp) return false;
    await this.rest();
    return true;
  }

  async waitForLogin(timeoutMs?: number): Promise<boolean> {
    const { state, options, clock, token } = this.deps;
    return waitUntil(() => state.loggedIn, {
      timeoutMs: timeoutMs ?? options.waitTimeoutMs,
      token: token(),
      clock,
      label: 'login',
    });
  }
}

export class TravelApi {
  constructor(private readonly deps: ApiDeps) {}

  /** Walk to a town, e.g. `"falconreach"`, `"amityvale"`. */
  async toTown(town: string): Promise<void> {
    const { bridge, state, log, options, clock, token } = this.deps;
    if (state.player.location === town) return;
    log.info(`Travelling to ${town}`);
    await bridge.call('travel.town', { town });
    await waitUntil(() => state.player.location === town, {
      timeoutMs: options.waitTimeoutMs,
      token: token(),
      clock,
      label: `arrival at ${town}`,
    });
    await sleep(options.actionDelayMs, token(), clock);
  }

  /** Return to the main town hub. */
  async toHub(): Promise<void> {
    await this.deps.bridge.call('travel.hub');
    await sleep(this.deps.options.actionDelayMs, this.deps.token(), this.deps.clock);
  }
}
