import {
  BridgeError,
  TypedEmitter,
  emptySnapshot,
  type BridgeEvents,
  type GameBridge,
  type GameCall,
  type GameCallArgs,
  type GameCallResults,
  type GameSnapshot,
} from '@dfh/core';
import { createFlashReader, defaultSymbolMap, probeSymbols, type DfSymbolMap, type GameValueReader, type ProbeResult } from './df-symbols.js';
import type { RufflePlayerElement } from './ruffle-types.js';
import { deriveEvents, readSnapshot } from './state-reader.js';

export interface RuffleBridgeOptions {
  /** The `<ruffle-player>` element hosting DFLoader.swf. */
  player: RufflePlayerElement;
  /** Override any symbol paths that differ in your client. */
  symbols?: Partial<DfSymbolMap>;
  /** How often to re-read game state. 250ms keeps combat responsive. */
  pollIntervalMs?: number;
  /** Injected in tests; defaults to Ruffle's AVM1 GetVariable/SetVariable. */
  reader?: GameValueReader;
}

/**
 * Drives a real DragonFable client running under Ruffle.
 *
 * The client does not push state, so the bridge polls the game's variables
 * and diffs successive snapshots into the event stream that `@dfh/core`
 * consumes. Actions prefer an `ExternalInterface` callback when the client
 * exposes one - that runs the game's own logic - and fall back to writing
 * variables.
 *
 * Because the same code runs in an Electron renderer and an Android WebView,
 * desktop and mobile share this one implementation.
 */
export class RuffleBridge implements GameBridge {
  readonly id = 'ruffle';
  readonly events = new TypedEmitter<BridgeEvents>();

  readonly symbols: DfSymbolMap;
  private readonly player: RufflePlayerElement;
  private readonly reader: GameValueReader;
  private readonly pollIntervalMs: number;

  private snapshot: GameSnapshot = emptySnapshot();
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private isConnected = false;

  constructor(options: RuffleBridgeOptions) {
    this.player = options.player;
    this.symbols = { ...defaultSymbolMap, ...options.symbols, callbacks: { ...defaultSymbolMap.callbacks, ...options.symbols?.callbacks } };
    this.reader = options.reader ?? createFlashReader(options.player);
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** Which symbols resolve against the client right now. */
  probe(): ProbeResult {
    return probeSymbols(this.reader, this.player, this.symbols);
  }

  async connect(): Promise<void> {
    if (this.isConnected) return;
    this.isConnected = true;
    this.poll();
    this.pollHandle = setInterval(() => this.poll(), this.pollIntervalMs);
    this.events.emit('connected', undefined);

    const probe = this.probe();
    if (!probe.usable) {
      this.events.emit('error', {
        message:
          'Could not read player HP from the client. The symbol map needs updating for this build - ' +
          `unresolved: ${probe.unresolved.join(', ')}`,
        fatal: false,
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.isConnected = false;
    this.events.emit('disconnected', { reason: 'bridge disconnected' });
  }

  /** Read the game once and publish whatever changed. */
  poll(): GameSnapshot {
    const patch = readSnapshot(this.reader, this.symbols, this.snapshot);
    const next: GameSnapshot = { ...this.snapshot, ...patch } as GameSnapshot;
    const previous = this.snapshot;
    this.snapshot = next;

    this.events.emit('state', patch);
    for (const event of deriveEvents(previous, next)) {
      // The derived names are a subset of BridgeEvents, checked by the cast site.
      this.events.emit(event.name as keyof BridgeEvents, event.payload as never);
    }
    return next;
  }

  async call<K extends GameCall>(
    name: K,
    ...args: GameCallArgs[K] extends void ? [] : [GameCallArgs[K]]
  ): Promise<GameCallResults[K]> {
    const payload = args[0];
    this.events.emit('trace', { timestamp: Date.now(), direction: 'toGame', label: name, payload });

    const result = await this.dispatch(name, payload as never);
    // Actions change the world, so refresh instead of waiting for the next tick.
    this.poll();
    return result as GameCallResults[K];
  }

  private async dispatch(name: GameCall, payload: never): Promise<unknown> {
    const { callbacks } = this.symbols;

    switch (name) {
      case 'session.snapshot':
        return this.poll();

      case 'session.reload':
        this.player.play?.();
        return undefined;

      case 'player.rest':
        return this.invoke(callbacks.rest, [], 'player.rest');

      case 'player.equip':
        return this.invoke(callbacks.equipItem, [(payload as { itemId: number }).itemId], 'player.equip');

      case 'combat.attack':
        return this.invoke(callbacks.attack, [], 'combat.attack');

      case 'combat.useSkill': {
        const { slot, targetIndex } = payload as { slot: number; targetIndex?: number };
        if (targetIndex !== undefined) await this.dispatch('combat.selectTarget', { targetIndex } as never);
        return this.invoke(callbacks.useSkill, [slot], 'combat.useSkill');
      }

      case 'combat.selectTarget':
        return this.invoke(callbacks.selectTarget, [(payload as { targetIndex: number }).targetIndex], 'combat.selectTarget');

      case 'combat.flee':
        return this.invoke(callbacks.flee, [], 'combat.flee');

      case 'quest.accept':
        return this.invoke(callbacks.acceptQuest, [(payload as { questId: number }).questId], 'quest.accept');

      case 'quest.turnIn':
        return this.invoke(callbacks.turnInQuest, [(payload as { questId: number }).questId], 'quest.turnIn');

      case 'travel.town':
        return this.invoke(callbacks.travelTown, [(payload as { town: string }).town], 'travel.town');

      case 'ui.skipCutscene':
      case 'ui.dismissDialogue':
        return this.invoke(callbacks.skipCutscene, [], name);

      // Everything below needs client support this bridge cannot synthesise
      // safely; they are deliberately explicit rather than silent no-ops.
      case 'combat.acknowledge':
      case 'player.useItem':
      case 'quest.load':
      case 'quest.abandon':
      case 'shop.load':
      case 'shop.buy':
      case 'shop.sell':
      case 'travel.hub':
        throw new BridgeError(
          `"${name}" is not wired up for the Ruffle bridge yet - add the client callback to the symbol map`,
          name,
        );

      default:
        throw new BridgeError(`Unknown call "${name}"`, name);
    }
  }

  /** Call an ExternalInterface callback the movie registered. */
  private invoke(callbackName: string | undefined, args: unknown[], call: GameCall): unknown {
    if (!callbackName) {
      throw new BridgeError(`No callback configured for "${call}"`, call);
    }
    const fn = this.player[callbackName];
    if (typeof fn !== 'function') {
      throw new BridgeError(
        `The client does not expose "${callbackName}" for "${call}". Run probe() and update the symbol map.`,
        call,
      );
    }
    try {
      return (fn as (...fnArgs: unknown[]) => unknown).apply(this.player, args);
    } catch (error) {
      throw new BridgeError(`"${callbackName}" threw: ${(error as Error).message}`, call);
    }
  }
}
