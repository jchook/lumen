/**
 * Sound without assets, built as a small instrument rather than a set of beeps.
 *
 *   master ─ compressor ─ out
 *     ├─ dry
 *     └─ reverb send (generated impulse, 3 s, dark)
 *
 * Bed: three detuned voices through a slowly breathing lowpass, plus a sub. Always there, quiet.
 * Threat: a beating drone pair and a band of wind that rise and quicken as something that can eat
 * you gets close. Meals: bell-like notes on a D pentatonic, pitched by the mass eaten, stepping up
 * the scale when meals come in a streak. Burns: a falling band of air. Prizes and the round bell:
 * inharmonic partials with long tails. Every note gets a little random detune so nothing repeats
 * exactly.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let dry: GainNode | null = null;
let send: GainNode | null = null;
let muted = false;

// Threat voices, kept alive and modulated.
let droneA: OscillatorNode | null = null;
let droneB: OscillatorNode | null = null;
let droneGain: GainNode | null = null;
let windGain: GainNode | null = null;
let windFilter: BiquadFilterNode | null = null;
let bedFilter: BiquadFilterNode | null = null;
let bedGain: GainNode | null = null;

const ROOT = 73.42; // D2
const PENTA = [0, 2, 4, 7, 9]; // major pentatonic, in semitones
const note = (semi: number): number => ROOT * Math.pow(2, semi / 12);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

function impulse(seconds: number, decay: number): AudioBuffer {
  const c = ctx!;
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function noise(seconds: number): AudioBufferSourceNode {
  const c = ctx!;
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

export function soundInit(): void {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    const c = ctx;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    master = c.createGain();
    master.gain.value = muted ? 0 : 0.6;
    comp.connect(master).connect(c.destination);
    dry = c.createGain();
    dry.connect(comp);
    const verb = c.createConvolver();
    verb.buffer = impulse(3.2, 2.6);
    const verbTone = c.createBiquadFilter();
    verbTone.type = "lowpass";
    verbTone.frequency.value = 2600;
    send = c.createGain();
    send.gain.value = 0.55;
    send.connect(verb).connect(verbTone).connect(comp);

    // The bed.
    bedFilter = c.createBiquadFilter();
    bedFilter.type = "lowpass";
    bedFilter.frequency.value = 320;
    bedFilter.Q.value = 0.7;
    bedGain = c.createGain();
    bedGain.gain.value = 0.05;
    bedFilter.connect(bedGain);
    bedGain.connect(dry);
    bedGain.connect(send);
    for (const [semi, type, det] of [
      [0, "sawtooth", -6],
      [7, "triangle", 5],
      [12, "sawtooth", 9],
    ] as Array<[number, OscillatorType, number]>) {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = note(semi);
      o.detune.value = det;
      const g = c.createGain();
      g.gain.value = semi === 0 ? 0.5 : 0.28;
      o.connect(g).connect(bedFilter);
      o.start();
    }
    const sub = c.createOscillator();
    sub.type = "sine";
    sub.frequency.value = ROOT / 2;
    const subG = c.createGain();
    subG.gain.value = 0.06;
    sub.connect(subG).connect(dry);
    sub.start();
    // Breathing: an LFO on the bed's cutoff.
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoG = c.createGain();
    lfoG.gain.value = 140;
    lfo.connect(lfoG).connect(bedFilter.frequency);
    lfo.start();

    // Threat: two low voices a few Hz apart (they beat), and a band of wind.
    droneA = c.createOscillator();
    droneA.type = "sawtooth";
    droneA.frequency.value = ROOT / 2;
    droneB = c.createOscillator();
    droneB.type = "sawtooth";
    droneB.frequency.value = ROOT / 2 + 1.5;
    const droneFilter = c.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 180;
    droneGain = c.createGain();
    droneGain.gain.value = 0;
    droneA.connect(droneFilter);
    droneB.connect(droneFilter);
    droneFilter.connect(droneGain).connect(dry);
    droneA.start();
    droneB.start();
    const wind = noise(4);
    wind.loop = true;
    windFilter = c.createBiquadFilter();
    windFilter.type = "bandpass";
    windFilter.frequency.value = 300;
    windFilter.Q.value = 0.8;
    windGain = c.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter).connect(windGain);
    windGain.connect(dry);
    windGain.connect(send);
    wind.start();
  } catch {
    ctx = null;
  }
}

export function soundMute(on: boolean): void {
  muted = on;
  if (master && ctx) master.gain.setTargetAtTime(on ? 0 : 0.6, ctx.currentTime, 0.05);
}
export const soundMuted = (): boolean => muted;

/** 0..1: how close the nearest thing that can eat me is. */
export function soundThreat(level: number): void {
  if (!ctx || !droneGain || !windGain || !windFilter || !droneB || !bedFilter) return;
  const t = ctx.currentTime;
  const k = Math.min(1, Math.max(0, level));
  droneGain.gain.setTargetAtTime(k * k * 0.14, t, 0.25);
  droneB.frequency.setTargetAtTime(ROOT / 2 + 1.5 + k * 4, t, 0.3); // beats quicken
  windGain.gain.setTargetAtTime(k * 0.09, t, 0.3);
  windFilter.frequency.setTargetAtTime(300 + k * 900, t, 0.3);
  // The bed closes down as danger rises, so the drone has room.
  bedFilter.frequency.setTargetAtTime(320 - k * 160, t, 0.5);
}

/** A bell-ish voice: carrier plus a quiet detuned partial, exponential tail, reverb send. */
function bell(freq: number, dur: number, gain: number, partials: Array<[number, number, number]> = [[1, 1, 1], [2.01, 0.35, 0.6], [3.02, 0.12, 0.35]]): void {
  if (!ctx || !dry || !send) return;
  const c = ctx;
  const t = c.currentTime;
  const out = c.createGain();
  out.gain.value = 1;
  out.connect(dry);
  const toVerb = c.createGain();
  toVerb.gain.value = 0.8;
  out.connect(toVerb).connect(send);
  for (const [ratio, amp, life] of partials) {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = freq * ratio;
    o.detune.value = rnd(-6, 6);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * life);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur * life + 0.05);
  }
}

let streak = 0;
let lastMeal = 0;

/** One note per meal. Bigger meals sit lower; a streak walks up the scale. */
export function soundAbsorb(mass: number): void {
  if (!ctx) return;
  const now = ctx.currentTime;
  streak = now - lastMeal < 1.6 ? Math.min(streak + 1, 9) : 0;
  lastMeal = now;
  // Octave from mass: specks high, prizes low.
  const octave = mass < 1 ? 3 : mass < 4 ? 2 : mass < 12 ? 1 : 0;
  const degree = streak % PENTA.length;
  const semi = PENTA[degree]! + 12 * (octave + Math.floor(streak / PENTA.length) * 0.5);
  const gain = 0.10 + Math.min(0.14, mass * 0.012);
  bell(note(semi + 12), 1.4 + Math.min(1.2, mass * 0.08), gain);
}

/** Burning: a falling band of air with a little low push. */
export function soundBurn(strength: number): void {
  if (!ctx || !dry || !send) return;
  const c = ctx;
  const t = c.currentTime;
  const k = Math.min(1, Math.max(0.15, strength));
  const n = noise(0.4);
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(1400 + 1400 * k, t);
  f.frequency.exponentialRampToValueAtTime(220, t + 0.3);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05 + 0.09 * k, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  n.connect(f).connect(g);
  g.connect(dry);
  const toVerb = c.createGain();
  toVerb.gain.value = 0.35;
  g.connect(toVerb).connect(send);
  n.start(t);
  const thump = c.createOscillator();
  thump.frequency.setValueAtTime(90, t);
  thump.frequency.exponentialRampToValueAtTime(40, t + 0.12);
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.0001, t);
  tg.gain.exponentialRampToValueAtTime(0.08 * k, t + 0.01);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  thump.connect(tg).connect(dry);
  thump.start(t);
  thump.stop(t + 0.16);
}

/** A giant sheds a ring: a bright shimmer that spreads out. */
export function soundFlare(): void {
  if (!ctx || !send) return;
  const c = ctx;
  const t = c.currentTime;
  const n = noise(1.2);
  const f = c.createBiquadFilter();
  f.type = "highpass";
  f.frequency.setValueAtTime(3000, t);
  f.frequency.exponentialRampToValueAtTime(900, t + 1.0);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
  n.connect(f).connect(g).connect(send);
  n.start(t);
}

export function soundPrize(): void {
  const chord = [0, 7, 12, 16];
  chord.forEach((semi, i) => setTimeout(() => bell(note(semi + 36), 2.4, 0.07), i * 90));
}

/** The round bell: inharmonic partials, long tail. */
export function soundBell(): void {
  bell(note(14), 4.5, 0.16, [
    [1, 1, 1],
    [2.76, 0.5, 0.7],
    [5.4, 0.25, 0.45],
    [8.9, 0.1, 0.3],
  ]);
  setTimeout(() => bell(note(21), 4.0, 0.12, [[1, 1, 1], [2.76, 0.4, 0.7], [5.4, 0.2, 0.45]]), 350);
}

/** Absorbed: the bed closes and a low tone falls away. */
export function soundLost(): void {
  if (!ctx || !dry || !bedFilter || !bedGain) return;
  const c = ctx;
  const t = c.currentTime;
  bedFilter.frequency.setTargetAtTime(90, t, 0.6);
  bedGain.gain.setTargetAtTime(0.02, t, 1.2);
  const o = c.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(note(12), t);
  o.frequency.exponentialRampToValueAtTime(note(-5), t + 1.6);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
  o.connect(g).connect(dry);
  if (send) g.connect(send);
  o.start(t);
  o.stop(t + 1.9);
}

/** A new sky: the bed opens back up. */
export function soundReset(): void {
  if (!ctx || !bedFilter || !bedGain) return;
  const t = ctx.currentTime;
  bedFilter.frequency.setTargetAtTime(320, t, 0.8);
  bedGain.gain.setTargetAtTime(0.05, t, 0.8);
  streak = 0;
}
