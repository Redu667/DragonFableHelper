import type { FlashLegacyApi, RufflePlayerElement } from './ruffle-types.js';

/**
 * Where the bot looks for game state and behaviour inside the DragonFable
 * client.
 *
 * IMPORTANT: these defaults are *starting points, not verified constants.*
 * DragonFable's internals are not public and they move between releases, so
 * the paths below are educated guesses in the shape the client is known to
 * use. Confirm them against the client you are actually running - use
 * {@link probeSymbols} to see which of them resolve, then override the ones
 * that do not:
 *
 * ```ts
 * const bridge = new RuffleBridge({ player, symbols: { playerHp: '_root.game.hero.hp' } });
 * ```
 *
 * Nothing else in the project needs to change when a path moves; this map is
 * the only place that knows about the client's internals.
 */
export interface DfSymbolMap {
  /** Root of the loaded game movie. Every other path is probed under this. */
  root: string;

  playerName: string;
  playerLevel: string;
  playerHp: string;
  playerMaxHp: string;
  playerMp: string;
  playerMaxMp: string;
  playerGold: string;
  playerDragonCoins: string;
  playerClass: string;
  playerLocation: string;

  /** Non-zero/true while a battle is in progress. */
  inCombat: string;
  /** Whose turn it is, or a flag that the player may act. */
  combatTurn: string;
  combatRound: string;
  /** Number of monsters in the encounter. */
  monsterCount: string;
  /**
   * Per-monster paths. `{i}` is replaced with the monster index.
   */
  monsterName: string;
  monsterHp: string;
  monsterMaxHp: string;
  monsterAlive: string;

  /** True while a cutscene or dialogue is blocking input. */
  cutsceneActive: string;

  /**
   * ExternalInterface callback names, if the client exposes any. When a name
   * is present on the player element the bridge prefers calling it over
   * poking variables, because it goes through the game's own logic.
   */
  callbacks: {
    useSkill?: string;
    attack?: string;
    selectTarget?: string;
    flee?: string;
    acceptQuest?: string;
    turnInQuest?: string;
    rest?: string;
    equipItem?: string;
    travelTown?: string;
    skipCutscene?: string;
  };
}

/**
 * Best-guess defaults for an AVM1 DragonFable client. Verify with
 * {@link probeSymbols} before trusting them.
 */
export const defaultSymbolMap: DfSymbolMap = {
  root: '_root',

  playerName: '_root.myAvatar.objData.strUsername',
  playerLevel: '_root.myAvatar.objData.intLevel',
  playerHp: '_root.myAvatar.objData.intHP',
  playerMaxHp: '_root.myAvatar.objData.intHPMax',
  playerMp: '_root.myAvatar.objData.intMP',
  playerMaxMp: '_root.myAvatar.objData.intMPMax',
  playerGold: '_root.myAvatar.objData.intGold',
  playerDragonCoins: '_root.myAvatar.objData.intDCs',
  playerClass: '_root.myAvatar.objData.strClassName',
  playerLocation: '_root.strCurrentTown',

  inCombat: '_root.blnInCombat',
  combatTurn: '_root.blnPlayerTurn',
  combatRound: '_root.intRound',
  monsterCount: '_root.intMonsterCount',
  monsterName: '_root.arrMonsters.{i}.strName',
  monsterHp: '_root.arrMonsters.{i}.intHP',
  monsterMaxHp: '_root.arrMonsters.{i}.intHPMax',
  monsterAlive: '_root.arrMonsters.{i}.blnAlive',

  cutsceneActive: '_root.blnCutscene',

  callbacks: {
    useSkill: 'dfUseSkill',
    attack: 'dfAttack',
    selectTarget: 'dfSelectTarget',
    flee: 'dfFlee',
    acceptQuest: 'dfAcceptQuest',
    turnInQuest: 'dfTurnInQuest',
    rest: 'dfRest',
    equipItem: 'dfEquipItem',
    travelTown: 'dfTravelTown',
    skipCutscene: 'dfSkipCutscene',
  },
};

/** Substitute a monster index into a templated path. */
export function indexPath(template: string, index: number): string {
  return template.replace(/\{i\}/g, String(index));
}

/** Reads named values out of the game. Swapped for a fake in tests. */
export interface GameValueReader {
  get(path: string): string | null;
  set?(path: string, value: string): void;
}

/** A reader backed by Ruffle's legacy AVM1 GetVariable/SetVariable. */
export function createFlashReader(api: FlashLegacyApi): GameValueReader {
  return {
    get(path) {
      try {
        return api.GetVariable?.(path) ?? null;
      } catch {
        return null;
      }
    },
    set(path, value) {
      try {
        api.SetVariable?.(path, value);
      } catch {
        /* the client may refuse writes; callers treat this as best-effort */
      }
    },
  };
}

export interface ProbeResult {
  /** Paths that returned a value, with what they returned. */
  resolved: Record<string, string>;
  /** Paths that returned nothing - these need overriding. */
  unresolved: string[];
  /** ExternalInterface callbacks actually present on the player element. */
  callbacksFound: string[];
  /** True when enough of the map resolved to be usable. */
  usable: boolean;
}

const PROBED_KEYS = [
  'playerName', 'playerLevel', 'playerHp', 'playerMaxHp', 'playerMp', 'playerMaxMp',
  'playerGold', 'playerDragonCoins', 'playerClass', 'playerLocation',
  'inCombat', 'combatTurn', 'combatRound', 'monsterCount', 'cutsceneActive',
] as const satisfies ReadonlyArray<keyof DfSymbolMap>;

/**
 * Report which symbols actually resolve against a running client.
 *
 * This is the tool to reach for first when wiring the bridge to a real game:
 * run it from the app's console, then override whatever comes back
 * unresolved. It is far more reliable than trusting the defaults.
 */
export function probeSymbols(
  reader: GameValueReader,
  player?: RufflePlayerElement,
  symbols: DfSymbolMap = defaultSymbolMap,
): ProbeResult {
  const resolved: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const key of PROBED_KEYS) {
    const path = symbols[key];
    if (typeof path !== 'string') continue;
    const value = reader.get(path);
    if (value === null || value === '' || value === 'undefined') unresolved.push(`${key} (${path})`);
    else resolved[key] = value;
  }

  // Monster slots are only populated during a battle, so a miss here is not
  // necessarily a broken path.
  const callbacksFound: string[] = [];
  if (player) {
    for (const name of Object.values(symbols.callbacks)) {
      if (name && typeof player[name] === 'function') callbacksFound.push(name);
    }
  }

  return {
    resolved,
    unresolved,
    callbacksFound,
    // HP and max HP are the minimum needed for the safety rules to mean anything.
    usable: 'playerHp' in resolved && 'playerMaxHp' in resolved,
  };
}
