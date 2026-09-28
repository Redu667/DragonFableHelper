import {
  BridgeError,
  TypedEmitter,
  emptySnapshot,
  type BridgeEvents,
  type CombatState,
  type GameBridge,
  type GameCall,
  type GameCallArgs,
  type GameCallResults,
  type GameSnapshot,
  type Monster,
  type TraceEntry,
} from '@dfh/core';
import { CallbackRegistry, type CallbackAction, type CallbackNames } from './callbacks.js';
import { ClickInput, findRuffleCanvas, INPUT_ACTIONS, type InputAction, type InputTarget, type PointerEventFactory, type StagePoint } from './input.js';
import { CanvasPixelSource, PixelSensors, type BarSensor, type PixelSource, type PointSensor, type SensorReading } from './pixels.js';
import { defaultProfile, mergeProfile, type CombatSensorBinding, type DfProfile, type ProfileStore } from './profile.js';
import { getSharedNetworkTap, NetworkTap, type CapturedExchange } from './network-tap.js';
import { endpointName, extractState, parsePayload, type FieldAliases, type PlayerField } from './state-extractor.js';
import { deriveEvents, readCombatPhase } from './state-reader.js';
import type { RufflePlayerElement } from './ruffle-types.js';

export interface RuffleBridgeOptions {
  /** The `<ruffle-player>` element hosting DFLoader.swf. */
  player: RufflePlayerElement;
  /** Learned settings for this client; merged over the defaults. */
  profile?: Partial<DfProfile>;
  /** Where profile changes are persisted. */
  store?: ProfileStore;
  /** How often pixel sensors are sampled while connected. */
  pollIntervalMs?: number;
  /** Injection points for tests. */
  tap?: NetworkTap;
  canvas?: () => (InputTarget & { width?: number; height?: number }) | null;
  pixelSource?: () => PixelSource | null;
  clock?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  makeEvent?: PointerEventFactory;
}

/** Everything the bridge has learned about the running client. */
export interface DiscoveryReport {
  readyState: number | null;
  loggedIn: boolean;
  /** ExternalInterface callbacks the movie registered. */
  callbacksFound: string[];
  callbacksConfigured: CallbackNames;
  /** Server endpoints seen so far and the field names they carried. */
  endpoints: Record<string, { calls: number; lastStatus: number; keys: string[]; matched: PlayerField[] }>;
  exchanges: number;
  traceLines: number;
  /** Well-known input actions, split by whether a position is recorded. */
  inputRecorded: string[];
  inputMissing: string[];
  sensors: string[];
  lastSensorReading: SensorReading | null;
}

const MAX_TRACE_LINES = 500;

/**
 * Drives a real DragonFable client running under Ruffle, using only what
 * Ruffle actually provides:
 *
 * - **State** comes from the game's own server replies, observed through the
 *   page's `fetch` (Ruffle routes every movie request through it), parsed by
 *   the extractor. Mid-battle state, which never touches the network, comes
 *   from calibrated pixel sensors on the rendered frame.
 * - **Actions** go through an ExternalInterface callback when the client
 *   registers one, otherwise through a calibrated click on the canvas.
 *
 * Nothing here is guessed about the client's internals: callbacks are
 * discovered, field names are matched from live replies, and positions and
 * sensors are recorded by the user. `probe()` says what has been learned.
 */
export class RuffleBridge implements GameBridge {
  readonly id = 'ruffle';
  readonly events = new TypedEmitter<BridgeEvents>();

  readonly tap: NetworkTap;
  readonly callbacks: CallbackRegistry;
  readonly input: ClickInput;
  readonly sensors: PixelSensors;

  private profile: DfProfile;
  private readonly player: RufflePlayerElement;
  private readonly store: ProfileStore | null;
  private readonly pollIntervalMs: number;
  private readonly clock: () => number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private snapshot: GameSnapshot = emptySnapshot();
  private isConnected = false;
  private pollHandle: unknown = null;
  private offExchange: (() => void) | null = null;
  private traceLines = 0;
  private lastReading: SensorReading | null = null;
  private readonly endpoints: DiscoveryReport['endpoints'] = {};

  constructor(options: RuffleBridgeOptions) {
    this.player = options.player;
    this.store = options.store ?? null;
    this.profile = mergeProfile(mergeProfile(defaultProfile(), this.store?.load()), options.profile);
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.clock = options.clock ?? (() => Date.now());
    this.setIntervalFn = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

    this.tap = options.tap ?? getSharedNetworkTap();
    this.callbacks = new CallbackRegistry(this.player, this.profile.callbacks);

    const canvas = options.canvas ?? (() => findRuffleCanvas(this.player));
    this.input = new ClickInput({ target: canvas, map: this.profile.input, sleep: options.sleep, makeEvent: options.makeEvent });

    let cachedSource: { canvas: unknown; source: PixelSource } | null = null;
    const pixelSource =
      options.pixelSource ??
      (() => {
        const element = canvas() as HTMLCanvasElement | null;
        if (!element) return null;
        if (!cachedSource || cachedSource.canvas !== element) {
          cachedSource = { canvas: element, source: new CanvasPixelSource(element) };
        }
        return cachedSource.source;
      });
    this.sensors = new PixelSensors(pixelSource, this.profile.sensors);
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get currentProfile(): DfProfile {
    return this.profile;
  }

  // -- lifecycle ---------------------------------------------------------

  async connect(): Promise<void> {
    if (this.isConnected) return;
    this.isConnected = true;

    this.tap.install();
    this.offExchange = this.tap.events.on('exchange', (exchange) => this.ingest(exchange));
    // Anything captured before we connected still counts.
    for (const exchange of this.tap.history) this.ingest(exchange, true);

    this.watchTrace();

    this.pollHandle = this.setIntervalFn(() => this.pollSensors(), this.pollIntervalMs);
    this.events.emit('connected', undefined);
    this.events.emit('state', { connected: true });
    this.snapshot = { ...this.snapshot, connected: true };
  }

  async disconnect(): Promise<void> {
    if (this.pollHandle !== null) {
      this.clearIntervalFn(this.pollHandle);
      this.pollHandle = null;
    }
    this.offExchange?.();
    this.offExchange = null;
    try {
      this.player.traceObserver = null;
    } catch {
      /* the element may already be gone */
    }
    this.isConnected = false;
    this.events.emit('disconnected', { reason: 'bridge disconnected' });
  }

  private watchTrace(): void {
    try {
      this.player.traceObserver = (message: string) => {
        this.traceLines = Math.min(MAX_TRACE_LINES, this.traceLines + 1);
        this.emitTrace({ direction: 'fromGame', label: 'trace', payload: message, kind: 'trace' });
      };
    } catch {
      /* not a Ruffle element; nothing to observe */
    }
  }

  // -- state: network ----------------------------------------------------

  /** Feed one captured exchange through the extractor. */
  ingest(exchange: CapturedExchange, replay = false): void {
    const name = endpointName(exchange.url);
    const records = exchange.responseBody ? parsePayload(exchange.responseBody, exchange.contentType) : [];
    const { patch, matched } = extractState(records, this.snapshot, this.profile.aliases);
    const matchedFields = Object.keys(matched) as PlayerField[];

    const summary = this.endpoints[name] ?? { calls: 0, lastStatus: 0, keys: [], matched: [] };
    summary.calls += 1;
    summary.lastStatus = exchange.status;
    summary.keys = [...new Set([...summary.keys, ...records.map((r) => r.key)])].slice(0, 60);
    summary.matched = [...new Set([...summary.matched, ...matchedFields])];
    this.endpoints[name] = summary;

    if (!replay) {
      this.emitTrace({
        direction: 'toGame',
        label: name,
        payload: exchange.requestBody,
        kind: 'network',
        meta: { method: exchange.method, url: exchange.url },
      });
      this.emitTrace({
        direction: 'fromGame',
        label: name,
        payload: exchange.error ?? exchange.responseBody,
        kind: 'network',
        meta: { status: exchange.status, durationMs: exchange.durationMs, matched: matchedFields, keys: records.length },
      });
    }

    if (Object.keys(patch).length > 0) this.applyPatch(patch);
  }

  // -- state: pixels -----------------------------------------------------

  /** Sample the sensors and translate them into combat state. */
  pollSensors(): void {
    if (this.sensors.isEmpty) return;
    const reading = this.sensors.read(this.clock());
    if (!reading) return;
    this.lastReading = reading;

    const binding = this.profile.combat;
    const previous = this.snapshot.combat;
    const point = (name: string | undefined, fallback: boolean) =>
      name !== undefined && name in reading.points ? (reading.points[name] ?? fallback) : fallback;

    const inCombat = point(binding.inCombat, previous.inCombat);
    const playerTurn = point(binding.playerTurn, previous.phase === 'playerTurn');

    const monsters: Monster[] = (binding.monsterHp ?? []).flatMap((sensorName, index) => {
      const ratio = reading.bars[sensorName];
      if (ratio === undefined) return [];
      const existing = previous.monsters.find((m) => m.index === index);
      return [{
        index,
        id: existing?.id ?? 0,
        name: existing?.name || `Monster ${index + 1}`,
        level: existing?.level ?? 0,
        hp: Math.round(ratio * 100),
        maxHp: 100,
        element: existing?.element ?? 'none',
        alive: ratio > 0,
      }];
    });

    let phase = readCombatPhase(inCombat, playerTurn, monsters, this.snapshot.player.hp > 0);
    if (point(binding.victory, false)) phase = 'victory';
    if (point(binding.defeat, false)) phase = 'defeat';

    const combat: CombatState = {
      ...previous,
      inCombat: phase === 'victory' || phase === 'defeat' ? false : inCombat,
      phase,
      round: inCombat && !previous.inCombat ? 1 : previous.round + (inCombat && playerTurn && previous.phase === 'enemyTurn' ? 1 : 0),
      monsters: monsters.length > 0 ? monsters : previous.monsters,
    };

    const patch: Partial<GameSnapshot> = { combat };
    if (binding.playerHp !== undefined && reading.bars[binding.playerHp] !== undefined && this.snapshot.player.maxHp > 0) {
      const ratio = reading.bars[binding.playerHp] ?? 0;
      patch.player = { ...this.snapshot.player, hp: Math.round(ratio * this.snapshot.player.maxHp) };
    }
    this.applyPatch(patch);
  }

  private applyPatch(patch: Partial<GameSnapshot>): void {
    const previous = this.snapshot;
    const next: GameSnapshot = {
      ...previous,
      ...patch,
      player: patch.player ? { ...previous.player, ...patch.player } : previous.player,
      combat: patch.combat ? { ...previous.combat, ...patch.combat } : previous.combat,
    };
    this.snapshot = next;
    this.events.emit('state', patch);
    for (const event of deriveEvents(previous, next)) {
      this.events.emit(event.name as keyof BridgeEvents, event.payload as never);
    }
  }

  private emitTrace(entry: Omit<TraceEntry, 'timestamp'>): void {
    this.events.emit('trace', { timestamp: this.clock(), ...entry });
  }

  // -- actions -----------------------------------------------------------

  async call<K extends GameCall>(
    name: K,
    ...args: GameCallArgs[K] extends void ? [] : [GameCallArgs[K]]
  ): Promise<GameCallResults[K]> {
    const payload = args[0];
    this.emitTrace({ direction: 'toGame', label: name, payload, kind: 'call' });
    const result = await this.dispatch(name, payload as never);
    return result as GameCallResults[K];
  }

  private async dispatch(name: GameCall, payload: never): Promise<unknown> {
    switch (name) {
      case 'session.snapshot':
        return this.snapshot;
      case 'session.reload':
        await this.player.ruffle?.(1)?.reload();
        return undefined;

      case 'combat.attack':
        return this.act('attack', 'attack', name);
      case 'combat.useSkill': {
        const { slot, targetIndex } = payload as { slot: number; targetIndex?: number };
        if (targetIndex !== undefined) await this.act('selectTarget', `target${targetIndex}`, name, [targetIndex]);
        return this.act('useSkill', `skill${slot}`, name, [slot]);
      }
      case 'combat.selectTarget': {
        const { targetIndex } = payload as { targetIndex: number };
        await this.act('selectTarget', `target${targetIndex}`, name, [targetIndex]);
        this.applyPatch({ combat: { ...this.snapshot.combat, selectedTarget: targetIndex } });
        return undefined;
      }
      case 'combat.flee':
        await this.act('flee', 'flee', name);
        return true;
      case 'combat.acknowledge':
        return this.act('acknowledge', 'acknowledge', name);

      case 'player.rest':
        return this.act('rest', 'rest', name);
      case 'player.equip':
        return this.callbacks.invoke('equipItem', [(payload as { itemId: number }).itemId], name);
      case 'player.useItem':
        return this.callbacks.invoke('useItem', [(payload as { itemId: number }).itemId], name);

      case 'quest.load': {
        const { questId } = payload as { questId: number };
        if (this.callbacks.has('loadQuest')) return this.callbacks.invoke('loadQuest', [questId], name);
        // Quest definitions only arrive over the network once accepted.
        return this.snapshot.questBook[questId] ?? null;
      }
      case 'quest.accept': {
        const { questId } = payload as { questId: number };
        await this.act('acceptQuest', 'acceptQuest', name, [questId]);
        return true;
      }
      case 'quest.turnIn': {
        const { questId } = payload as { questId: number };
        await this.act('turnInQuest', 'turnInQuest', name, [questId]);
        return { rewards: [] };
      }
      case 'quest.abandon':
        return this.callbacks.invoke('abandonQuest', [(payload as { questId: number }).questId], name);

      case 'shop.load':
        return this.callbacks.invoke('loadShop', [(payload as { shopId: number }).shopId], name);
      case 'shop.buy': {
        const { shopId, itemId, quantity } = payload as { shopId: number; itemId: number; quantity?: number };
        return this.callbacks.invoke('buyItem', [shopId, itemId, quantity ?? 1], name);
      }
      case 'shop.sell': {
        const { itemId, quantity } = payload as { itemId: number; quantity?: number };
        return this.callbacks.invoke('sellItem', [itemId, quantity ?? 1], name);
      }

      case 'travel.town':
        return this.callbacks.invoke('travelTown', [(payload as { town: string }).town], name);
      case 'travel.hub':
        return this.callbacks.invoke('travelHub', [], name);

      case 'ui.skipCutscene':
      case 'ui.dismissDialogue':
        return this.act('skipCutscene', 'skipCutscene', name);

      default:
        throw new BridgeError(`Unknown call "${name}"`, name);
    }
  }

  /**
   * Perform an action through whichever channel is available: a registered
   * callback first, then a calibrated click. Otherwise say exactly what is
   * missing.
   */
  private async act(callback: CallbackAction, click: string, call: GameCall, args: unknown[] = []): Promise<unknown> {
    if (this.callbacks.has(callback)) {
      return this.callbacks.invoke(callback, args, call);
    }
    if (this.input.has(click)) {
      await this.input.click(click);
      this.emitTrace({ direction: 'toGame', label: click, payload: this.input.inputMap[click], kind: 'input' });
      return undefined;
    }
    throw new BridgeError(
      `"${call}" has no way to reach the game yet: the client registered no "${callback}" callback ` +
        `(found: ${this.callbacks.discovered.join(', ') || 'none'}) and no click position is recorded for "${click}". ` +
        `Open the Live panel and record "${click}".`,
      call,
    );
  }

  // -- discovery and calibration ----------------------------------------

  probe(): DiscoveryReport {
    const recorded = new Set(Object.keys(this.input.inputMap));
    return {
      readyState: typeof this.player.readyState === 'number' ? this.player.readyState : null,
      loggedIn: this.snapshot.loggedIn,
      callbacksFound: this.callbacks.discovered,
      callbacksConfigured: this.callbacks.configured,
      endpoints: JSON.parse(JSON.stringify(this.endpoints)) as DiscoveryReport['endpoints'],
      exchanges: this.tap.history.length,
      traceLines: this.traceLines,
      inputRecorded: INPUT_ACTIONS.filter((a) => recorded.has(a)),
      inputMissing: INPUT_ACTIONS.filter((a) => !recorded.has(a)),
      sensors: [...this.sensors.sensorSpec.points.map((s) => s.name), ...this.sensors.sensorSpec.bars.map((s) => s.name)],
      lastSensorReading: this.lastReading,
    };
  }

  /** Wait for the user's next click on the game and record it as `action`. */
  async calibrateClick(action: InputAction | string, signal?: AbortSignal): Promise<StagePoint> {
    const point = await this.input.captureNext(action, { signal });
    this.updateProfile({ input: { ...this.profile.input, [action]: point } });
    return point;
  }

  /** Record the colour currently at `point` as a named on/off sensor. */
  addPointSensor(name: string, point: StagePoint, tolerance?: number): PointSensor | null {
    const color = this.sensors.peek(point);
    if (!color) return null;
    const sensor: PointSensor = { name, x: point.x, y: point.y, color, tolerance };
    this.sensors.addPoint(sensor);
    this.updateProfile({ sensors: this.sensors.sensorSpec });
    return sensor;
  }

  /** Record a bar between two points, coloured like its start. */
  addBarSensor(name: string, from: StagePoint, to: StagePoint, tolerance?: number): BarSensor | null {
    const color = this.sensors.peek(from);
    if (!color) return null;
    const sensor: BarSensor = { name, from, to, color, tolerance };
    this.sensors.addBar(sensor);
    this.updateProfile({ sensors: this.sensors.sensorSpec });
    return sensor;
  }

  removeSensor(name: string): void {
    this.sensors.remove(name);
    this.updateProfile({ sensors: this.sensors.sensorSpec });
  }

  setCallbackNames(names: CallbackNames): void {
    this.callbacks.setNames(names);
    this.updateProfile({ callbacks: names });
  }

  setAliases(aliases: FieldAliases): void {
    this.updateProfile({ aliases });
  }

  setCombatBinding(binding: CombatSensorBinding): void {
    this.updateProfile({ combat: binding });
  }

  private updateProfile(patch: Partial<DfProfile>): void {
    this.profile = mergeProfile(this.profile, patch);
    if (patch.input) this.input.setMap(this.profile.input);
    this.store?.save(this.profile);
  }
}
