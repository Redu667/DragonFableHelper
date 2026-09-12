/** Runtime knobs shared by the built-in engines and exposed in the UI. */
export interface BotOptions {
  /** Pause between combat actions. Also throttles the bot's call rate. */
  actionDelayMs: number;
  /** Default timeout for every `waitFor*` helper. */
  waitTimeoutMs: number;

  /** Rest after a battle when HP drops below this percentage. 0 disables. */
  restBelowHpPercent: number;
  /** Rest after a battle when MP drops below this percentage. 0 disables. */
  restBelowMpPercent: number;

  /** Drink a potion mid-battle below this HP percentage. 0 disables. */
  usePotionBelowHpPercent: number;
  /** Item used by the potion safety rule. */
  potionItemId?: number;

  /** Flee mid-battle below this HP percentage. 0 disables. */
  fleeBelowHpPercent: number;
  /** Halt the running script when the player dies. */
  stopOnDeath: boolean;
  /** Dismiss cutscenes and dialogue automatically. */
  skipCutscenes: boolean;
  /**
   * How long to wait for the next battle of a multi-wave quest before deciding
   * the quest is over. Real clients need a beat between waves; the mock does
   * not, so tests set this to 0.
   */
  waveGapMs: number;
}

export const defaultBotOptions: BotOptions = {
  actionDelayMs: 600,
  waitTimeoutMs: 20_000,
  restBelowHpPercent: 60,
  restBelowMpPercent: 25,
  usePotionBelowHpPercent: 0,
  fleeBelowHpPercent: 0,
  stopOnDeath: true,
  skipCutscenes: true,
  waveGapMs: 1500,
};
