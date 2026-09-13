import { CancellationToken, sleep, systemClock, waitUntil, type Clock, type WaitOptions } from '../util/async.js';
import { GameState } from '../state/game-state.js';
import { Logger } from '../runtime/logger.js';
import type { GameBridge } from '../bridge/types.js';
import { defaultBotOptions, type BotOptions } from './options.js';
import { PlayerApi, TravelApi, type ApiDeps } from './player.js';
import { CombatApi } from './combat.js';
import { InventoryApi, ShopApi } from './items.js';
import { QuestApi } from './quests.js';
import { QuestGrinder, type GrindPlan, type GrindProgress, type GrindStats } from './grind.js';

export interface BotConfig {
  bridge: GameBridge;
  state?: GameState;
  log?: Logger;
  options?: Partial<BotOptions>;
  clock?: Clock;
}

/**
 * The object every script receives. Mirrors Skua's `Bot` surface, adapted to
 * DragonFable's turn-based combat and quest-driven loop:
 *
 * ```js
 * export default async function (bot) {
 *   bot.options.actionDelayMs = 400;
 *   await bot.grind({ questId: 1, until: [{ item: 'Sneevil Box', quantity: 50 }] });
 * }
 * ```
 */
export class Bot {
  readonly bridge: GameBridge;
  readonly state: GameState;
  readonly log: Logger;
  readonly options: BotOptions;

  readonly player: PlayerApi;
  readonly travel: TravelApi;
  readonly combat: CombatApi;
  readonly inventory: InventoryApi;
  readonly shops: ShopApi;
  readonly quests: QuestApi;

  private readonly grinder: QuestGrinder;
  private readonly clock: Clock;
  private cancellation: CancellationToken = CancellationToken.none;
  private detachState: (() => void) | null = null;

  constructor(config: BotConfig) {
    this.bridge = config.bridge;
    this.state = config.state ?? new GameState();
    this.log = config.log ?? new Logger();
    this.options = { ...defaultBotOptions, ...config.options };
    this.clock = config.clock ?? systemClock;

    const deps: ApiDeps = {
      bridge: this.bridge,
      state: this.state,
      log: this.log,
      options: this.options,
      clock: this.clock,
      token: () => this.cancellation,
    };

    this.player = new PlayerApi(deps);
    this.travel = new TravelApi(deps);
    this.combat = new CombatApi(deps);
    this.inventory = new InventoryApi(deps);
    this.shops = new ShopApi(deps);
    this.quests = new QuestApi(deps, this.combat);
    this.grinder = new QuestGrinder(deps, this.quests, this.player);
  }

  /** Wire the state store to the bridge. Safe to call more than once. */
  attach(): void {
    this.detachState?.();
    this.detachState = this.state.attach(this.bridge);
  }

  detach(): void {
    this.detachState?.();
    this.detachState = null;
  }

  /** @internal the host installs the token that `bot.stop()` trips. */
  setCancellationToken(token: CancellationToken): void {
    this.cancellation = token;
  }

  get token(): CancellationToken {
    return this.cancellation;
  }

  get cancelled(): boolean {
    return this.cancellation.isCancelled;
  }

  /** Throws {@link CancellationError} if the script has been stopped. */
  checkStop(): void {
    this.cancellation.throwIfCancelled();
  }

  /** Cancellable pause. */
  sleep(ms: number): Promise<void> {
    return sleep(ms, this.cancellation, this.clock);
  }

  /** Poll until a condition holds. Returns false on timeout. */
  waitUntil(predicate: () => boolean | Promise<boolean>, options: WaitOptions = {}): Promise<boolean> {
    return waitUntil(predicate, {
      timeoutMs: this.options.waitTimeoutMs,
      token: this.cancellation,
      clock: this.clock,
      ...options,
    });
  }

  /** Repeat a quest until the plan's goal is met. */
  grind(plan: GrindPlan, onProgress?: (progress: GrindProgress) => void): Promise<GrindStats> {
    return this.grinder.run(plan, onProgress);
  }

  /** Connect the bridge and wait until the player is in the game. */
  async start(): Promise<void> {
    this.attach();
    if (!this.bridge.connected) await this.bridge.connect();
    const snapshot = await this.bridge.call('session.snapshot');
    this.state.merge(snapshot);
    await this.player.waitForLogin();
  }
}
