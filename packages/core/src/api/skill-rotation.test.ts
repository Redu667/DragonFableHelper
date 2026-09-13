import { describe, expect, it } from 'vitest';
import { GameState } from '../state/game-state.js';
import { emptyCombat, type Monster, type Skill } from '../state/types.js';
import { parseRotation, SkillRotation } from './skill-rotation.js';

function skill(slot: number, overrides: Partial<Skill> = {}): Skill {
  return {
    slot,
    id: 100 + slot,
    name: `Skill ${slot}`,
    manaCost: 0,
    cooldown: 0,
    cooldownRemaining: 0,
    target: 'enemy',
    isDragonSkill: false,
    ...overrides,
  };
}

function monster(index: number, hp: number, maxHp = 100): Monster {
  return { index, id: index + 1, name: `Mob ${index}`, level: 1, hp, maxHp, element: 'none', alive: hp > 0 };
}

function stateWith(options: {
  hp?: number;
  maxHp?: number;
  mp?: number;
  skills?: Skill[];
  monsters?: Monster[];
  round?: number;
  selectedTarget?: number;
}): GameState {
  const state = new GameState();
  state.merge({
    player: {
      ...state.player,
      hp: options.hp ?? 100,
      maxHp: options.maxHp ?? 100,
      mp: options.mp ?? 100,
      maxMp: 100,
    },
    combat: {
      ...emptyCombat(),
      inCombat: true,
      phase: 'playerTurn',
      round: options.round ?? 1,
      monsters: options.monsters ?? [monster(0, 100)],
      selectedTarget: options.selectedTarget ?? 0,
      skills: options.skills ?? [skill(1), skill(2), skill(3)],
    },
  });
  return state;
}

describe('parseRotation', () => {
  it('parses a plain slot list', () => {
    expect(parseRotation('1 | 2 | 4')).toEqual([{ slot: 1 }, { slot: 2 }, { slot: 4 }]);
  });

  it('accepts commas as well as pipes', () => {
    expect(parseRotation('3,1 | 2').map((r) => r.slot)).toEqual([3, 1, 2]);
  });

  it('does not mistake a guard comparison for a separator', () => {
    expect(parseRotation('3:mobs>1')).toEqual([{ slot: 3, minMonstersAlive: 2 }]);
  });

  it('parses guards', () => {
    expect(parseRotation('4:hp<40 | 3:mobs>1 | 2:every2 | 5:max1')).toEqual([
      { slot: 4, playerHpBelow: 40 },
      { slot: 3, minMonstersAlive: 2 },
      { slot: 2, everyRounds: 2 },
      { slot: 5, maxUsesPerBattle: 1 },
    ]);
  });

  it('rejects nonsense rather than silently ignoring it', () => {
    expect(() => parseRotation('1 | banana')).toThrow(/expected a skill slot/);
    expect(() => parseRotation('1:sideways')).toThrow(/Unknown rotation guard/);
  });
});

describe('SkillRotation', () => {
  it('picks the first rule whose skill is ready', () => {
    const rotation = SkillRotation.fromString('3 | 2 | 1');
    const state = stateWith({ skills: [skill(1), skill(2), skill(3, { cooldownRemaining: 2 })] });
    expect(rotation.decide(state)?.slot).toBe(2);
  });

  it('skips skills the player cannot afford', () => {
    const rotation = SkillRotation.fromString('2 | 1');
    const state = stateWith({ mp: 5, skills: [skill(1), skill(2, { manaCost: 30 })] });
    expect(rotation.decide(state)?.slot).toBe(1);
  });

  it('honours a player-HP guard', () => {
    const rotation = SkillRotation.fromString('4:hp<40 | 1');
    const healthy = stateWith({ hp: 90, skills: [skill(1), skill(4, { target: 'self' })] });
    expect(rotation.decide(healthy)?.slot).toBe(1);

    const hurt = stateWith({ hp: 30, skills: [skill(1), skill(4, { target: 'self' })] });
    expect(rotation.decide(hurt)?.slot).toBe(4);
  });

  it('honours a monster-count guard', () => {
    const rotation = SkillRotation.fromString('3:mobs>1 | 1');
    const single = stateWith({ monsters: [monster(0, 50)] });
    expect(rotation.decide(single)?.slot).toBe(1);

    const crowd = stateWith({ monsters: [monster(0, 50), monster(1, 50)] });
    expect(rotation.decide(crowd)?.slot).toBe(3);
  });

  it('rate-limits a slot with everyRounds', () => {
    const rotation = SkillRotation.fromString('2:every3 | 1');
    const round1 = stateWith({ round: 1 });
    expect(rotation.decide(round1)?.slot).toBe(2);

    // Same battle, next round: slot 2 is still rate-limited.
    expect(rotation.decide(stateWith({ round: 2 }))?.slot).toBe(1);
    expect(rotation.decide(stateWith({ round: 3 }))?.slot).toBe(1);
    expect(rotation.decide(stateWith({ round: 4 }))?.slot).toBe(2);
  });

  it('caps uses per battle and resets between battles', () => {
    const rotation = SkillRotation.fromString('2:max2 | 1');
    expect(rotation.decide(stateWith({ round: 1 }))?.slot).toBe(2);
    expect(rotation.decide(stateWith({ round: 2 }))?.slot).toBe(2);
    expect(rotation.decide(stateWith({ round: 3 }))?.slot).toBe(1);

    rotation.reset();
    expect(rotation.decide(stateWith({ round: 1 }))?.slot).toBe(2);
  });

  it('targets the weakest survivor when the selected target is dead', () => {
    const state = stateWith({
      monsters: [monster(0, 0), monster(1, 80), monster(2, 12)],
      selectedTarget: 0,
    });
    expect(new SkillRotation().decide(state)?.targetIndex).toBe(2);
  });

  it('keeps hitting the selected target while it lives', () => {
    const state = stateWith({
      monsters: [monster(0, 95), monster(1, 3)],
      selectedTarget: 0,
    });
    expect(new SkillRotation().decide(state)?.targetIndex).toBe(0);
  });

  it('falls back to the basic attack when no rule is eligible', () => {
    const rotation = SkillRotation.fromString('2:hp<10');
    const state = stateWith({ hp: 100, skills: [skill(1), skill(2)] });
    const decision = rotation.decide(state);
    expect(decision?.slot).toBe(1);
    expect(decision?.rule.label).toBe('fallback attack');
  });

  it('returns null when even the basic attack is unavailable', () => {
    const rotation = new SkillRotation([{ slot: 2 }], false);
    const state = stateWith({ skills: [skill(1, { cooldownRemaining: 1 }), skill(2, { cooldownRemaining: 1 })] });
    expect(rotation.decide(state)).toBeNull();
  });

  it('returns null when nothing is alive to hit', () => {
    expect(new SkillRotation().decide(stateWith({ monsters: [monster(0, 0)] }))).toBeNull();
  });

  it('supports an arbitrary predicate guard', () => {
    const rotation = new SkillRotation([
      { slot: 3, when: (ctx) => ctx.aliveMonsters.length >= 2 && ctx.round > 1 },
      { slot: 1 },
    ]);
    expect(rotation.decide(stateWith({ round: 1, monsters: [monster(0, 9), monster(1, 9)] }))?.slot).toBe(1);
    expect(rotation.decide(stateWith({ round: 2, monsters: [monster(0, 9), monster(1, 9)] }))?.slot).toBe(3);
  });
});
