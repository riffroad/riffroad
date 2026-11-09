import { describe, expect, it } from 'vitest';
import { DEFAULT_GUITAR, engineSettings, suggestGainDb } from '../src/guitar-settings';
import { advice, centsOff, foldOctave, meterPosition, pickString } from '../src/tuner';

const DROP_C = [36, 43, 48, 53, 57, 62];

describe('tuner', () => {
  it('measures cents from the string being tuned', () => {
    expect(centsOff(36.157, 36)).toBeCloseTo(15.7, 1);
  });

  it('stays on the selected string unless another one is plainly played', () => {
    const none = DROP_C.map(() => false);
    expect(pickString(37.6, DROP_C, 0, none)).toBe(0); // the low string, very sharp
    expect(pickString(43.2, DROP_C, 0, none)).toBe(1); // the yellow string, nearly in tune
    expect(pickString(43.2, DROP_C, 0, [false, true, false, false, false, false])).toBe(0);
  });

  it('reads a string heard an octave off as that string', () => {
    expect(foldOctave(52.04, 40)).toBeCloseTo(40.04); // a low E whose fundamental the pickup lost
    expect(foldOctave(28.1, 40)).toBeCloseTo(40.1);
    expect(foldOctave(45, 40)).toBe(45); // another string: left alone
  });

  it('spreads the last cents across the meter', () => {
    expect(meterPosition(0)).toBe(0);
    expect(meterPosition(50)).toBe(1);
    expect(meterPosition(-80)).toBe(-1);
    // ±3 cents takes a fifth of each half: the in-tune window is wide enough to see.
    expect(meterPosition(3)).toBeGreaterThan(0.2);
    expect(meterPosition(-10)).toBeCloseTo(-meterPosition(10));
  });

  it('says which way to turn the peg', () => {
    expect(advice(2.4, 36.024, 36)).toBe('Juste !');
    expect(advice(-8, 35.92, 36)).toBe('Un peu grave : tends la corde');
    expect(advice(12, 36.12, 36)).toBe('Un peu aigu : détends la corde');
    expect(advice(400, 40, 36)).toBe('E2 au lieu de C2 : détends la corde (4 demi-tons)');
  });
});

describe('guitar settings', () => {
  it('sets the gain so strong strums peak at -12 dBFS', () => {
    const s = suggestGainDb(0, 0.0005, 0.05);
    expect(s.ok).toBe(true);
    expect(s.gainDb).toBe(14);
  });

  it('keeps the noise floor under the detection thresholds', () => {
    const s = suggestGainDb(0, 0.002, 0.02);
    expect(s.gainDb).toBe(4);
    expect(s.message).toContain('Bruit de fond');
  });

  it('measures with the gain already applied', () => {
    expect(suggestGainDb(6, 0.001, 0.1).gainDb).toBe(14);
  });

  it('changes nothing when it heard nothing', () => {
    expect(suggestGainDb(3, 0.0001, 0.00012)).toMatchObject({ ok: false, gainDb: 3 });
  });

  it('sends perceptual volumes as gains, the master on all', () => {
    const v = { ...DEFAULT_GUITAR, inputGainDb: 2, inputOffsetMs: 25, visualOffsetMs: 0, masterVolume: 1, backingVolume: 0.5, monitorVolume: 1, stemVolume: 0, effectsVolume: 0.7, crowdVolume: 0.8 };
    expect(engineSettings(v)).toEqual({ inputChannel: 0, monitor: null, inputGainDb: 2, inputOffsetMs: 25, backingVolume: 0.25, monitorVolume: 1, stemVolume: 0 });
    const half = engineSettings({ ...DEFAULT_GUITAR, ...v, inputGainDb: 0, inputOffsetMs: 0, masterVolume: 0.5, backingVolume: 1, monitorVolume: 0.8, stemVolume: 0.6 });
    expect(half.backingVolume).toBeCloseTo(0.25);
    expect(half.monitorVolume).toBeCloseTo(0.16);
    expect(half.stemVolume).toBeCloseTo(0.09);
  });
});


it('maps the selected channel and explicit monitoring to the native engine', () => {
  expect(engineSettings({ ...DEFAULT_GUITAR, inputChannel: 1, monitoring: 1 })).toMatchObject({ inputChannel: 1, monitor: true });
  expect(engineSettings({ ...DEFAULT_GUITAR, monitoring: 0 }).monitor).toBe(false);
  expect(engineSettings(DEFAULT_GUITAR).monitor).toBeNull();
});
