import type { CallbackNames } from './callbacks.js';
import type { InputMap } from './input.js';
import type { SensorSpec } from './pixels.js';
import { defaultFieldAliases, type FieldAliases } from './state-extractor.js';

/**
 * How pixel sensors map onto combat state. Each entry names a sensor from
 * {@link DfProfile.sensors}; unset entries leave that part of the state to
 * whatever the network reveals.
 */
export interface CombatSensorBinding {
  /** Point sensor that is on while the player may act. */
  playerTurn?: string;
  /** Point sensor that is on during a battle. */
  inCombat?: string;
  /** Point sensor that is on while the victory screen is up. */
  victory?: string;
  /** Point sensor that is on while the defeat screen is up. */
  defeat?: string;
  /** Bar sensors for each monster slot's HP, by index. */
  monsterHp?: string[];
  /** Bar sensor for the player's own HP, used between server replies. */
  playerHp?: string;
}

/**
 * Everything the live bridge knows about a particular DragonFable client,
 * in one place, all of it learned from the running game rather than assumed:
 * which ExternalInterface callbacks it registers, what its server replies
 * call each field, where its buttons are, and which pixels mean what.
 *
 * Persisted by the host so a calibrated setup survives restarts.
 */
export interface DfProfile {
  version: 1;
  callbacks: CallbackNames;
  aliases: FieldAliases;
  input: InputMap;
  sensors: SensorSpec;
  combat: CombatSensorBinding;
}

export function defaultProfile(): DfProfile {
  return {
    version: 1,
    callbacks: {},
    aliases: { ...defaultFieldAliases },
    input: {},
    sensors: { points: [], bars: [] },
    combat: {},
  };
}

export function mergeProfile(base: DfProfile, patch: Partial<DfProfile> | null | undefined): DfProfile {
  if (!patch) return base;
  return {
    version: 1,
    callbacks: { ...base.callbacks, ...patch.callbacks },
    aliases: { ...base.aliases, ...patch.aliases },
    input: { ...base.input, ...patch.input },
    sensors: patch.sensors
      ? { points: [...patch.sensors.points], bars: [...patch.sensors.bars] }
      : { points: [...base.sensors.points], bars: [...base.sensors.bars] },
    combat: { ...base.combat, ...patch.combat },
  };
}

export interface ProfileStore {
  load(): Partial<DfProfile> | null;
  save(profile: DfProfile): void;
}

export class MemoryProfileStore implements ProfileStore {
  private stored: DfProfile | null = null;
  load(): Partial<DfProfile> | null {
    return this.stored;
  }
  save(profile: DfProfile): void {
    this.stored = profile;
  }
}

export const PROFILE_STORAGE_KEY = 'dfh.profile.v1';

/** Browser storage; works in both the Electron renderer and the WebView. */
export class LocalStorageProfileStore implements ProfileStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {}

  load(): Partial<DfProfile> | null {
    try {
      const raw = this.storage.getItem(PROFILE_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Partial<DfProfile>) : null;
    } catch {
      return null;
    }
  }

  save(profile: DfProfile): void {
    try {
      this.storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch {
      /* storage may be full or disabled; the in-memory profile still works */
    }
  }
}
