import { TypedEmitter } from '../util/events.js';
import type { GameBridge } from '../bridge/types.js';
import {
  emptySnapshot,
  type GameSnapshot,
  type Item,
  type ItemRequirement,
  type Monster,
  type Quest,
  type QuestProgress,
  type Skill,
} from './types.js';

export interface GameStateEvents {
  changed: GameSnapshot;
}

/** Match an item by id when given a number, or case-insensitively by name. */
function itemMatches(item: { id: number; name: string }, key: number | string): boolean {
  return typeof key === 'number'
    ? item.id === key
    : item.name.toLowerCase() === key.toLowerCase();
}

/**
 * Holds the last known state of the game and keeps it current from bridge
 * events. Scripts read through this rather than polling the client, so a
 * property access in a tight bot loop costs nothing.
 */
export class GameState {
  private snapshot: GameSnapshot = emptySnapshot();
  readonly events = new TypedEmitter<GameStateEvents>();

  /** Subscribe to a bridge; returns a teardown function. */
  attach(bridge: GameBridge): () => void {
    const offs = [
      bridge.events.on('state', (patch) => this.merge(patch)),
      bridge.events.on('connected', () => this.merge({ connected: true })),
      bridge.events.on('disconnected', () => this.merge({ connected: false, loggedIn: false })),
      bridge.events.on('loggedIn', () => this.merge({ loggedIn: true })),
      bridge.events.on('cutscene', ({ active }) => this.merge({ cutsceneActive: active })),
    ];
    return () => offs.forEach((off) => off());
  }

  /** Shallow-merge a patch into the snapshot and notify listeners. */
  merge(patch: Partial<GameSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      // Nested objects are replaced wholesale when present, never half-merged.
      player: patch.player ? { ...this.snapshot.player, ...patch.player } : this.snapshot.player,
      combat: patch.combat ? { ...this.snapshot.combat, ...patch.combat } : this.snapshot.combat,
      questBook: patch.questBook
        ? { ...this.snapshot.questBook, ...patch.questBook }
        : this.snapshot.questBook,
    };
    this.events.emit('changed', this.snapshot);
  }

  /** Immutable view of everything the client has told us. */
  get current(): GameSnapshot {
    return this.snapshot;
  }

  get player() {
    return this.snapshot.player;
  }

  get combat() {
    return this.snapshot.combat;
  }

  get inventory(): readonly Item[] {
    return this.snapshot.inventory;
  }

  get connected(): boolean {
    return this.snapshot.connected;
  }

  get loggedIn(): boolean {
    return this.snapshot.loggedIn;
  }

  get cutsceneActive(): boolean {
    return this.snapshot.cutsceneActive;
  }

  get hpPercent(): number {
    const { hp, maxHp } = this.snapshot.player;
    return maxHp > 0 ? (hp / maxHp) * 100 : 0;
  }

  get mpPercent(): number {
    const { mp, maxMp } = this.snapshot.player;
    return maxMp > 0 ? (mp / maxMp) * 100 : 0;
  }

  get alive(): boolean {
    return this.snapshot.player.hp > 0;
  }

  // -- inventory ---------------------------------------------------------

  findItem(key: number | string): Item | undefined {
    return this.snapshot.inventory.find((item) => itemMatches(item, key));
  }

  itemCount(key: number | string): number {
    return this.findItem(key)?.quantity ?? 0;
  }

  hasItem(key: number | string, quantity = 1): boolean {
    return this.itemCount(key) >= quantity;
  }

  /** True when every requirement is satisfied by the current inventory. */
  hasRequirements(requirements: readonly ItemRequirement[]): boolean {
    return requirements.every((req) => this.hasItem(req.item, req.quantity));
  }

  /** The requirements that are still short, with how many are missing. */
  missingRequirements(requirements: readonly ItemRequirement[]): ItemRequirement[] {
    return requirements
      .map((req) => ({ item: req.item, quantity: req.quantity - this.itemCount(req.item) }))
      .filter((req) => req.quantity > 0);
  }

  // -- quests ------------------------------------------------------------

  questProgress(questId: number): QuestProgress | undefined {
    return this.snapshot.quests.find((q) => q.id === questId);
  }

  questDefinition(questId: number): Quest | undefined {
    return this.snapshot.questBook[questId];
  }

  isQuestActive(questId: number): boolean {
    return this.questProgress(questId)?.active ?? false;
  }

  isQuestCompleted(questId: number): boolean {
    return this.questProgress(questId)?.completed ?? false;
  }

  // -- combat ------------------------------------------------------------

  get inCombat(): boolean {
    return this.snapshot.combat.inCombat;
  }

  get isPlayerTurn(): boolean {
    return this.snapshot.combat.phase === 'playerTurn';
  }

  get aliveMonsters(): Monster[] {
    return this.snapshot.combat.monsters.filter((m) => m.alive);
  }

  get selectedMonster(): Monster | undefined {
    const { monsters, selectedTarget } = this.snapshot.combat;
    return monsters[selectedTarget];
  }

  skillBySlot(slot: number): Skill | undefined {
    return this.snapshot.combat.skills.find((s) => s.slot === slot);
  }

  /** Ready = off cooldown and affordable at the current mana. */
  isSkillReady(slot: number): boolean {
    const skill = this.skillBySlot(slot);
    if (!skill) return false;
    return skill.cooldownRemaining <= 0 && skill.manaCost <= this.snapshot.player.mp;
  }
}
