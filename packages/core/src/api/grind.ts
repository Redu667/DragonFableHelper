import { CancellationError, sleep } from '../util/async.js';
import type { ItemRequirement } from '../state/types.js';
import type { SkillRule, SkillRotation } from './skill-rotation.js';
import type { ApiDeps } from './player.js';
import type { QuestApi, QuestRunResult } from './quests.js';
import type { PlayerApi } from './player.js';

export interface GrindPlan {
  /** Quest to repeat. */
  questId: number;
  /** Stop once these items are in the inventory. */
  until?: ItemRequirement[];
  /** Hard cap on runs. Omit to run until `until` is met or the bot is stopped. */
  runs?: number;
  rotation?: string | SkillRule[] | SkillRotation;
  /** Rest between runs when the option thresholds call for it. Default true. */
  restBetweenRuns?: boolean;
  /** Stop the whole grind on the first death. Default true. */
  stopOnDeath?: boolean;
  /** Turn the quest in each run. Default true. */
  turnIn?: boolean;
  /** Overrides `BotOptions.waveGapMs` for every run in this grind. */
  waveGapMs?: number;
  rewardIndex?: number;
}

export interface GrindStats {
  runs: number;
  completed: number;
  deaths: number;
  battlesFought: number;
  goldGained: number;
  /** Item name -> quantity gained over the grind. */
  itemsGained: Record<string, number>;
  startedAt: number;
  finishedAt: number | null;
  stoppedReason: 'goalMet' | 'runLimit' | 'death' | 'cancelled' | 'error' | null;
}

export interface GrindProgress extends GrindStats {
  lastRun: QuestRunResult | null;
}

/**
 * Repeats a quest until a goal is met - the workhorse behind the UI's grind
 * panel and most user scripts.
 */
export class QuestGrinder {
  constructor(
    private readonly deps: ApiDeps,
    private readonly quests: QuestApi,
    private readonly player: PlayerApi,
  ) {}

  async run(plan: GrindPlan, onProgress?: (progress: GrindProgress) => void): Promise<GrindStats> {
    const { state, log, options, clock, token } = this.deps;
    const {
      restBetweenRuns = true,
      stopOnDeath = true,
      turnIn = true,
      rotation,
      rewardIndex,
      until,
      waveGapMs,
      runs: runLimit,
    } = plan;

    const goldAtStart = state.player.gold;
    const stats: GrindStats = {
      runs: 0,
      completed: 0,
      deaths: 0,
      battlesFought: 0,
      goldGained: 0,
      itemsGained: {},
      startedAt: clock.now(),
      finishedAt: null,
      stoppedReason: null,
    };

    // Snapshot item counts so gains are reported per grind, not per account.
    const baseline = new Map<string, number>();
    for (const item of state.inventory) baseline.set(item.name, item.quantity);

    const report = (lastRun: QuestRunResult | null) => {
      stats.goldGained = state.player.gold - goldAtStart;
      stats.itemsGained = {};
      for (const item of state.inventory) {
        const gained = item.quantity - (baseline.get(item.name) ?? 0);
        if (gained > 0) stats.itemsGained[item.name] = gained;
      }
      onProgress?.({ ...stats, lastRun });
    };

    const goalMet = () => !!until && until.length > 0 && state.hasRequirements(until);

    if (goalMet()) {
      log.info('Grind goal already satisfied - nothing to do');
      stats.stoppedReason = 'goalMet';
      stats.finishedAt = clock.now();
      report(null);
      return stats;
    }

    log.info(
      `Starting grind: quest ${plan.questId}` +
        (runLimit ? `, ${runLimit} run(s)` : '') +
        (until?.length ? `, until ${until.map((u) => `${u.quantity}x ${u.item}`).join(' + ')}` : ''),
    );

    try {
      for (;;) {
        token().throwIfCancelled();

        if (runLimit !== undefined && stats.runs >= runLimit) {
          stats.stoppedReason = 'runLimit';
          break;
        }

        if (restBetweenRuns) await this.player.restIfNeeded();

        const run = await this.quests.runOnce(plan.questId, { rotation, turnIn, rewardIndex, waveGapMs });
        stats.runs += 1;
        stats.battlesFought += run.battlesFought;
        if (run.turnedIn) stats.completed += 1;
        if (run.died) stats.deaths += 1;
        report(run);

        if (run.died) {
          if (stopOnDeath) {
            stats.stoppedReason = 'death';
            break;
          }
          // Recover before the next attempt, or we just die again immediately.
          await this.player.rest();
        }

        if (goalMet()) {
          stats.stoppedReason = 'goalMet';
          break;
        }

        await sleep(options.actionDelayMs, token(), clock);
      }
    } catch (error) {
      stats.stoppedReason = error instanceof CancellationError ? 'cancelled' : 'error';
      stats.finishedAt = clock.now();
      report(null);
      if (!(error instanceof CancellationError)) throw error;
      log.info('Grind cancelled');
      return stats;
    }

    stats.finishedAt = clock.now();
    report(null);
    log.info(
      `Grind finished (${stats.stoppedReason}): ${stats.completed}/${stats.runs} runs turned in, ` +
        `${stats.deaths} death(s), ${stats.goldGained} gold`,
    );
    return stats;
  }
}
