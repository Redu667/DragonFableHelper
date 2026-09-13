/** Domain model for DragonFable. Mirrors what the in-game bridge can observe. */

export type Element =
  | 'fire' | 'ice' | 'water' | 'wind' | 'stone' | 'energy'
  | 'light' | 'darkness' | 'metal' | 'nature' | 'good' | 'evil' | 'bacon' | 'none';

export type ItemCategory =
  | 'weapon' | 'armor' | 'helm' | 'cape' | 'belt' | 'necklace' | 'ring'
  | 'trinket' | 'bracer' | 'gloves' | 'pet' | 'potion' | 'quest' | 'misc';

export type Currency = 'gold' | 'dragonCoins';

export interface PlayerStats {
  strength: number;
  dexterity: number;
  intellect: number;
  charisma: number;
  luck: number;
  endurance: number;
  wisdom: number;
}

export interface CombatBonuses {
  crit: number;
  bonus: number;
  boost: number;
  block: number;
  parry: number;
  dodge: number;
}

export interface Dragon {
  name: string;
  level: number;
  element: Element;
  /** Dragon amulet subscribers get extra dragon actions. */
  hasAmulet: boolean;
}

export interface Player {
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  gold: number;
  dragonCoins: number;
  /** Current equipped class, e.g. "DragonLord", "Warrior". */
  className: string;
  baseClass: string;
  classRank: number;
  stats: PlayerStats;
  bonuses: CombatBonuses;
  dragon: Dragon | null;
  /** Town / area the player is standing in, e.g. "falconreach". */
  location: string;
}

export interface Item {
  id: number;
  name: string;
  quantity: number;
  maxStack: number;
  category: ItemCategory;
  equipped: boolean;
  /** Bought with Dragon Coins; the client refuses to sell these by default. */
  dragonCoinItem: boolean;
  sellable: boolean;
  level: number;
  element: Element;
}

export interface ItemRequirement {
  /** Item id, or name when the script is written against names. */
  item: number | string;
  quantity: number;
}

export interface Quest {
  id: number;
  name: string;
  /** Items the quest hands out on completion. */
  rewards: ItemRequirement[];
  /** Items that must be in the inventory before the quest can be turned in. */
  requirements: ItemRequirement[];
  /** Quests that must be completed before this one unlocks. */
  prerequisites: number[];
  minimumLevel: number;
  /** DailyQuests can only be completed once per reset. */
  daily: boolean;
  goldReward: number;
  experienceReward: number;
}

export interface QuestProgress {
  id: number;
  /** Accepted and sitting in the quest log. */
  active: boolean;
  /** Turned in at least once. */
  completed: boolean;
  completionCount: number;
}

export type SkillTarget = 'enemy' | 'self' | 'allEnemies' | 'party';

export interface Skill {
  /** Hotbar slot, 1-based, as the player clicks it. */
  slot: number;
  id: number;
  name: string;
  manaCost: number;
  /** Turns between uses. 0 means usable every turn. */
  cooldown: number;
  /** Turns remaining before it can be used again. */
  cooldownRemaining: number;
  target: SkillTarget;
  /** Dragon skills live on a separate bar and need a dragon amulet. */
  isDragonSkill: boolean;
}

export interface Monster {
  /** Index in the encounter, 0-based; combat calls address monsters by index. */
  index: number;
  id: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  element: Element;
  alive: boolean;
}

export type CombatPhase = 'idle' | 'playerTurn' | 'enemyTurn' | 'animating' | 'victory' | 'defeat';

export interface CombatState {
  inCombat: boolean;
  phase: CombatPhase;
  /** Increments once per full round. */
  round: number;
  monsters: Monster[];
  /** Index of the monster the client currently has selected. */
  selectedTarget: number;
  skills: Skill[];
}

export interface ShopItem {
  id: number;
  name: string;
  price: number;
  currency: Currency;
  category: ItemCategory;
  /** -1 when the shop has unlimited stock. */
  stock: number;
}

export interface Shop {
  id: number;
  name: string;
  items: ShopItem[];
}

export interface GameSnapshot {
  connected: boolean;
  /** True once the player is logged in and out of the loading screen. */
  loggedIn: boolean;
  player: Player;
  inventory: Item[];
  quests: QuestProgress[];
  /** Quest definitions the client has loaded so far, keyed by quest id. */
  questBook: Record<number, Quest>;
  combat: CombatState;
  shop: Shop | null;
  /** True while a cutscene or dialogue box is blocking input. */
  cutsceneActive: boolean;
}

export function emptyPlayer(): Player {
  return {
    name: '',
    level: 1,
    hp: 0,
    maxHp: 0,
    mp: 0,
    maxMp: 0,
    gold: 0,
    dragonCoins: 0,
    className: '',
    baseClass: '',
    classRank: 0,
    stats: { strength: 0, dexterity: 0, intellect: 0, charisma: 0, luck: 0, endurance: 0, wisdom: 0 },
    bonuses: { crit: 0, bonus: 0, boost: 0, block: 0, parry: 0, dodge: 0 },
    dragon: null,
    location: '',
  };
}

export function emptyCombat(): CombatState {
  return { inCombat: false, phase: 'idle', round: 0, monsters: [], selectedTarget: 0, skills: [] };
}

export function emptySnapshot(): GameSnapshot {
  return {
    connected: false,
    loggedIn: false,
    player: emptyPlayer(),
    inventory: [],
    quests: [],
    questBook: {},
    combat: emptyCombat(),
    shop: null,
    cutsceneActive: false,
  };
}
