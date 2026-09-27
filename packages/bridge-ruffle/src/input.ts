import { DF_STAGE_HEIGHT, DF_STAGE_WIDTH } from './ruffle-types.js';

/** A point on DragonFable's fixed 750x550 stage. */
export interface StagePoint {
  x: number;
  y: number;
}

/**
 * Where on the stage each action lives. Keys are free-form so scripts can add
 * their own; the bridge looks up the well-known ones below.
 */
export type InputMap = Record<string, StagePoint>;

export const INPUT_ACTIONS = [
  'attack', 'skill1', 'skill2', 'skill3', 'skill4', 'skill5',
  'target0', 'target1', 'target2',
  'rest', 'flee', 'acknowledge', 'skipCutscene',
  'acceptQuest', 'turnInQuest',
] as const;
export type InputAction = (typeof INPUT_ACTIONS)[number];

/** The slice of a DOM element the input synthesiser needs; faked in tests. */
export interface InputTarget {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  dispatchEvent(event: Event): boolean;
  addEventListener(type: string, listener: (event: Event) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export type PointerEventFactory = (type: string, init: PointerEventInit) => Event;

export interface ClickInputOptions {
  /** Resolves the element to click - Ruffle's canvas. Re-resolved per click. */
  target: () => InputTarget | null;
  map?: InputMap;
  makeEvent?: PointerEventFactory;
  sleep?: (ms: number) => Promise<void>;
  /** Time between pointerdown and pointerup. */
  holdMs?: number;
}

/** Ruffle renders into a canvas inside the player's (open) shadow root. */
export function findRuffleCanvas(player: unknown): HTMLCanvasElement | null {
  const shadow = (player as { shadowRoot?: ShadowRoot | null }).shadowRoot;
  return shadow?.querySelector('canvas') ?? null;
}

const defaultMakeEvent: PointerEventFactory = (type, init) =>
  // Every WebView this project targets has PointerEvent; the MouseEvent
  // fallback keeps a very old engine from throwing before it can log why.
  new (typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent)(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    ...init,
  });

/**
 * Drives the game the way a player does: pointer events on the Ruffle
 * canvas at stage coordinates.
 *
 * Ruffle's wasm listens for `pointerdown` / `pointerup` / `pointermove` on
 * its canvas (nothing else), so that is the exact sequence sent. Stage
 * coordinates are mapped through the canvas's on-screen rectangle, which
 * already reflects whatever CSS scaling the host applied to fit the window.
 *
 * Positions are not guessed: the map starts empty and is filled by
 * {@link ClickInput.captureNext}, which records where the user clicks.
 */
export class ClickInput {
  private map: InputMap;
  private readonly target: () => InputTarget | null;
  private readonly makeEvent: PointerEventFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly holdMs: number;

  constructor(options: ClickInputOptions) {
    this.target = options.target;
    this.map = { ...(options.map ?? {}) };
    this.makeEvent = options.makeEvent ?? defaultMakeEvent;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.holdMs = options.holdMs ?? 40;
  }

  get inputMap(): InputMap {
    return { ...this.map };
  }

  setMap(map: InputMap): void {
    this.map = { ...map };
  }

  set(action: string, point: StagePoint): void {
    this.map[action] = point;
  }

  has(action: string): boolean {
    return action in this.map;
  }

  /** Stage -> viewport coordinates, or null when the canvas is not on screen. */
  toClient(point: StagePoint): { clientX: number; clientY: number } | null {
    const target = this.target();
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      clientX: rect.left + (point.x / DF_STAGE_WIDTH) * rect.width,
      clientY: rect.top + (point.y / DF_STAGE_HEIGHT) * rect.height,
    };
  }

  /** Viewport -> stage coordinates. */
  toStage(clientX: number, clientY: number): StagePoint | null {
    const target = this.target();
    if (!target) return null;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * DF_STAGE_WIDTH),
      y: Math.round(((clientY - rect.top) / rect.height) * DF_STAGE_HEIGHT),
    };
  }

  /** Click a mapped action or an explicit stage point. */
  async click(where: string | StagePoint): Promise<void> {
    const point = typeof where === 'string' ? this.map[where] : where;
    if (!point) throw new Error(`No input position recorded for "${String(where)}" - calibrate it in the Live panel`);

    const target = this.target();
    const client = this.toClient(point);
    if (!target || !client) throw new Error('The game canvas is not on screen, so it cannot be clicked');

    target.dispatchEvent(this.makeEvent('pointermove', client));
    target.dispatchEvent(this.makeEvent('pointerdown', client));
    await this.sleep(this.holdMs);
    target.dispatchEvent(this.makeEvent('pointerup', client));
  }

  /**
   * Wait for the user's next click on the canvas and resolve with the stage
   * point, without recording it. Sensor calibration samples pixels this way.
   */
  capturePoint(options: { signal?: AbortSignal } = {}): Promise<StagePoint> {
    const target = this.target();
    if (!target) return Promise.reject(new Error('The game canvas is not on screen'));

    return new Promise<StagePoint>((resolve, reject) => {
      const onPointer = (event: Event) => {
        const { clientX, clientY } = event as PointerEvent;
        const point = this.toStage(clientX, clientY);
        cleanup();
        if (!point) reject(new Error('Could not map the click onto the stage'));
        else resolve(point);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('Calibration cancelled'));
      };
      const cleanup = () => {
        target.removeEventListener('pointerdown', onPointer);
        options.signal?.removeEventListener('abort', onAbort);
      };
      target.addEventListener('pointerdown', onPointer, { capture: true });
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Calibration: wait for the user's next click on the canvas, store it
   * under `action`, and resolve with the stage point that was recorded.
   */
  async captureNext(action: string, options: { signal?: AbortSignal } = {}): Promise<StagePoint> {
    const point = await this.capturePoint(options);
    this.map[action] = point;
    return point;
  }
}
