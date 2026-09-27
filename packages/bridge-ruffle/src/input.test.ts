import { describe, expect, it } from 'vitest';
import { ClickInput, findRuffleCanvas, type InputTarget } from './input.js';

interface Dispatched {
  type: string;
  clientX: number;
  clientY: number;
}

/** A stand-in canvas at half scale, offset on the page. */
function fakeTarget(rect = { left: 100, top: 50, width: 375, height: 275 }) {
  const dispatched: Dispatched[] = [];
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const target: InputTarget = {
    getBoundingClientRect: () => rect,
    dispatchEvent: (event) => {
      dispatched.push(event as unknown as Dispatched);
      return true;
    },
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
  };
  const fire = (type: string, init: { clientX: number; clientY: number }) => {
    for (const listener of listeners.get(type) ?? []) listener({ type, ...init } as unknown as Event);
  };
  return { target, dispatched, fire, listeners };
}

const makeEvent = (type: string, init: PointerEventInit) =>
  ({ type, clientX: init.clientX, clientY: init.clientY }) as unknown as Event;

describe('ClickInput', () => {
  it('maps stage coordinates through the canvas rectangle', () => {
    const { target } = fakeTarget();
    const input = new ClickInput({ target: () => target, makeEvent });
    expect(input.toClient({ x: 0, y: 0 })).toEqual({ clientX: 100, clientY: 50 });
    expect(input.toClient({ x: 750, y: 550 })).toEqual({ clientX: 475, clientY: 325 });
    expect(input.toClient({ x: 375, y: 275 })).toEqual({ clientX: 287.5, clientY: 187.5 });
  });

  it('maps viewport coordinates back onto the stage', () => {
    const { target } = fakeTarget();
    const input = new ClickInput({ target: () => target, makeEvent });
    expect(input.toStage(287.5, 187.5)).toEqual({ x: 375, y: 275 });
  });

  it('sends the pointer sequence Ruffle listens for, at the mapped point', async () => {
    const { target, dispatched } = fakeTarget();
    const input = new ClickInput({
      target: () => target,
      makeEvent,
      sleep: async () => undefined,
      map: { attack: { x: 375, y: 275 } },
    });

    await input.click('attack');
    expect(dispatched.map((e) => e.type)).toEqual(['pointermove', 'pointerdown', 'pointerup']);
    expect(dispatched[1]).toMatchObject({ clientX: 287.5, clientY: 187.5 });
  });

  it('refuses to click an action that was never calibrated', async () => {
    const { target } = fakeTarget();
    const input = new ClickInput({ target: () => target, makeEvent });
    await expect(input.click('rest')).rejects.toThrow(/No input position recorded for "rest"/);
  });

  it('refuses to click when the canvas is off screen', async () => {
    const input = new ClickInput({ target: () => null, makeEvent, map: { attack: { x: 1, y: 1 } } });
    await expect(input.click('attack')).rejects.toThrow(/not on screen/);
  });

  it('records the next user click as a calibrated action', async () => {
    const { target, fire } = fakeTarget();
    const input = new ClickInput({ target: () => target, makeEvent });

    const pending = input.captureNext('skill2');
    fire('pointerdown', { clientX: 200, clientY: 100 });

    await expect(pending).resolves.toEqual({ x: 200, y: 100 });
    expect(input.has('skill2')).toBe(true);
    expect(input.inputMap.skill2).toEqual({ x: 200, y: 100 });
  });

  it('cancels calibration through an AbortSignal and stops listening', async () => {
    const { target, listeners } = fakeTarget();
    const input = new ClickInput({ target: () => target, makeEvent });
    const controller = new AbortController();

    const pending = input.captureNext('flee', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow(/cancelled/);
    expect(listeners.get('pointerdown')?.size ?? 0).toBe(0);
  });
});

describe('findRuffleCanvas', () => {
  it('looks inside the open shadow root and tolerates its absence', () => {
    const canvas = {} as HTMLCanvasElement;
    const player = { shadowRoot: { querySelector: (sel: string) => (sel === 'canvas' ? canvas : null) } };
    expect(findRuffleCanvas(player)).toBe(canvas);
    expect(findRuffleCanvas({})).toBeNull();
    expect(findRuffleCanvas({ shadowRoot: null })).toBeNull();
  });
});
