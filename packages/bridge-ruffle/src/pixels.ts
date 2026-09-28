import { DF_STAGE_HEIGHT, DF_STAGE_WIDTH } from './ruffle-types.js';
import type { StagePoint } from './input.js';

export type Rgb = [number, number, number];

/** Something the sensors can read pixels from, in its own pixel space. */
export interface PixelSource {
  readonly width: number;
  readonly height: number;
  /** Refresh the backing frame; sampling reads from the last refresh. */
  refresh(): void;
  sample(x: number, y: number): Rgb | null;
}

/** A spot whose colour tells us something: "the attack button is lit". */
export interface PointSensor {
  name: string;
  x: number;
  y: number;
  color: Rgb;
  tolerance?: number;
}

/** A line across a bar; the reading is the filled fraction from `from`. */
export interface BarSensor {
  name: string;
  from: StagePoint;
  to: StagePoint;
  color: Rgb;
  tolerance?: number;
}

export interface SensorSpec {
  points: PointSensor[];
  bars: BarSensor[];
}

export interface SensorReading {
  points: Record<string, boolean>;
  bars: Record<string, number>;
  sampledAt: number;
}

export const DEFAULT_TOLERANCE = 28;

export function colorMatches(actual: Rgb | null, expected: Rgb, tolerance = DEFAULT_TOLERANCE): boolean {
  if (!actual) return false;
  return (
    Math.abs(actual[0] - expected[0]) <= tolerance &&
    Math.abs(actual[1] - expected[1]) <= tolerance &&
    Math.abs(actual[2] - expected[2]) <= tolerance
  );
}

/**
 * Reads combat state straight off the rendered frame.
 *
 * DragonFable resolves battles inside the client, so whose turn it is and how
 * hurt a monster is never cross the network. They are, however, on screen:
 * a lit hotbar, a red bar. Sensors are calibrated by the user (sample a point,
 * name it) rather than shipped as guesses, so a wrong position can only ever
 * be a wrong reading you set yourself, not a silent default.
 */
export class PixelSensors {
  private spec: SensorSpec;

  constructor(
    private readonly source: () => PixelSource | null,
    spec: SensorSpec = { points: [], bars: [] },
    private readonly stage = { width: DF_STAGE_WIDTH, height: DF_STAGE_HEIGHT },
  ) {
    this.spec = { points: [...spec.points], bars: [...spec.bars] };
  }

  get sensorSpec(): SensorSpec {
    return { points: [...this.spec.points], bars: [...this.spec.bars] };
  }

  setSpec(spec: SensorSpec): void {
    this.spec = { points: [...spec.points], bars: [...spec.bars] };
  }

  addPoint(sensor: PointSensor): void {
    this.spec.points = [...this.spec.points.filter((s) => s.name !== sensor.name), sensor];
  }

  addBar(sensor: BarSensor): void {
    this.spec.bars = [...this.spec.bars.filter((s) => s.name !== sensor.name), sensor];
  }

  remove(name: string): void {
    this.spec.points = this.spec.points.filter((s) => s.name !== name);
    this.spec.bars = this.spec.bars.filter((s) => s.name !== name);
  }

  get isEmpty(): boolean {
    return this.spec.points.length === 0 && this.spec.bars.length === 0;
  }

  /** The colour at a stage point from the last refreshed frame. */
  sampleStage(point: StagePoint, source = this.source()): Rgb | null {
    if (!source || source.width <= 0 || source.height <= 0) return null;
    const x = Math.min(source.width - 1, Math.max(0, Math.round((point.x / this.stage.width) * source.width)));
    const y = Math.min(source.height - 1, Math.max(0, Math.round((point.y / this.stage.height) * source.height)));
    return source.sample(x, y);
  }

  /** Grab a fresh frame and sample one point - what calibration uses. */
  peek(point: StagePoint): Rgb | null {
    const source = this.source();
    if (!source) return null;
    source.refresh();
    return this.sampleStage(point, source);
  }

  /** Evaluate every sensor against a fresh frame. Null when there is no frame. */
  read(now = Date.now()): SensorReading | null {
    const source = this.source();
    if (!source || source.width <= 0 || source.height <= 0) return null;
    source.refresh();

    const points: Record<string, boolean> = {};
    for (const sensor of this.spec.points) {
      points[sensor.name] = colorMatches(this.sampleStage(sensor, source), sensor.color, sensor.tolerance);
    }

    const bars: Record<string, number> = {};
    for (const sensor of this.spec.bars) {
      bars[sensor.name] = this.readBar(sensor, source);
    }

    return { points, bars, sampledAt: now };
  }

  /** Fraction of the line, from its start, that still shows the bar colour. */
  private readBar(sensor: BarSensor, source: PixelSource): number {
    const dx = sensor.to.x - sensor.from.x;
    const dy = sensor.to.y - sensor.from.y;
    const steps = Math.max(1, Math.round(Math.hypot(dx, dy)));

    let run = 0;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const point = { x: sensor.from.x + dx * t, y: sensor.from.y + dy * t };
      if (!colorMatches(this.sampleStage(point, source), sensor.color, sensor.tolerance)) break;
      run += 1;
    }
    return Math.min(1, run / (steps + 1));
  }
}

/**
 * A {@link PixelSource} over Ruffle's canvas.
 *
 * Reads go through an offscreen 2D canvas so they work whether Ruffle is on
 * its canvas or WebGL renderer; WebGL frames are only readable this way when
 * the drawing buffer is preserved, so the host enables Ruffle's canvas
 * renderer when sensors are in use.
 */
export class CanvasPixelSource implements PixelSource {
  private frame: ImageData | null = null;
  private readonly scratch: HTMLCanvasElement;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.scratch = document.createElement('canvas');
  }

  get width(): number {
    return this.frame?.width ?? this.canvas.width;
  }

  get height(): number {
    return this.frame?.height ?? this.canvas.height;
  }

  refresh(): void {
    const { width, height } = this.canvas;
    if (width === 0 || height === 0) {
      this.frame = null;
      return;
    }
    this.scratch.width = width;
    this.scratch.height = height;
    const context = this.scratch.getContext('2d', { willReadFrequently: true });
    if (!context) {
      this.frame = null;
      return;
    }
    context.drawImage(this.canvas, 0, 0);
    try {
      this.frame = context.getImageData(0, 0, width, height);
    } catch {
      // A tainted canvas (cross-origin frame) refuses reads.
      this.frame = null;
    }
  }

  sample(x: number, y: number): Rgb | null {
    const frame = this.frame;
    if (!frame || x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
    const offset = (y * frame.width + x) * 4;
    return [frame.data[offset] ?? 0, frame.data[offset + 1] ?? 0, frame.data[offset + 2] ?? 0];
  }
}
