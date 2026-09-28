import type { TypedEmitter } from '../util/events.js';
import type { GameSnapshot, Item, Monster, Quest, Shop } from '../state/types.js';

/**
 * Every action the bot can ask the game client to perform.
 *
 * These are *abstract* operations. A {@link GameBridge} implementation is
 * responsible for translating them into whatever the real client understands
 * (an ExternalInterface callback, an AS2 `SetVariable` write, a synthesised
 * click on the Flash stage, ...). Keeping scripts on this side of the seam
 * means a change in the game client never rewrites anyone's scripts.
 */
export interface GameCallArgs {
  'session.snapshot': void;
  'session.reload': void;

  'player.rest': void;
  'player.equip': { itemId: number };
  'player.useItem': { itemId: number };

  'combat.attack': { targetIndex?: number };
  'combat.useSkill': { slot: number; targetIndex?: number };
  'combat.selectTarget': { targetIndex: number };
  'combat.flee': void;
  /** Acknowledge the victory/defeat screen so the client returns to the map. */
  'combat.acknowledge': void;

  'quest.load': { questId: number };
  'quest.accept': { questId: number };
  'quest.turnIn': { questId: number; rewardIndex?: number };
  'quest.abandon': { questId: number };

  'shop.load': { shopId: number };
  'shop.buy': { shopId: number; itemId: number; quantity?: number };
  'shop.sell': { itemId: number; quantity?: number };

  'travel.town': { town: string };
  'travel.hub': void;

  'ui.skipCutscene': void;
  'ui.dismissDialogue': void;
}

export interface GameCallResults {
  'session.snapshot': GameSnapshot;
  'session.reload': void;

  'player.rest': void;
  'player.equip': void;
  'player.useItem': void;

  'combat.attack': void;
  'combat.useSkill': void;
  'combat.selectTarget': void;
  'combat.flee': boolean;
  'combat.acknowledge': void;

  'quest.load': Quest | null;
  'quest.accept': boolean;
  'quest.turnIn': { rewards: Item[] };
  'quest.abandon': void;

  'shop.load': Shop | null;
  'shop.buy': boolean;
  'shop.sell': boolean;

  'travel.town': void;
  'travel.hub': void;

  'ui.skipCutscene': void;
  'ui.dismissDialogue': void;
}

export type GameCall = keyof GameCallArgs;

/** Direction of a logged message, for the packet/trace inspector. */
export type TraceDirection = 'toGame' | 'fromGame';

/** What produced a trace entry. Plain bridge calls when omitted. */
export type TraceKind = 'call' | 'network' | 'trace' | 'input';

export interface TraceEntry {
  timestamp: number;
  direction: TraceDirection;
  label: string;
  payload: unknown;
  kind?: TraceKind;
  /** Free-form details the inspector can render: status, duration, ... */
  meta?: Record<string, unknown>;
}

export interface BridgeEvents {
  connected: void;
  disconnected: { reason: string };
  /** A fresh full or partial snapshot arrived from the client. */
  state: Partial<GameSnapshot>;
  loggedIn: { name: string };
  combatStart: { monsters: Monster[] };
  combatEnd: { victory: boolean };
  /** The client handed control back to the player. */
  turnStart: { round: number };
  monsterDefeated: { monster: Monster };
  itemReceived: { item: Item };
  questAccepted: { questId: number };
  questCompleted: { questId: number; rewards: Item[] };
  levelUp: { level: number };
  death: void;
  cutscene: { active: boolean };
  /** Raw traffic for the inspector panel. */
  trace: TraceEntry;
  error: { message: string; fatal: boolean };
}

/**
 * The single seam between DragonFableHelper and a running DragonFable client.
 *
 * Implementations in this repo:
 *  - `MockBridge`   - a simulated game, so the bot engine, scripts and UI can
 *                     be developed and tested without touching a live server.
 *  - `RuffleBridge` - drives a real client running under Ruffle in a webview
 *                     (`@dfh/bridge-ruffle`).
 */
export interface GameBridge {
  readonly id: string;
  readonly events: TypedEmitter<BridgeEvents>;
  readonly connected: boolean;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  call<K extends GameCall>(
    name: K,
    ...args: GameCallArgs[K] extends void ? [] : [GameCallArgs[K]]
  ): Promise<GameCallResults[K]>;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly call?: GameCall,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}
