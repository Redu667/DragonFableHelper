import { describe, expect, it } from 'vitest';
import { colorMatches, PixelSensors, type PixelSource, type Rgb } from './pixels.js';

/** An in-memory frame the same size as the stage, painted by tests. */
function gridSource(width: number, height: number, paint: (x: number, y: number) => Rgb) {
  let refreshes = 0;
  const source: PixelSource = {
    width,
    height,
    refresh: () => {
      refreshes += 1;
    },
    sample: (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? null : paint(x, y)),
  };
  return { source, refreshes: () => refreshes };
}

const RED: Rgb = [200, 30, 30];
const GREY: Rgb = [80, 80, 80];

describe('colorMatches', () => {
  it('accepts small per-channel differences and rejects large ones', () => {
    expect(colorMatches([205, 25, 40], RED, 20)).toBe(true);
    expect(colorMatches([250, 30, 30], RED, 20)).toBe(false);
    expect(colorMatches(null, RED)).toBe(false);
  });
});

describe('PixelSensors', () => {
  it('reports point sensors from the frame', () => {
    const { source, refreshes } = gridSource(750, 550, (x) => (x < 100 ? RED : GREY));
    const sensors = new PixelSensors(() => source, {
      points: [
        { name: 'attackLit', x: 50, y: 10, color: RED },
        { name: 'restLit', x: 700, y: 10, color: RED },
      ],
      bars: [],
    });

    const reading = sensors.read(123);
    expect(reading).toEqual({ points: { attackLit: true, restLit: false }, bars: {}, sampledAt: 123 });
    expect(refreshes()).toBe(1);
  });

  it('measures how much of a bar is still filled', () => {
    // A 100px-wide bar at y=20 that is 60% red from the left.
    const { source } = gridSource(750, 550, (x, y) => (y === 20 && x >= 100 && x < 160 ? RED : GREY));
    const sensors = new PixelSensors(() => source, {
      points: [],
      bars: [{ name: 'monsterHp', from: { x: 100, y: 20 }, to: { x: 199, y: 20 }, color: RED }],
    });
    const reading = sensors.read();
    expect(reading?.bars.monsterHp).toBeCloseTo(0.6, 1);
  });

  it('reads an empty bar as zero and a full bar as one', () => {
    const empty = gridSource(750, 550, () => GREY).source;
    const full = gridSource(750, 550, () => RED).source;
    const spec = { points: [], bars: [{ name: 'hp', from: { x: 0, y: 0 }, to: { x: 49, y: 0 }, color: RED }] };
    expect(new PixelSensors(() => empty, spec).read()?.bars.hp).toBe(0);
    expect(new PixelSensors(() => full, spec).read()?.bars.hp).toBe(1);
  });

  it('scales stage coordinates onto a differently sized frame', () => {
    // A frame at 2x device pixel ratio: 1500x1100.
    const { source } = gridSource(1500, 1100, (x, y) => (x === 750 && y === 550 ? RED : GREY));
    const sensors = new PixelSensors(() => source);
    expect(sensors.sampleStage({ x: 375, y: 275 })).toEqual(RED);
    expect(sensors.sampleStage({ x: 0, y: 0 })).toEqual(GREY);
  });

  it('returns null with no frame, and never throws on out-of-range points', () => {
    const sensors = new PixelSensors(() => null, { points: [{ name: 'x', x: 1, y: 1, color: RED }], bars: [] });
    expect(sensors.read()).toBeNull();
    expect(sensors.peek({ x: 1, y: 1 })).toBeNull();

    const { source } = gridSource(10, 10, () => GREY);
    expect(new PixelSensors(() => source).sampleStage({ x: 9999, y: -5 })).toEqual(GREY);
  });

  it('adds, replaces and removes sensors by name', () => {
    const sensors = new PixelSensors(() => null);
    sensors.addPoint({ name: 'a', x: 1, y: 1, color: RED });
    sensors.addPoint({ name: 'a', x: 2, y: 2, color: GREY });
    sensors.addBar({ name: 'b', from: { x: 0, y: 0 }, to: { x: 1, y: 0 }, color: RED });
    expect(sensors.sensorSpec.points).toEqual([{ name: 'a', x: 2, y: 2, color: GREY }]);
    expect(sensors.isEmpty).toBe(false);

    sensors.remove('a');
    sensors.remove('b');
    expect(sensors.isEmpty).toBe(true);
  });
});
