import { sleep, waitUntil } from '../util/async.js';
import type { Item, Quest } from '../state/types.js';
import type { SkillRule, SkillRotation } from './skill-rotation.js';
import type { ApiDeps } from './player.js';
import type { CombatApi } from './combat.js';

export interface QuestRunOptions {
  /** Rotation for the battles in this quest. */
  rotation?: string | SkillRule[] | SkillRotation;
  /** Turn the quest in when the battles are done. Default true. */
  turnIn?: boolean;
  /** Which reward to pick when the quest offers a choice. */
  rewardIndex?: number;
 /** Overrides `BotOptions.waveGapMs` for this run. */
  waveGapMs?: number;
}

export interface QuestRunResult {
  questId: number;
  accepted: boolean;
  battlesFought: number;
  battlesWon: number;
  died: boolean;
  turnedIn: boolean;
  rewards: Item[];
}

export class QuestApi {
  constructor(
    private readonly deps: ApiDeps,
    private readonly combat: CombatApi,
  ) {}

  /** Fetch a quest definition from the client (requirements, rewards, ...). */
  async load(questId: number): Promise<Quest | null> {
    const quest = await this.deps.bridge.call('quest.load', { questId });
    if (quest) this.deps.state.merge({ questBook: { [questId]: quest } });
    return quest;
  }

  definition(questId: number): Quest | undefined {
    return this.deps.state.questDefinition(questId);
  }

  isActive(questId: number): boolean {
    return this.deps.state.isQuestActive(questId);
  }

  isCompleted(questId: number): boolean {
    return this.deps.state.isQuestCompleted(questId);
  }

  async accept(questId: number): Promise<boolean> {
    const { bridge, log, options, clock, token } = this.deps;
    log.info(`Accepting quest ${questId}`);
    const accepted = await bridge.call('quest.accept', { questId });
    if (!accepted) {
      log.warn(`Quest ${questId} was refused (level or prerequisites?)`);
      return false;
    }
    await sleep(options.actionDelayMs, token(), clock);
    return true;
  }

  async turnIn(questId: number, rewardIndex?: number): Promise<Item[]> {
    const { bridge, log, options, clock, token } = this.deps;
    log.info(`Turning in quest ${questId}`);
    const { rewards } = await bridge.call(
      'quest.turnIn',
      rewardIndex === undefined ? { questId } : { questId, rewardIndex },
    );
    await sleep(options.actionDelayMs, token(), clock);
    return rewards;
  }

  async abandon(questId: number): Promise<void> {
    await this.deps.bridge.call('quest.abandon', { questId });
  }

  /** True when the inventory satisfies the quest's turn-in requirements. */
  canTurnIn(questId: number): boolean {
    const quest = this.definition(questId);
    if (!quest) return false;
    return this.deps.state.hasRequirements(quest.requirements);
  }

  /**
   * Run a quest once, end to end: accept it, fight every wave with the
   * rotation, then turn it in.
   */
  async runOnce(questId: number, runOptions: QuestRunOptions = {}): Promise<QuestRunResult> {
    const { state, log, options, clock, token } = this.deps;
    const { turnIn = true, rewardIndex, rotation, waveGapMs = options.waveGapMs } = runOptions;

    const result: QuestRunResult = {
      questId,
      accepted: false,
      battlesFought: 0,
      battlesWon: 0,
      died: false,
      turnedIn: false,
      rewards: [],
    };

    if (!this.definition(questId)) await this.load(questId);
    if (options.skipCutscenes && state.cutsceneActive) await this.skipCutscene();

    result.accepted = await this.accept(questId);
    if (!result.accepted) return result;

    for (;;) {
      token().throwIfCancelled();

      if (!this.combat.active) {
        const started = await this.combat.waitForCombatStart(waveGapMs);
        if (!started) break;
      }

      const won = await this.combat.fight(rotation);
      result.battlesFought += 1;
      if (won) result.battlesWon += 1;

      if (!state.alive) {
        result.died = true;
        log.error(`Died during quest ${questId}`);
        break;
      }
      if (!won) break;
    }

    if (options.skipCutscenes && state.cutsceneActive) await this.skipCutscene();

    if (turnIn && !result.died) {
      if (this.canTurnIn(questId)) {
        result.rewards = await this.turnIn(questId, rewardIndex);
        result.turnedIn = true;
      } else {
        const quest = this.definition(questId);
        const missing = quest ? state.missingRequirements(quest.requirements) : [];
        log.warn(
          `Not turning in quest ${questId} - missing ${missing.map((m) => `${m.quantity}x ${m.item}`).join(', ') || 'requirements'}`,
        );
      }
    }

    await sleep(options.actionDelayMs, token(), clock);
    return result;
  }

  private async skipCutscene(): Promise<void> {
    const { bridge, state, options, clock, token } = this.deps;
    await bridge.call('ui.skipCutscene');
    await waitUntil(() => !state.cutsceneActive, {
      timeoutMs: 5000,
      token: token(),
      clock,
      label: 'cutscene to end',
    });
  }
}
