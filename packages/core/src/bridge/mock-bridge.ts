import { TypedEmitter } from '../util/events.js';
import { clamp, systemClock, type Clock } from '../util/async.js';
import {
  emptyCombat,
  emptySnapshot,
  type GameSnapshot,
  type Item,
  type Monster,
  type Quest,
  type Skill,
} from '../state/types.js';
import { BridgeError, type BridgeEvents, type GameBridge, type GameCall, type GameCallArgs, type GameCallResults } from './types.js';

/** Deterministic PRNG so mock runs and tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MockMonsterTemplate {
  id: number;
  name: string;
  level: number;
  maxHp: number;
  /** Damage dealt to the player per enemy turn, before variance. */
  attack: number;
  /** Item id -> drop chance in [0,1]. */
  drops?: Record<number, number>;
}

export interface MockQuestTemplate extends Quest {
  /** Monsters fought, in order, when the quest is accepted. */
  waves: number[][];
}

export interface MockWorldConfig {
  seed?: number;
  /** Simulated round-trip delay per bridge call. Keep 0 in tests. */
  latencyMs?: number;
  player?: Partial<GameSnapshot['player']>;
  skills?: Skill[];
  items?: Record<number, Omit<Item, 'quantity' | 'equipped'>>;
  monsters?: Record<number, MockMonsterTemplate>;
  quests?: Record<number, MockQuestTemplate>;
  startingInventory?: Array<{ id: number; quantity: number }>;
}

const DEFAULT_SKILLS: Skill[] = [
  { slot: 1, id: 101, name: 'Attack', manaCost: 0, cooldown: 0, cooldownRemaining: 0, target: 'enemy', isDragonSkill: false },
  { slot: 2, id: 102, name: 'Heavy Strike', manaCost: 10, cooldown: 2, cooldownRemaining: 0, target: 'enemy', isDragonSkill: false },
  { slot: 3, id: 103, name: 'Cleave', manaCost: 20, cooldown: 3, cooldownRemaining: 0, target: 'allEnemies', isDragonSkill: false },
  { slot: 4, id: 104, name: 'Bandage', manaCost: 15, cooldown: 4, cooldownRemaining: 0, target: 'self', isDragonSkill: false },
  { slot: 5, id: 105, name: 'Dragon Breath', manaCost: 25, cooldown: 5, cooldownRemaining: 0, target: 'allEnemies', isDragonSkill: true },
];

const DEFAULT_ITEMS: MockWorldConfig['items'] = {
  1: { id: 1, name: 'Sneevil Box', maxStack: 999, category: 'quest', dragonCoinItem: false, sellable: false, level: 1, element: 'none' },
  2: { id: 2, name: 'Slime Residue', maxStack: 999, category: 'quest', dragonCoinItem: false, sellable: false, level: 1, element: 'water' },
  3: { id: 3, name: 'Health Potion', maxStack: 25, category: 'potion', dragonCoinItem: false, sellable: true, level: 1, element: 'none' },
  10: { id: 10, name: "Sneevil Bandit's Blade", maxStack: 1, category: 'weapon', dragonCoinItem: false, sellable: true, level: 5, element: 'metal' },
};

const DEFAULT_MONSTERS: MockWorldConfig['monsters'] = {
  1: { id: 1, name: 'Sneevil', level: 2, maxHp: 60, attack: 8, drops: { 1: 0.6 } },
  2: { id: 2, name: 'Slime', level: 3, maxHp: 90, attack: 11, drops: { 2: 0.5 } },
  3: { id: 3, name: 'Sneevil Bandit', level: 8, maxHp: 260, attack: 22, drops: { 1: 0.9, 10: 0.05 } },
};

const DEFAULT_QUESTS: MockWorldConfig['quests'] = {
  1: {
    id: 1,
    name: 'Box Hunting',
    rewards: [{ item: 3, quantity: 1 }],
    requirements: [{ item: 1, quantity: 3 }],
    prerequisites: [],
    minimumLevel: 1,
    daily: false,
    goldReward: 120,
    experienceReward: 80,
    waves: [[1, 1], [1]],
  },
  2: {
    id: 2,
    name: 'Slime Time',
    rewards: [],
    requirements: [{ item: 2, quantity: 2 }],
    prerequisites: [1],
    minimumLevel: 2,
    daily: false,
    goldReward: 200,
    experienceReward: 140,
    waves: [[2], [2, 2]],
  },
  3: {
    id: 3,
    name: 'Bandit Camp',
    rewards: [{ item: 10, quantity: 1 }],
    requirements: [],
    prerequisites: [],
    minimumLevel: 5,
    daily: true,
    goldReward: 500,
    experienceReward: 400,
    waves: [[3]],
  },
};

/**
 * A small, deterministic DragonFable simulator behind the {@link GameBridge}
 * interface.
 *
 * It is not trying to be an accurate reimplementation of the game - it exists
 * so the bot engine, the script API and the UI can be exercised (including
 * death, cooldowns, mana starvation and drop RNG) with no game client and no
 * network traffic.
 */
export class MockBridge implements GameBridge {
  readonly id = 'mock';
  readonly events = new TypedEmitter<BridgeEvents>();

  private snapshot = emptySnapshot();
  private readonly config: Required<Pick<MockWorldConfig, 'items' | 'monsters' | 'quests'>> & MockWorldConfig;
  private readonly random: () => number;
  private readonly clock: Clock;
  private isConnected = false;

  /** Remaining waves for the quest currently being run. */
  private pendingWaves: number[][] = [];
  private activeQuestId: number | null = null;

  constructor(config: MockWorldConfig = {}, clock: Clock = systemClock) {
    this.clock = clock;
    this.random = mulberry32(config.seed ?? 1337);
    this.config = {
      ...config,
      items: config.items ?? DEFAULT_ITEMS ?? {},
      monsters: config.monsters ?? DEFAULT_MONSTERS ?? {},
      quests: config.quests ?? DEFAULT_QUESTS ?? {},
    };
  }

  get connected(): boolean {
    return this.isConnected;
  }

  async connect(): Promise<void> {
    this.snapshot = {
      ...emptySnapshot(),
      connected: true,
      loggedIn: true,
      player: {
        name: 'MockHero',
        level: 10,
        hp: 400,
        maxHp: 400,
        mp: 100,
        maxMp: 100,
        gold: 1000,
        dragonCoins: 0,
        className: 'DragonLord',
        baseClass: 'Warrior',
        classRank: 5,
        stats: { strength: 40, dexterity: 20, intellect: 10, charisma: 10, luck: 15, endurance: 30, wisdom: 10 },
        bonuses: { crit: 5, bonus: 10, boost: 0, block: 5, parry: 5, dodge: 5 },
        dragon: { name: 'Mockscale', level: 10, element: 'fire', hasAmulet: true },
        location: 'falconreach',
        ...this.config.player,
      },
      inventory: (this.config.startingInventory ?? []).flatMap((entry) => {
        const template = this.config.items[entry.id];
        return template ? [{ ...template, quantity: entry.quantity, equipped: false }] : [];
      }),
      combat: { ...emptyCombat(), skills: this.config.skills ?? DEFAULT_SKILLS.map((s) => ({ ...s })) },
    };
    this.isConnected = true;
    this.events.emit('connected', undefined);
    this.events.emit('loggedIn', { name: this.snapshot.player.name });
    this.publish();
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.events.emit('disconnected', { reason: 'mock disconnect' });
  }

  async call<K extends GameCall>(
    name: K,
    ...args: GameCallArgs[K] extends void ? [] : [GameCallArgs[K]]
  ): Promise<GameCallResults[K]> {
    if (!this.isConnected && name !== 'session.snapshot') {
      throw new BridgeError('Mock bridge is not connected', name);
    }
    const payload = args[0] as never;
    this.events.emit('trace', { timestamp: this.clock.now(), direction: 'toGame', label: name, payload });

    const latency = this.config.latencyMs ?? 0;
    if (latency > 0) {
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, latency));
    }

    const result = this.dispatch(name, payload);
    this.events.emit('trace', { timestamp: this.clock.now(), direction: 'fromGame', label: `${name}:result`, payload: result });
    return result as GameCallResults[K];
  }

  private dispatch(name: GameCall, payload: never): unknown {
    switch (name) {
      case 'session.snapshot':
        return this.snapshot;
      case 'session.reload':
        return undefined;
      case 'player.rest':
        return this.rest();
      case 'player.equip':
        return this.equip((payload as { itemId: number }).itemId);
      case 'player.useItem':
        return this.useItem((payload as { itemId: number }).itemId);
      case 'combat.attack':
        return this.playerAction(1, (payload as { targetIndex?: number }).targetIndex);
      case 'combat.useSkill': {
        const { slot, targetIndex } = payload as { slot: number; targetIndex?: number };
        return this.playerAction(slot, targetIndex);
      }
      case 'combat.selectTarget':
        this.snapshot.combat.selectedTarget = (payload as { targetIndex: number }).targetIndex;
        this.publish();
        return undefined;
      case 'combat.flee':
        return this.flee();
      case 'combat.acknowledge':
        return this.acknowledge();
      case 'quest.load':
        return this.config.quests[(payload as { questId: number }).questId] ?? null;
      case 'quest.accept':
        return this.acceptQuest((payload as { questId: number }).questId);
      case 'quest.turnIn':
        return this.turnInQuest((payload as { questId: number }).questId);
      case 'quest.abandon':
        this.activeQuestId = null;
        this.pendingWaves = [];
        return undefined;
      case 'shop.load':
        return this.snapshot.shop;
      case 'shop.buy':
        return false;
      case 'shop.sell':
        return this.sell((payload as { itemId: number; quantity?: number }));
      case 'travel.town':
        this.snapshot.player.location = (payload as { town: string }).town;
        this.publish();
        return undefined;
      case 'travel.hub':
        this.snapshot.player.location = 'falconreach';
        this.publish();
        return undefined;
      case 'ui.skipCutscene':
      case 'ui.dismissDialogue':
        if (this.snapshot.cutsceneActive) {
          this.snapshot.cutsceneActive = false;
          this.events.emit('cutscene', { active: false });
          this.publish();
        }
        return undefined;
      default:
        throw new BridgeError(`Unhandled mock call "${name}"`, name);
    }
  }

  // -- internals ---------------------------------------------------------

  private publish(): void {
    // Hand out a copy so consumers cannot mutate the simulator's own state.
    this.events.emit('state', structuredClone(this.snapshot));
  }

  private rest(): void {
    if (this.snapshot.combat.inCombat) throw new BridgeError('Cannot rest during combat', 'player.rest');
    this.snapshot.player.hp = this.snapshot.player.maxHp;
    this.snapshot.player.mp = this.snapshot.player.maxMp;
    this.publish();
  }

  private equip(itemId: number): void {
    const item = this.snapshot.inventory.find((i) => i.id === itemId);
    if (!item) throw new BridgeError(`Item ${itemId} not in inventory`, 'player.equip');
    for (const other of this.snapshot.inventory) {
      if (other.category === item.category) other.equipped = false;
    }
    item.equipped = true;
    this.publish();
  }

  private useItem(itemId: number): void {
    const item = this.snapshot.inventory.find((i) => i.id === itemId);
    if (!item || item.quantity <= 0) throw new BridgeError(`Item ${itemId} not available`, 'player.useItem');
    if (item.category === 'potion') {
      this.snapshot.player.hp = clamp(this.snapshot.player.hp + 150, 0, this.snapshot.player.maxHp);
    }
    this.consume(itemId, 1);
    this.publish();
  }

  private sell({ itemId, quantity = 1 }: { itemId: number; quantity?: number }): boolean {
    const item = this.snapshot.inventory.find((i) => i.id === itemId);
    if (!item || !item.sellable || item.quantity < quantity) return false;
    this.consume(itemId, quantity);
    this.snapshot.player.gold += 10 * quantity;
    this.publish();
    return true;
  }

  private acceptQuest(questId: number): boolean {
    const quest = this.config.quests[questId];
    if (!quest) throw new BridgeError(`Unknown quest ${questId}`, 'quest.accept');
    if (this.snapshot.player.level < quest.minimumLevel) return false;

    this.snapshot.questBook = { ...this.snapshot.questBook, [questId]: quest };
    const existing = this.snapshot.quests.find((q) => q.id === questId);
    if (existing) existing.active = true;
    else this.snapshot.quests = [...this.snapshot.quests, { id: questId, active: true, completed: false, completionCount: 0 }];

    this.activeQuestId = questId;
    this.pendingWaves = quest.waves.map((wave) => [...wave]);
    this.events.emit('questAccepted', { questId });
    this.publish();
    this.startNextWave();
    return true;
  }

  private startNextWave(): void {
    const wave = this.pendingWaves.shift();
    if (!wave) {
      this.snapshot.combat = { ...this.snapshot.combat, inCombat: false, phase: 'idle', monsters: [] };
      this.publish();
      return;
    }
    const monsters: Monster[] = wave.map((monsterId, index) => {
      const template = this.config.monsters[monsterId];
      if (!template) throw new BridgeError(`Unknown monster ${monsterId}`);
      return {
        index,
        id: template.id,
        name: template.name,
        level: template.level,
        hp: template.maxHp,
        maxHp: template.maxHp,
        element: 'none',
        alive: true,
      };
    });
    this.snapshot.combat = {
      ...this.snapshot.combat,
      inCombat: true,
      phase: 'playerTurn',
      round: 1,
      monsters,
      selectedTarget: 0,
      skills: this.snapshot.combat.skills.map((s) => ({ ...s, cooldownRemaining: 0 })),
    };
    this.events.emit('combatStart', { monsters });
    this.events.emit('turnStart', { round: 1 });
    this.publish();
  }

  private playerAction(slot: number, targetIndex?: number): void {
    const combat = this.snapshot.combat;
    if (!combat.inCombat) throw new BridgeError('Not in combat', 'combat.useSkill');
    if (combat.phase !== 'playerTurn') throw new BridgeError(`Not the player's turn (phase=${combat.phase})`, 'combat.useSkill');

    const skill = combat.skills.find((s) => s.slot === slot);
    if (!skill) throw new BridgeError(`No skill in slot ${slot}`, 'combat.useSkill');
    if (skill.cooldownRemaining > 0) throw new BridgeError(`${skill.name} is on cooldown`, 'combat.useSkill');
    if (skill.manaCost > this.snapshot.player.mp) throw new BridgeError(`Not enough mana for ${skill.name}`, 'combat.useSkill');

    this.snapshot.player.mp -= skill.manaCost;
    skill.cooldownRemaining = skill.cooldown;

    if (skill.target === 'self') {
      this.snapshot.player.hp = clamp(this.snapshot.player.hp + 120, 0, this.snapshot.player.maxHp);
    } else {
      const damage = Math.round((25 + this.snapshot.player.stats.strength) * (skill.manaCost > 0 ? 1.8 : 1) * (0.85 + this.random() * 0.3));
      const targets =
        skill.target === 'allEnemies'
          ? combat.monsters.filter((m) => m.alive)
          : [this.resolveTarget(targetIndex)].filter((m): m is Monster => !!m);
      for (const target of targets) {
        target.hp = Math.max(0, target.hp - damage);
        if (target.hp === 0 && target.alive) {
          target.alive = false;
          this.events.emit('monsterDefeated', { monster: { ...target } });
          this.rollDrops(target.id);
        }
      }
    }

    if (combat.monsters.every((m) => !m.alive)) {
      this.finishWave();
      return;
    }
    this.enemyTurn();
  }

  /**
   * Resolve the monster an single-target action should hit. The real client
   * moves the selection to a living monster when the current one dies, so a
   * bot that keeps attacking without re-targeting still makes progress.
   */
  private resolveTarget(requestedIndex?: number): Monster | undefined {
    const combat = this.snapshot.combat;
    const requested = combat.monsters[requestedIndex ?? combat.selectedTarget];
    if (requested?.alive) {
      combat.selectedTarget = requested.index;
      return requested;
    }
    const fallback = combat.monsters.find((m) => m.alive);
    if (fallback) combat.selectedTarget = fallback.index;
    return fallback;
  }

  private enemyTurn(): void {
    const combat = this.snapshot.combat;
    combat.phase = 'enemyTurn';
    this.publish();

    for (const monster of combat.monsters.filter((m) => m.alive)) {
      const template = this.config.monsters[monster.id];
      const damage = Math.round((template?.attack ?? 10) * (0.8 + this.random() * 0.4));
      this.snapshot.player.hp = Math.max(0, this.snapshot.player.hp - damage);
    }

    if (this.snapshot.player.hp <= 0) {
      combat.phase = 'defeat';
      combat.inCombat = false;
      this.pendingWaves = [];
      this.events.emit('death', undefined);
      this.events.emit('combatEnd', { victory: false });
      this.publish();
      return;
    }

    combat.round += 1;
    combat.phase = 'playerTurn';
    // Mana trickles back and cooldowns tick, as they do between DF rounds.
    this.snapshot.player.mp = clamp(this.snapshot.player.mp + 10, 0, this.snapshot.player.maxMp);
    for (const skill of combat.skills) {
      skill.cooldownRemaining = Math.max(0, skill.cooldownRemaining - 1);
    }
    this.events.emit('turnStart', { round: combat.round });
    this.publish();
  }

  private finishWave(): void {
    if (this.pendingWaves.length > 0) {
      this.startNextWave();
      return;
    }
    this.snapshot.combat = { ...this.snapshot.combat, inCombat: false, phase: 'victory' };
    this.events.emit('combatEnd', { victory: true });
    this.publish();
  }

  private acknowledge(): void {
    if (this.snapshot.combat.phase === 'victory' || this.snapshot.combat.phase === 'defeat') {
      this.snapshot.combat = { ...this.snapshot.combat, phase: 'idle', monsters: [] };
      this.publish();
    }
  }

  private flee(): boolean {
    if (!this.snapshot.combat.inCombat) return false;
    this.snapshot.combat = { ...emptyCombat(), skills: this.snapshot.combat.skills };
    this.pendingWaves = [];
    this.events.emit('combatEnd', { victory: false });
    this.publish();
    return true;
  }

  private rollDrops(monsterId: number): void {
    const drops = this.config.monsters[monsterId]?.drops ?? {};
    for (const [itemIdRaw, chance] of Object.entries(drops)) {
      if (this.random() > chance) continue;
      const itemId = Number(itemIdRaw);
      const template = this.config.items[itemId];
      if (!template) continue;
      const item = this.grant(itemId, 1);
      if (item) this.events.emit('itemReceived', { item: { ...item } });
    }
  }

  private grant(itemId: number, quantity: number): Item | undefined {
    const template = this.config.items[itemId];
    if (!template) return undefined;
    const existing = this.snapshot.inventory.find((i) => i.id === itemId);
    if (existing) {
      existing.quantity = Math.min(existing.maxStack, existing.quantity + quantity);
      return existing;
    }
    const item: Item = { ...template, quantity, equipped: false };
    this.snapshot.inventory = [...this.snapshot.inventory, item];
    return item;
  }

  private consume(itemId: number, quantity: number): void {
    const item = this.snapshot.inventory.find((i) => i.id === itemId);
    if (!item) return;
    item.quantity -= quantity;
    if (item.quantity <= 0) {
      this.snapshot.inventory = this.snapshot.inventory.filter((i) => i.id !== itemId);
    }
  }

  private turnInQuest(questId: number): { rewards: Item[] } {
    const quest = this.config.quests[questId];
    if (!quest) throw new BridgeError(`Unknown quest ${questId}`, 'quest.turnIn');

    for (const req of quest.requirements) {
      const id = typeof req.item === 'number' ? req.item : Number.NaN;
      const have = this.snapshot.inventory.find((i) =>
        typeof req.item === 'number' ? i.id === id : i.name.toLowerCase() === String(req.item).toLowerCase(),
      );
      if (!have || have.quantity < req.quantity) {
        throw new BridgeError(`Quest ${questId} requirements not met`, 'quest.turnIn');
      }
    }
    for (const req of quest.requirements) {
      const id = typeof req.item === 'number' ? req.item : this.snapshot.inventory.find((i) => i.name.toLowerCase() === String(req.item).toLowerCase())?.id;
      if (id !== undefined) this.consume(id, req.quantity);
    }

    const rewards: Item[] = [];
    for (const reward of quest.rewards) {
      const id = typeof reward.item === 'number' ? reward.item : Number.NaN;
      const item = this.grant(id, reward.quantity);
      if (item) rewards.push({ ...item });
    }
    this.snapshot.player.gold += quest.goldReward;

    const progress = this.snapshot.quests.find((q) => q.id === questId);
    if (progress) {
      progress.active = false;
      progress.completed = true;
      progress.completionCount += 1;
    }
    this.activeQuestId = null;
    this.events.emit('questCompleted', { questId, rewards });
    this.publish();
    return { rewards };
  }
}
