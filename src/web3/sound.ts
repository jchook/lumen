/**
 * Sound without assets. Starts on the first gesture (browsers require it). A soft tone when you
 * absorb, rising with the mass; a thump when you burn; a hum that swells near anything that can
 * eat you; a chime for a prize; a bell for the round.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let hum: OscillatorNode | null = null;
let humGain: GainNode | null = null;
let muted = false;

export function soundInit(): void {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    hum = ctx.createOscillator();
    hum.type = "sine";
    hum.frequency.value = 48;
    humGain = ctx.createGain();
    humGain.gain.value = 0;
    hum.connect(humGain).connect(master);
    hum.start();
  } catch {
    ctx = null;
  }
}

export function soundMute(on: boolean): void {
  muted = on;
  if (master && ctx) master.gain.setTargetAtTime(on ? 0 : 0.5, ctx.currentTime, 0.05);
}
export const soundMuted = (): boolean => muted;

/** 0..1 how close the nearest threat is. */
export function soundThreat(level: number): void {
  if (!ctx || !humGain || !hum) return;
  const t = ctx.currentTime;
  humGain.gain.setTargetAtTime(Math.min(0.35, level * 0.35), t, 0.15);
  hum.frequency.setTargetAtTime(48 + level * 30, t, 0.2);
}

function tone(freq: number, dur: number, gain: number, type: OscillatorType = "sine", slide = 0): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/** Absorbing: pitch falls as the mass grows, so a big meal sounds big. */
export function soundAbsorb(mass: number): void {
  const f = 880 / Math.pow(1 + mass, 0.35);
  tone(f, 0.18, 0.12, "sine");
  tone(f * 1.5, 0.12, 0.05, "triangle");
}

export function soundBurn(strength: number): void {
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  const len = 0.08;
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 400 + 600 * strength;
  const g = ctx.createGain();
  g.gain.value = 0.08 + 0.1 * strength;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export function soundLost(): void {
  tone(220, 0.6, 0.15, "sawtooth", -160);
}

export function soundPrize(): void {
  tone(1320, 0.25, 0.08, "sine");
  setTimeout(() => tone(1760, 0.3, 0.08, "sine"), 120);
}

export function soundBell(): void {
  tone(660, 1.2, 0.15, "sine");
  tone(990, 1.0, 0.06, "sine");
}
