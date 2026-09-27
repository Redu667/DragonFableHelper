import {
  Bot,
  GameState,
  Logger,
  MockBridge,
  ScriptHost,
  defaultBotOptions,
  type BotOptions,
  type GameBridge,
  type GameSnapshot,
  type GrindPlan,
  type GrindProgress,
  type LogEntry,
  type ScriptSource,
  type ScriptStatus,
  type TraceEntry,
} from '@dfh/core';
import {
  LocalStorageProfileStore,
  RuffleBridge,
  type CallbackNames,
  type CombatSensorBinding,
  type DiscoveryReport,
  type RufflePlayerElement,
  type StagePoint,
} from '@dfh/bridge-ruffle';

export type BridgeKind = 'mock' | 'ruffle';

export interface SessionView {
  bridgeKind: BridgeKind;
  connected: boolean;
  snapshot: GameSnapshot;
  logs: readonly LogEntry[];
  traces: readonly TraceEntry[];
  scriptStatus: ScriptStatus;
  grind: GrindProgress | null;
  options: BotOptions;
  error: string | null;
  /** The live stage is mounting; the bridge swaps once the player is ready. */
  pendingLive: boolean;
  /** What the live bridge has learned so far; null on the mock. */
  discovery: DiscoveryReport | null;
  /** A calibration is waiting for a click in the game; describes what for. */
  calibrating: string | null;
}

/**
 * Owns the bot, its bridge and the script host, and exposes a snapshot the
 * React tree can subscribe to.
 *
 * Deliberately framework-free and platform-free: the same instance backs the
 * Electron renderer and the Android WebView.
 */
export class BotSession {
  readonly log = new Logger('app', 'debug');
  readonly state = new GameState();

  private listeners = new Set<() => void>();
  private bridge: GameBridge;
  private bot: Bot;
  private host: ScriptHost;
  private view: SessionView;
  private traceBuffer: TraceEntry[] = [];
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private calibration: AbortController | null = null;

  constructor(kind: BridgeKind = 'mock') {
    this.bridge = new MockBridge({ seed: Date.now() % 100000, latencyMs: 120 });
    this.bot = new Bot({ bridge: this.bridge, state: this.state, log: this.log });
    this.host = new ScriptHost(this.bot, this.log);

    this.view = {
      bridgeKind: kind,
      connected: false,
      snapshot: this.state.current,
      logs: [],
      traces: [],
      scriptStatus: 'idle',
      grind: null,
      options: { ...defaultBotOptions },
      error: null,
      pendingLive: kind === 'ruffle',
      discovery: null,
      calibrating: null,
    };

    this.wire();
  }

  // -- React integration (useSyncExternalStore) --------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionView => this.view;

  private update(patch: Partial<SessionView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  private wire(): void {
    this.state.events.on('changed', (snapshot) => this.update({ snapshot }));
    this.log.events.on('entry', () => this.update({ logs: [...this.log.entries] }));
    this.host.events.on('statusChanged', ({ status }) => this.update({ scriptStatus: status }));
    this.attachBridgeEvents();
  }

  private attachBridgeEvents(): void {
    this.bridge.events.on('trace', (entry) => {
      this.traceBuffer = [...this.traceBuffer.slice(-499), entry];
      this.update({ traces: this.traceBuffer });
      // New traffic may have taught the live bridge something.
      if (entry.kind === 'network' || entry.kind === 'trace') this.scheduleDiscovery();
    });
    this.bridge.events.on('connected', () => {
      this.update({ connected: true });
      this.refreshDiscovery();
    });
    this.bridge.events.on('disconnected', () => this.update({ connected: false }));
    this.bridge.events.on('error', ({ message }) => this.update({ error: message }));
    this.bridge.events.on('death', () => this.log.warn('You died.'));
    this.bridge.events.on('levelUp', ({ level }) => this.log.info(`Level up! Now level ${level}.`));
    this.bridge.events.on('loggedIn', ({ name }) => this.log.info(`Logged in as ${name}.`));
  }

  get currentBot(): Bot {
    return this.bot;
  }

  get scriptHost(): ScriptHost {
    return this.host;
  }

  /** The live bridge, when that is what is connected. */
  get live(): RuffleBridge | null {
    return this.bridge instanceof RuffleBridge ? this.bridge : null;
  }

  // -- lifecycle ---------------------------------------------------------

  /**
   * Swap the bridge. `mock` runs the built-in simulator so the UI and scripts
   * can be exercised with no game client at all.
   */
  async useBridge(kind: BridgeKind, player?: RufflePlayerElement): Promise<void> {
    await this.host.stop();
    this.cancelCalibration();
    await this.bridge.disconnect().catch(() => undefined);
    this.bot.detach();

    if (kind === 'ruffle') {
      if (!player) throw new Error('The Ruffle bridge needs a mounted player element');
      this.bridge = new RuffleBridge({ player, store: new LocalStorageProfileStore() });
    } else {
      this.bridge = new MockBridge({ seed: Date.now() % 100000, latencyMs: 120 });
    }

    this.bot = new Bot({ bridge: this.bridge, state: this.state, log: this.log, options: this.view.options });
    this.host = new ScriptHost(this.bot, this.log);
    this.host.events.on('statusChanged', ({ status }) => this.update({ scriptStatus: status }));
    this.traceBuffer = [];
    this.attachBridgeEvents();
    this.update({ bridgeKind: kind, traces: [], error: null, pendingLive: false, discovery: null });
  }

  /** Ask the UI to mount the real client; `useBridge` follows once it loads. */
  setPendingLive(): void {
    this.update({ pendingLive: true });
  }

  setBridgeError(message: string): void {
    this.log.error(message);
    this.update({ error: message, pendingLive: false });
  }

  async connect(): Promise<void> {
    try {
      await this.bot.start();
      this.update({ error: null });
    } catch (error) {
      const message = (error as Error).message;
      this.log.error(`Connect failed: ${message}`);
      this.update({ error: message });
    }
  }

  setOptions(patch: Partial<BotOptions>): void {
    Object.assign(this.bot.options, patch);
    this.update({ options: { ...this.bot.options } });
  }

  // -- live bridge: discovery and calibration ---------------------------

  refreshDiscovery(): void {
    this.update({ discovery: this.live?.probe() ?? null });
  }

  private scheduleDiscovery(): void {
    if (this.discoveryTimer !== null) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      this.refreshDiscovery();
    }, 300);
  }

  /** Record the user's next click in the game as the position of `action`. */
  async calibrateClick(action: string): Promise<void> {
    const live = this.live;
    if (!live) return;
    this.cancelCalibration();
    this.calibration = new AbortController();
    this.update({ calibrating: `Click the "${action}" button in the game` });
    try {
      const point = await live.calibrateClick(action, this.calibration.signal);
      this.log.info(`Recorded "${action}" at (${point.x}, ${point.y}).`);
    } catch (error) {
      this.log.warn((error as Error).message);
    } finally {
      this.calibration = null;
      this.update({ calibrating: null });
      this.refreshDiscovery();
    }
  }

  /** Sample the pixel the user clicks next and store it as an on/off sensor. */
  async calibratePointSensor(name: string): Promise<void> {
    const live = this.live;
    if (!live || !name) return;
    this.cancelCalibration();
    this.calibration = new AbortController();
    this.update({ calibrating: `Click the spot in the game that should mean "${name}"` });
    try {
      const point = await live.input.capturePoint({ signal: this.calibration.signal });
      const sensor = live.addPointSensor(name, point);
      if (sensor) this.log.info(`Sensor "${name}" at (${point.x}, ${point.y}) = rgb(${sensor.color.join(', ')}).`);
      else this.log.warn('Could not read pixels from the game canvas. Is the canvas renderer on?');
    } catch (error) {
      this.log.warn((error as Error).message);
    } finally {
      this.calibration = null;
      this.update({ calibrating: null });
      this.refreshDiscovery();
    }
  }

  /** Two clicks: the full end and the empty end of a bar. */
  async calibrateBarSensor(name: string): Promise<void> {
    const live = this.live;
    if (!live || !name) return;
    this.cancelCalibration();
    this.calibration = new AbortController();
    const { signal } = this.calibration;
    try {
      this.update({ calibrating: `Click the FULL end of the "${name}" bar` });
      const from = await live.input.capturePoint({ signal });
      this.update({ calibrating: `Now click the EMPTY end of the "${name}" bar` });
      const to = await live.input.capturePoint({ signal });
      const sensor = live.addBarSensor(name, from, to);
      if (sensor) this.log.info(`Bar "${name}" from (${from.x}, ${from.y}) to (${to.x}, ${to.y}).`);
      else this.log.warn('Could not read pixels from the game canvas.');
    } catch (error) {
      this.log.warn((error as Error).message);
    } finally {
      this.calibration = null;
      this.update({ calibrating: null });
      this.refreshDiscovery();
    }
  }

  cancelCalibration(): void {
    this.calibration?.abort();
    this.calibration = null;
    if (this.view.calibrating) this.update({ calibrating: null });
  }

  removeSensor(name: string): void {
    this.live?.removeSensor(name);
    this.refreshDiscovery();
  }

  setCallbackNames(names: CallbackNames): void {
    this.live?.setCallbackNames(names);
    this.refreshDiscovery();
  }

  setCombatBinding(binding: CombatSensorBinding): void {
    this.live?.setCombatBinding(binding);
    this.refreshDiscovery();
  }

  /** Sample a stage point right now, for the panel's colour readout. */
  peekPixel(point: StagePoint): [number, number, number] | null {
    return this.live?.sensors.peek(point) ?? null;
  }

  // -- actions -----------------------------------------------------------

  async startGrind(plan: GrindPlan): Promise<void> {
    if (this.host.isRunning) return;
    this.update({ grind: null });
    await this.host
      .runFunction(`grind quest ${plan.questId}`, (bot) =>
        bot.grind(plan, (progress) => this.update({ grind: progress })),
      )
      .catch(() => undefined);
  }

  async runScript(source: ScriptSource): Promise<void> {
    await this.host.run(source).catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.host.stop();
  }

  clearLogs(): void {
    this.log.clear();
    this.update({ logs: [] });
  }
}
