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
import { RuffleBridge, type RufflePlayerElement } from '@dfh/bridge-ruffle';

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
    });
    this.bridge.events.on('connected', () => this.update({ connected: true }));
    this.bridge.events.on('disconnected', () => this.update({ connected: false }));
    this.bridge.events.on('error', ({ message }) => this.update({ error: message }));
    this.bridge.events.on('death', () => this.log.warn('You died.'));
    this.bridge.events.on('levelUp', ({ level }) => this.log.info(`Level up! Now level ${level}.`));
  }

  get currentBot(): Bot {
    return this.bot;
  }

  get scriptHost(): ScriptHost {
    return this.host;
  }

  // -- lifecycle ---------------------------------------------------------

  /**
   * Swap the bridge. `mock` runs the built-in simulator so the UI and scripts
   * can be exercised with no game client at all.
   */
  async useBridge(kind: BridgeKind, player?: RufflePlayerElement): Promise<void> {
    await this.host.stop();
    await this.bridge.disconnect().catch(() => undefined);
    this.bot.detach();

    if (kind === 'ruffle') {
      if (!player) throw new Error('The Ruffle bridge needs a mounted player element');
      this.bridge = new RuffleBridge({ player });
    } else {
      this.bridge = new MockBridge({ seed: Date.now() % 100000, latencyMs: 120 });
    }

    this.bot = new Bot({ bridge: this.bridge, state: this.state, log: this.log, options: this.view.options });
    this.host = new ScriptHost(this.bot, this.log);
    this.host.events.on('statusChanged', ({ status }) => this.update({ scriptStatus: status }));
    this.traceBuffer = [];
    this.attachBridgeEvents();
    this.update({ bridgeKind: kind, traces: [], error: null, pendingLive: false });
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
