import { BridgeError, type GameCall } from '@dfh/core';

/**
 * Actions the bridge may ask the game to perform through an
 * `ExternalInterface` callback, when the client registers one.
 */
export type CallbackAction =
  | 'attack' | 'useSkill' | 'selectTarget' | 'flee' | 'acknowledge'
  | 'acceptQuest' | 'turnInQuest' | 'loadQuest' | 'abandonQuest'
  | 'rest' | 'equipItem' | 'useItem'
  | 'loadShop' | 'buyItem' | 'sellItem'
  | 'travelTown' | 'travelHub' | 'skipCutscene';

/** Callback name per action. Only the names the client actually registers matter. */
export type CallbackNames = Partial<Record<CallbackAction, string>>;

/**
 * Every callback the movie has registered with `ExternalInterface.addCallback`.
 *
 * Ruffle defines each one as an own, callable property of the
 * `<ruffle-player>` element; Ruffle's own API lives on the prototype, so
 * "own property that is a function" is exactly the set of game callbacks.
 */
export function discoverCallbacks(player: object): string[] {
  return Object.getOwnPropertyNames(player)
    .filter((name) => typeof (player as Record<string, unknown>)[name] === 'function')
    .sort();
}

/** Resolves abstract actions to whatever callbacks the client exposes. */
export class CallbackRegistry {
  constructor(
    private readonly player: object,
    private names: CallbackNames = {},
  ) {}

  get discovered(): string[] {
    return discoverCallbacks(this.player);
  }

  get configured(): CallbackNames {
    return { ...this.names };
  }

  setNames(names: CallbackNames): void {
    this.names = { ...names };
  }

  /** The callback name for an action, if configured and present on the client. */
  resolve(action: CallbackAction): string | undefined {
    const name = this.names[action];
    if (!name) return undefined;
    return typeof (this.player as Record<string, unknown>)[name] === 'function' ? name : undefined;
  }

  has(action: CallbackAction): boolean {
    return this.resolve(action) !== undefined;
  }

  invoke(action: CallbackAction, args: unknown[], call: GameCall): unknown {
    const name = this.resolve(action);
    if (!name) {
      const configured = this.names[action];
      throw new BridgeError(
        configured
          ? `The client does not expose "${configured}" for "${call}"; discovered callbacks: ${this.discovered.join(', ') || 'none'}`
          : `No callback name configured for "${action}" (needed by "${call}")`,
        call,
      );
    }
    const fn = (this.player as Record<string, unknown>)[name] as (...fnArgs: unknown[]) => unknown;
    try {
      return fn.apply(this.player, args);
    } catch (error) {
      throw new BridgeError(`"${name}" threw: ${(error as Error).message}`, call);
    }
  }
}
