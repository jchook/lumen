/**
 * The sky's own song, generated. No assets.
 *
 * Each sky picks a key and a mode from its seed. A slow progression of diatonic chords drives a
 * soft pad and a bass that wanders the scale, mostly by step, landing on chord tones. Meals play a
 * synth lead: a note from the current chord and scale in a register set by the mass, and a streak
 * of meals walks the melody up the scale. Threat is a beating pair on the key's root and a band of
 * wind. Burns are air. Prizes and the round bell ring in key. So the game plays the tune.
 *
 *   master ─ compressor ─ out
 *     ├─ dry
 *     └─ reverb send (generated impulse, dark)
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let dry: GainNode | null = null;
let send: GainNode | null = null;
let muted = false;

// ---------- key, mode, harmony ----------

const MODES: Record<string, number[]> = {
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  ionian: [0, 2, 4, 5, 7, 9, 11],
};
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** Chord degrees we use (I, ii, IV, V, vi) and where each tends to go next. */
const CHORDS = [0, 1, 3, 4, 5];
const NEXT: Record<number, number[]> = { 0: [1, 3, 4, 5, 3, 5], 1: [4, 3, 4], 3: [0, 4, 5, 0], 4: [0, 5, 0, 3], 5: [3, 1, 3, 4] };

const song = {
  root: 2, // semitones above C
  mode: MODES.dorian!,
  modeName: "dorian",
  chord: 0, // scale degree the current chord is built on
  bpm: 66,
  seed: 1,
};
const beat = (): number => 60 / song.bpm;

function hash(n: number): () => number {
  let a = n >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Choose the sky's key and mode from its seed. Returns a name like "F# dorian". */
export function soundKey(seed: number): string {
  const r = hash(seed * 7919 + 13);
  song.seed = seed;
  song.root = Math.floor(r() * 12);
  const names = Object.keys(MODES);
  song.modeName = names[Math.floor(r() * names.length)]!;
  song.mode = MODES[song.modeName]!;
  song.bpm = 58 + Math.floor(r() * 16);
  song.chord = 0;
  lead.degree = 7;
  lead.streak = 0;
  return `${NOTE_NAMES[song.root]} ${song.modeName}`;
}

/** Frequency of scale degree `deg` (any integer; 7 per octave) in octave `oct` (C4 = 261.6 is oct 4). */
function freq(deg: number, oct: number): number {
  const o = Math.floor(deg / 7);
  const d = ((deg % 7) + 7) % 7;
  const semis = song.root + song.mode[d]! + 12 * (oct + o - 4);
  return 261.6256 * Math.pow(2, semis / 12);
}
const chordTones = (): number[] => [song.chord, song.chord + 2, song.chord + 4];
const isChordTone = (deg: number): boolean => chordTones().some((c) => ((deg - c) % 7 + 7) % 7 === 0);

// ---------- plumbing ----------

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

// Long-lived voices.
let padFilter: BiquadFilterNode | null = null;
let padBus: GainNode | null = null;
let padVoices: Array<{ o: OscillatorNode; g: GainNode }> = [];
let bassFilter: BiquadFilterNode | null = null;
let droneA: OscillatorNode | null = null;
let droneB: OscillatorNode | null = null;
let droneGain: GainNode | null = null;
let windGain: GainNode | null = null;
let windFilter: BiquadFilterNode | null = null;
let leadDelay: DelayNode | null = null;
let leadBus: GainNode | null = null;

export function soundInit(): void {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    const c = ctx;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    master = c.createGain();
    master.gain.value = muted ? 0 : 0.6;
    comp.connect(master).connect(c.destination);
    dry = c.createGain();
    dry.connect(comp);
    const verb = c.createConvolver();
    verb.buffer = impulse(3.4, 2.4);
    const verbTone = c.createBiquadFilter();
    verbTone.type = "lowpass";
    verbTone.frequency.value = 2400;
    send = c.createGain();
    send.gain.value = 0.5;
    send.connect(verb).connect(verbTone).connect(comp);

    // Pad: voices come and go with the chords; the filter breathes.
    padFilter = c.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 420;
    padFilter.Q.value = 0.6;
    padBus = c.createGain();
    padBus.gain.value = 0.9;
    padFilter.connect(padBus);
    padBus.connect(dry);
    padBus.connect(send);
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoG = c.createGain();
    lfoG.gain.value = 160;
    lfo.connect(lfoG).connect(padFilter.frequency);
    lfo.start();

    // Bass tone shaping.
    bassFilter = c.createBiquadFilter();
    bassFilter.type = "lowpass";
    bassFilter.frequency.value = 380;
    bassFilter.Q.value = 1.1;
    bassFilter.connect(dry);

    // Lead: through a dotted-eighth delay so single notes become phrases.
    leadBus = c.createGain();
    leadBus.gain.value = 1;
    leadBus.connect(dry);
    const toVerb = c.createGain();
    toVerb.gain.value = 0.5;
    leadBus.connect(toVerb).connect(send);
    leadDelay = c.createDelay(2);
    leadDelay.delayTime.value = beat() * 0.75;
    const fb = c.createGain();
    fb.gain.value = 0.32;
    const fbTone = c.createBiquadFilter();
    fbTone.type = "lowpass";
    fbTone.frequency.value = 1800;
    leadBus.connect(leadDelay);
    leadDelay.connect(fbTone).connect(fb).connect(leadDelay);
    const wet = c.createGain();
    wet.gain.value = 0.45;
    leadDelay.connect(wet).connect(dry);
    wet.connect(send);

    // Threat: a beating pair on the root, and wind.
    droneA = c.createOscillator();
    droneA.type = "sawtooth";
    droneB = c.createOscillator();
    droneB.type = "sawtooth";
    const droneFilter = c.createBiquadFilter();
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 170;
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

    tuneDrone();
    startClock();
  } catch {
    ctx = null;
  }
}

function tuneDrone(): void {
  if (!droneA || !droneB || !ctx) return;
  const f = freq(0, 2);
  droneA.frequency.setTargetAtTime(f, ctx.currentTime, 0.2);
  droneB.frequency.setTargetAtTime(f + 1.5, ctx.currentTime, 0.2);
}

export function soundMute(on: boolean): void {
  muted = on;
  if (master && ctx) master.gain.setTargetAtTime(on ? 0 : 0.6, ctx.currentTime, 0.05);
}
export const soundMuted = (): boolean => muted;

// ---------- the clock: chords, pad, bass ----------

let nextBeat = 0;
let beatIndex = 0;
let clockTimer = 0;
let clockStart = 0;

/** Seconds per beat of the current song. */
export const soundBeat = (): number => beat();
/** Which sixteenth of the bar we're on right now, 0..15. */
function slotNow(): number {
  if (!ctx) return 0;
  const six = beat() / 4;
  return ((Math.round((ctx.currentTime - clockStart) / six) % 16) + 16) % 16;
}
const bass = { degree: -7, rests: 0 };
let ducked = 0; // threat level, closes the pad

function startClock(): void {
  if (!ctx) return;
  nextBeat = ctx.currentTime + 0.1;
  clockStart = nextBeat;
  beatIndex = 0;
  playChord(nextBeat);
  clearInterval(clockTimer);
  clockTimer = window.setInterval(schedule, 90);
}

function schedule(): void {
  if (!ctx) return;
  while (nextBeat < ctx.currentTime + 0.35) {
    const t = nextBeat;
    const r = hash((song.seed * 31 + beatIndex * 17) >>> 0);
    // Harmonic rhythm: a new chord every 8 beats, chosen by the table.
    if (beatIndex > 0 && beatIndex % 8 === 0) {
      const options = NEXT[song.chord] ?? CHORDS;
      song.chord = options[Math.floor(r() * options.length)]!;
      playChord(t);
    }
    // Bass on beats 1 and 3, sometimes 4; it wanders by step and likes chord tones.
    const on = beatIndex % 4 === 0 || beatIndex % 4 === 2 || (beatIndex % 4 === 3 && r() < 0.3);
    if (on) {
      const roll = r();
      if (roll < 0.55) bass.degree += r() < 0.5 ? 1 : -1;
      else if (roll < 0.85) {
        // Jump to the nearest chord tone.
        const tones = chordTones().map((d) => d - 7).sort((a, b) => Math.abs(a - bass.degree) - Math.abs(b - bass.degree));
        bass.degree = tones[0]!;
      }
      if (bass.degree < -10) bass.degree += 7;
      if (bass.degree > -2) bass.degree -= 7;
      if (beatIndex % 8 === 0) bass.degree = song.chord - 7; // land on the root with the chord
      playBass(freq(bass.degree, 4), t, beat() * (beatIndex % 4 === 0 ? 1.6 : 0.9));
    }
    nextBeat += beat();
    beatIndex++;
  }
}

function playChord(t: number): void {
  if (!ctx || !padFilter) return;
  const c = ctx;
  // Release the old voices.
  for (const v of padVoices) {
    v.g.gain.setTargetAtTime(0.0001, t, 0.9);
    v.o.stop(t + 4);
  }
  padVoices = [];
  const tones = [song.chord, song.chord + 2, song.chord + 4, song.chord + 7];
  tones.forEach((deg, i) => {
    const o = c.createOscillator();
    o.type = i === 3 ? "triangle" : "sawtooth";
    o.frequency.value = freq(deg, i === 3 ? 4 : 3);
    o.detune.value = rnd(-7, 7);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.setTargetAtTime((i === 0 ? 0.05 : 0.035) * (1 - ducked * 0.6), t, 1.4);
    o.connect(g).connect(padFilter!);
    o.start(t);
    padVoices.push({ o, g });
  });
}

function playBass(f: number, t: number, dur: number): void {
  if (!ctx || !bassFilter) return;
  const c = ctx;
  const o = c.createOscillator();
  o.type = "triangle";
  o.frequency.value = f / 2;
  const o2 = c.createOscillator();
  o2.type = "sine";
  o2.frequency.value = f / 4;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
  g.gain.setTargetAtTime(0.09, t + 0.1, 0.25);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.12);
  o.connect(g);
  o2.connect(g);
  g.connect(bassFilter);
  o.start(t);
  o2.start(t);
  o.stop(t + dur + 0.8);
  o2.stop(t + dur + 0.8);
}

// ---------- threat ----------

/** 0..1: how close the nearest thing that can eat me is. */
export function soundThreat(level: number): void {
  if (!ctx || !droneGain || !windGain || !windFilter || !droneB || !padFilter) return;
  const t = ctx.currentTime;
  const k = Math.min(1, Math.max(0, level));
  ducked = k;
  droneGain.gain.setTargetAtTime(k * k * 0.13, t, 0.25);
  droneB.frequency.setTargetAtTime(freq(0, 2) + 1.5 + k * 4, t, 0.3);
  windGain.gain.setTargetAtTime(k * 0.08, t, 0.3);
  windFilter.frequency.setTargetAtTime(300 + k * 900, t, 0.3);
  padFilter.frequency.setTargetAtTime(420 - k * 220, t, 0.5);
  for (const v of padVoices) v.g.gain.setTargetAtTime(0.04 * (1 - k * 0.6), t, 0.5);
}

// ---------- lead: meals play the melody ----------

const lead = { degree: 7, streak: 0, last: 0 };

/**
 * One lead note per meal. Mass sets the register (specks high, prizes low). The first note of a
 * phrase lands on a chord tone near the middle; a streak walks up the scale, stepping onto chord
 * tones every other note so it stays inside the harmony.
 */
export function soundAbsorb(mass: number): void {
  if (!ctx || !leadBus) return;
  const c = ctx;
  const now = c.currentTime;
  const streak = now - lead.last < 1.8 ? lead.streak + 1 : 0;
  lead.streak = streak;
  lead.last = now;
  if (streak === 0) {
    // Start a phrase on a chord tone around the middle of the range.
    const tones = chordTones().map((d) => d + 7);
    lead.degree = tones[Math.floor(Math.random() * tones.length)]!;
  } else {
    lead.degree += streak % 2 === 1 ? 1 : Math.random() < 0.7 ? 1 : 2;
    while (!isChordTone(lead.degree) && streak % 2 === 0) lead.degree += 1;
    if (lead.degree > 16) lead.degree -= 7;
  }
  const oct = mass < 1 ? 5 : mass < 4 ? 4 : mass < 12 ? 4 : 3;
  const f = freq(lead.degree, oct) * (mass < 4 ? 1 : 0.5);
  const dur = 0.5 + Math.min(1.2, mass * 0.06);
  const t = now;
  // Two oscillators: a soft pulse and a triangle an octave up, through a plucked filter.
  const o1 = c.createOscillator();
  o1.type = "square";
  o1.frequency.value = f;
  o1.detune.value = rnd(-4, 4);
  const o2 = c.createOscillator();
  o2.type = "triangle";
  o2.frequency.value = f * 2;
  o2.detune.value = rnd(-4, 4);
  const g2 = c.createGain();
  g2.gain.value = 0.35;
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.Q.value = 3;
  filt.frequency.setValueAtTime(Math.min(6000, f * 6), t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(300, f * 1.4), t + 0.35);
  const g = c.createGain();
  const peak = 0.07 + Math.min(0.08, mass * 0.008);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.setTargetAtTime(peak * 0.55, t + 0.05, 0.18);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.14);
  o1.connect(filt);
  o2.connect(g2).connect(filt);
  filt.connect(g).connect(leadBus);
  o1.start(t);
  o2.start(t);
  o1.stop(t + dur + 0.8);
  o2.stop(t + dur + 0.8);
}

// ---------- one-shots ----------

/** A bell-ish voice on scale degree `deg`, inharmonic partials, long tail, into the reverb. */
function bell(deg: number, oct: number, dur: number, gain: number, partials: Array<[number, number, number]>): void {
  if (!ctx || !dry || !send) return;
  const c = ctx;
  const t = c.currentTime;
  const f = freq(deg, oct);
  const out = c.createGain();
  out.connect(dry);
  const toVerb = c.createGain();
  toVerb.gain.value = 0.9;
  out.connect(toVerb).connect(send);
  for (const [ratio, amp, life] of partials) {
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.value = f * ratio;
    o.detune.value = rnd(-5, 5);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * life);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur * life + 0.05);
  }
}
const SOFT: Array<[number, number, number]> = [[1, 1, 1], [2.01, 0.3, 0.6], [3.02, 0.1, 0.35]];
const CHURCH: Array<[number, number, number]> = [[1, 1, 1], [2.76, 0.45, 0.7], [5.4, 0.2, 0.45], [8.9, 0.08, 0.3]];

/**
 * Burning is the drum kit. Every burn lands on a sixteenth of the song (the sim only lets burns
 * happen on the grid), and the sound depends on where in the bar it falls: downbeats get a low kick
 * tuned to the key's root, other on-beats a tom on the fifth, off-beats a tight tick. Strength sets
 * how hard it's hit. Together, everyone's burning is the rhythm section.
 */
export function soundBurn(strength: number): void {
  if (!ctx || !dry || !send) return;
  const c = ctx;
  const t = c.currentTime;
  const k = Math.min(1, Math.max(0.15, strength));
  const slot = slotNow();
  const down = slot % 8 === 0;
  const onBeat = slot % 4 === 0;
  const off = slot % 2 === 1;
  // Pitched body: a sine that drops fast, tuned to root (kick) or fifth (tom).
  const body = c.createOscillator();
  body.type = "sine";
  const f0 = down ? freq(0, 2) : onBeat ? freq(4, 2) : freq(0, 3);
  body.frequency.setValueAtTime(f0 * (down ? 3.2 : 2.2), t);
  body.frequency.exponentialRampToValueAtTime(f0, t + (down ? 0.09 : 0.05));
  const drive = c.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(x * (down ? 2.2 : 1.4));
  }
  drive.curve = curve;
  const bg = c.createGain();
  const peak = (off ? 0.07 : down ? 0.26 : 0.17) * (0.5 + 0.5 * k);
  const life = off ? 0.09 : down ? 0.32 : 0.2;
  bg.gain.setValueAtTime(0.0001, t);
  bg.gain.exponentialRampToValueAtTime(peak, t + 0.006);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + life);
  body.connect(drive).connect(bg).connect(dry);
  const toVerb = c.createGain();
  toVerb.gain.value = down ? 0.25 : 0.12;
  bg.connect(toVerb).connect(send);
  body.start(t);
  body.stop(t + life + 0.05);
  // Transient: a short bright click so it cuts through, brighter when hit harder.
  const click = noise(0.05);
  const hp = c.createBiquadFilter();
  hp.type = off ? "bandpass" : "highpass";
  hp.frequency.value = off ? 2600 : 1800 + 1600 * k;
  hp.Q.value = off ? 2 : 0.7;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.0001, t);
  cg.gain.exponentialRampToValueAtTime((off ? 0.05 : 0.07) * (0.4 + 0.6 * k), t + 0.003);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + (off ? 0.03 : 0.045));
  click.connect(hp).connect(cg).connect(dry);
  click.start(t);
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

/** A prize: the current chord, rolled upward, two octaves up. */
export function soundPrize(): void {
  const tones = [song.chord, song.chord + 2, song.chord + 4, song.chord + 7];
  tones.forEach((deg, i) => setTimeout(() => bell(deg, 6, 2.4, 0.06, SOFT), i * 100));
}

/** The round bell: root and fifth, church partials, long tail. */
export function soundBell(): void {
  bell(0, 4, 4.5, 0.15, CHURCH);
  setTimeout(() => bell(4, 4, 4.0, 0.11, CHURCH), 380);
}

/** Absorbed: the pad closes and a low tone falls away. */
export function soundLost(): void {
  if (!ctx || !dry || !padFilter) return;
  const c = ctx;
  const t = c.currentTime;
  padFilter.frequency.setTargetAtTime(90, t, 0.6);
  for (const v of padVoices) v.g.gain.setTargetAtTime(0.01, t, 1.2);
  const o = c.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(freq(0, 4), t);
  o.frequency.exponentialRampToValueAtTime(freq(-3, 3), t + 1.6);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
  o.connect(g).connect(dry);
  if (send) g.connect(send);
  o.start(t);
  o.stop(t + 1.9);
}

/** A new sky: new key, the clock restarts, the pad opens back up. */
export function soundReset(seed: number): string {
  const name = soundKey(seed);
  if (ctx && padFilter) {
    padFilter.frequency.setTargetAtTime(420, ctx.currentTime, 0.8);
    if (leadDelay) leadDelay.delayTime.setTargetAtTime(beat() * 0.75, ctx.currentTime, 0.2);
    tuneDrone();
    startClock();
  }
  return name;
}
