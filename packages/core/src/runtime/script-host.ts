import { CancellationError, CancellationSource, CancellationToken } from '../util/async.js';
import { TypedEmitter } from '../util/events.js';
import type { Bot } from '../api/bot.js';
import type { Logger } from './logger.js';

export type ScriptStatus = 'idle' | 'running' | 'stopping' | 'stopped' | 'failed' | 'completed';

export interface ScriptSource {
  /** Stable identifier, usually the file path. */
  id: string;
  name: string;
  /**
   * Script body. Either an ES module with a default export, or a bare
   * statement body - both forms are accepted (see {@link ScriptHost.run}).
   */
  code: string;
}

export type ScriptFunction = (bot: Bot) => unknown | Promise<unknown>;

export interface ScriptHostEvents {
  statusChanged: { status: ScriptStatus; script: ScriptSource | null };
  finished: { status: ScriptStatus; error: Error | null };
}

/**
 * Storage seam for scripts. Desktop uses the filesystem; mobile uses the
 * webview's own storage, so core never imports `node:fs`.
 */
export interface ScriptStorage {
  list(): Promise<ScriptSource[]>;
  read(id: string): Promise<ScriptSource>;
  write(script: ScriptSource): Promise<void>;
  remove(id: string): Promise<void>;
}

/** In-memory storage, used by tests and as the mobile fallback. */
export class MemoryScriptStorage implements ScriptStorage {
  private readonly scripts = new Map<string, ScriptSource>();

  constructor(initial: ScriptSource[] = []) {
    for (const script of initial) this.scripts.set(script.id, script);
  }

  async list(): Promise<ScriptSource[]> {
    return [...this.scripts.values()];
  }

  async read(id: string): Promise<ScriptSource> {
    const script = this.scripts.get(id);
    if (!script) throw new Error(`No script with id "${id}"`);
    return script;
  }

  async write(script: ScriptSource): Promise<void> {
    this.scripts.set(script.id, script);
  }

  async remove(id: string): Promise<void> {
    this.scripts.delete(id);
  }
}

/**
 * Compiles script text into a callable.
 *
 * Uses `AsyncFunction` rather than `node:vm` or dynamic `import()` so the same
 * code path works in an Electron renderer and in an Android WebView. This is
 * *not* a security sandbox - scripts run with the app's own privileges, so
 * only run scripts you have read. Two shapes are supported:
 *
 *   export default async function (bot) { ... }   // module style
 *   await bot.grind({ questId: 1 })               // bare body
 */
export function compileScript(source: ScriptSource): ScriptFunction {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...callArgs: unknown[]) => Promise<unknown>;

  const hasDefaultExport = /export\s+default/.test(source.code);
  const body = hasDefaultExport
    ? // Rewrite the module form into an expression we can evaluate and call.
      // The trailing semicolon of `export default async (bot) => ...;` would
      // be a syntax error inside the parentheses, so drop it.
      `const __script = (${source.code.replace(/export\s+default\s+/, '').trim().replace(/;+$/, '')});
       return await __script(bot);`
    : source.code;

  try {
    const fn = new AsyncFunction('bot', body);
    return (bot: Bot) => fn(bot);
  } catch (error) {
    throw new Error(`Failed to compile script "${source.name}": ${(error as Error).message}`);
  }
}

/** Owns the lifecycle of the one script that is allowed to run at a time. */
export class ScriptHost {
  readonly events = new TypedEmitter<ScriptHostEvents>();

  private source = new CancellationSource();
  private currentStatus: ScriptStatus = 'idle';
  private currentScript: ScriptSource | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly log: Logger,
  ) {}

  get status(): ScriptStatus {
    return this.currentStatus;
  }

  get script(): ScriptSource | null {
    return this.currentScript;
  }

  get isRunning(): boolean {
    return this.currentStatus === 'running' || this.currentStatus === 'stopping';
  }

  get token(): CancellationToken {
    return this.source.token;
  }

  /**
   * Compile and run a script. Rejects if one is already running; the returned
   * promise settles when the script finishes, stops or throws.
   */
  async run(source: ScriptSource): Promise<void> {
    return this.execute(source, compileScript(source));
  }

  /**
   * Run an already-prepared function under the same lifecycle as a script.
   *
   * Built-in jobs (the grind panel, for example) go through here so that Stop,
   * status reporting and error handling behave identically for them and for
   * user scripts.
   */
  async runFunction(name: string, fn: ScriptFunction): Promise<void> {
    return this.execute({ id: `<${name}>`, name, code: '' }, fn);
  }

  private async execute(source: ScriptSource, fn: ScriptFunction): Promise<void> {
    if (this.isRunning) throw new Error('A script is already running - stop it first');

    this.source = new CancellationSource();
    this.bot.setCancellationToken(this.source.token);
    this.currentScript = source;
    this.setStatus('running');
    this.log.info(`Running script "${source.name}"`);

    this.running = (async () => {
      try {
        await fn(this.bot);
        if (this.source.token.isCancelled) {
          this.setStatus('stopped');
          this.events.emit('finished', { status: 'stopped', error: null });
        } else {
          this.setStatus('completed');
          this.log.info(`Script "${source.name}" completed`);
          this.events.emit('finished', { status: 'completed', error: null });
        }
      } catch (error) {
        if (error instanceof CancellationError) {
          this.setStatus('stopped');
          this.log.info(`Script "${source.name}" stopped`);
          this.events.emit('finished', { status: 'stopped', error: null });
          return;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        this.setStatus('failed');
        this.log.error(`Script "${source.name}" failed: ${err.message}`);
        this.events.emit('finished', { status: 'failed', error: err });
      } finally {
        this.bot.setCancellationToken(CancellationToken.none);
        this.running = null;
      }
    })();

    return this.running;
  }

  /** Signal the script to stop and wait for it to unwind. */
  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.setStatus('stopping');
    this.source.cancel();
    await this.running?.catch(() => undefined);
  }

  private setStatus(status: ScriptStatus): void {
    this.currentStatus = status;
    this.events.emit('statusChanged', { status, script: this.currentScript });
  }
}
