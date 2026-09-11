/**
 * The sky's own song, generated. No assets.
 *
 * Each sky picks a key, a mode, a tempo and a bass style from its seed. A slow progression of
 * diatonic chords drives a tape-style pad and a bass that wanders the scale in its own rhythm.
 * Meals play a synth lead from a Markov chain of trance motifs. Threat is an arrangement change: a
 * dissonant tone creeps into the pad and a low pulse on the root tightens on the eighths. Burns are
 * the drum kit, on the grid. Prizes and the round bell ring in key. So the game plays the tune.
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
  bass: "throb" as BassStyle,
};

/**
 * Bass styles. `pattern` is which eighths of a four-beat bar it plays (1 = hit, 2 = accent).
 *   throb: long, round, on the beat.
 *   slap:  short, plucky, tresillo rhythm, a little chorus.
 *   pulse: off-beat eighths, tight and driven: the trance engine.
 */
type BassStyle = "throb" | "slap" | "pulse";
const BASS_STYLES: BassStyle[] = ["throb", "slap", "pulse"];
/**
 * A bass note is two strings' worth of sound: a bright layer (saw through a plucked filter) that
 * dies in `bright` seconds, and a body (fundamental plus sub) that rings for `ring` seconds on its
 * own clock, regardless of the rhythm. `thumb` is the slap transient; `dip` the pitch drop on the
 * hit. `drive` is the saturation on the bus.
 */
const BASS: Record<BassStyle, { pattern: number[]; cutoff: number; q: number; env: number; bright: number; ring: number; thumb: number; dip: number; drive: number; sub: number; chorus: number; gain: number }> = {
  throb: { pattern: [2, 0, 0, 0, 1, 0, 0, 0], cutoff: 260, q: 0.9, env: 500, bright: 0.35, ring: 1.3, thumb: 0, dip: 0.015, drive: 1.5, sub: 0.7, chorus: 0, gain: 0.15 },
  slap: { pattern: [2, 0, 0, 1, 0, 0, 1, 0], cutoff: 240, q: 3.5, env: 1600, bright: 0.18, ring: 0.9, thumb: 0.9, dip: 0.05, drive: 2.2, sub: 0.45, chorus: 6, gain: 0.14 },
  pulse: { pattern: [0, 1, 0, 1, 0, 1, 0, 2], cutoff: 240, q: 2.2, env: 1000, bright: 0.12, ring: 0.45, thumb: 0.3, dip: 0.03, drive: 2.8, sub: 0.5, chorus: 0, gain: 0.12 },
};

function applyBassStyle(): void {
  if (!bassFilter || !bassDrive) return;
  const st = BASS[song.bass];
  // The bus filter only takes the edge off; each note shapes itself.
  bassFilter.frequency.value = 1800;
  bassFilter.Q.value = 0.5;
  const curve = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const x = (i / 511) * 2 - 1;
    curve[i] = Math.tanh(x * st.drive) / Math.tanh(st.drive);
  }
  bassDrive.curve = curve;
}
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
  song.bpm = 56 + Math.floor(r() * 30);
  song.bass = BASS_STYLES[Math.floor(r() * BASS_STYLES.length)]!;
  song.chord = 0;
  lead.motif = Math.floor(r() * MOTIFS.length);
  lead.i = 0;
  return `${NOTE_NAMES[song.root]} ${song.modeName} · ${song.bpm} bpm · ${song.bass} bass`;
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
let padPump: GainNode | null = null;
let wobble: GainNode | null = null;
let flutter: GainNode | null = null;
let padVoices: Array<{ o: OscillatorNode; g: GainNode }> = [];
let bassFilter: BiquadFilterNode | null = null;
let bassDrive: WaveShaperNode | null = null;
let bassBus: GainNode | null = null;
let tension: { o: OscillatorNode; g: GainNode } | null = null;
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

    // Pad, tape-style: voices → lowpass → saturation → highpass → pump → bus. Slow wobble and a
    // faster flutter on pitch, hiss underneath, and a gain pump on every beat.
    padFilter = c.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 1100;
    padFilter.Q.value = 0.9;
    const padDrive = c.createWaveShaper();
    const curve = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      const x = (i / 511) * 2 - 1;
      curve[i] = Math.tanh(x * 1.7) / Math.tanh(1.7);
    }
    padDrive.curve = curve;
    padDrive.oversample = "2x";
    const padHp = c.createBiquadFilter();
    padHp.type = "highpass";
    padHp.frequency.value = 95;
    padPump = c.createGain();
    padPump.gain.value = 1;
    padBus = c.createGain();
    padBus.gain.value = 0.9;
    padFilter.connect(padDrive).connect(padHp).connect(padPump).connect(padBus);
    padBus.connect(dry);
    padBus.connect(send);
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoG = c.createGain();
    lfoG.gain.value = 260;
    lfo.connect(lfoG).connect(padFilter.frequency);
    lfo.start();
    // Wow and flutter, applied to every pad voice's detune.
    const wow = c.createOscillator();
    wow.frequency.value = 0.37;
    wobble = c.createGain();
    wobble.gain.value = 9; // cents
    wow.connect(wobble);
    wow.start();
    const flt = c.createOscillator();
    flt.frequency.value = 5.7;
    flutter = c.createGain();
    flutter.gain.value = 2.5; // cents
    flt.connect(flutter);
    flt.start();
    // Bass chain: filter → drive → bus. The style sets the numbers.
    bassFilter = c.createBiquadFilter();
    bassFilter.type = "lowpass";
    bassFilter.frequency.value = 380;
    bassFilter.Q.value = 1.1;
    bassDrive = c.createWaveShaper();
    bassBus = c.createGain();
    bassBus.gain.value = 1;
    bassFilter.connect(bassDrive).connect(bassBus).connect(dry);
    applyBassStyle();
    // Tension: a tone a step above the chord root, silent until something can eat you.
    const to = c.createOscillator();
    to.type = "triangle";
    to.frequency.value = freq(1, 4);
    const tg = c.createGain();
    tg.gain.value = 0;
    to.connect(tg).connect(padFilter);
    to.start();
    tension = { o: to, g: tg };

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

    startClock();
  } catch {
    ctx = null;
  }
}

export function soundMute(on: boolean): void {
  muted = on;
  if (master && ctx) master.gain.setTargetAtTime(on ? 0 : 0.6, ctx.currentTime, 0.05);
}
export const soundMuted = (): boolean => muted;

// ---------- the clock: chords, pad, bass ----------

let nextEighth = 0;
let eighthIndex = 0;
let clockTimer = 0;
let clockStart = 0;
let threat = 0; // 0..1, from soundThreat
let ducked = 0; // same thing, as the pad sees it

/** Seconds per beat of the current song. */
export const soundBeat = (): number => beat();
/** Which sixteenth of the bar we're on right now, 0..15. */
function slotNow(): number {
  if (!ctx) return 0;
  const six = beat() / 4;
  return ((Math.round((ctx.currentTime - clockStart) / six) % 16) + 16) % 16;
}

const bass = { degree: -7 };

function startClock(): void {
  if (!ctx) return;
  nextEighth = ctx.currentTime + 0.1;
  clockStart = nextEighth;
  eighthIndex = 0;
  playChord(nextEighth);
  clearInterval(clockTimer);
  clockTimer = window.setInterval(schedule, 80);
}

function schedule(): void {
  if (!ctx) return;
  const eighth = beat() / 2;
  while (nextEighth < ctx.currentTime + 0.3) {
    const t = nextEighth;
    const i = eighthIndex;
    const r = hash((song.seed * 31 + i * 17) >>> 0);
    const inBar = i % 8;
    // Harmonic rhythm: a new chord every two bars.
    if (i > 0 && i % 16 === 0) {
      const options = NEXT[song.chord] ?? CHORDS;
      song.chord = options[Math.floor(r() * options.length)]!;
      playChord(t);
      if (tension) tension.o.frequency.setTargetAtTime(freq(song.chord + 1, 4), t, 0.1);
    }
    // Bass: the style's pattern, wandering by step, fond of chord tones, home on the chord change.
    const st = BASS[song.bass];
    const hit = st.pattern[inBar]!;
    if (hit) {
      const roll = r();
      if (roll < 0.5) bass.degree += r() < 0.5 ? 1 : -1;
      else if (roll < 0.85) {
        const tones = chordTones().map((d) => d - 7).sort((a, b) => Math.abs(a - bass.degree) - Math.abs(b - bass.degree));
        bass.degree = tones[0]!;
      }
      if (bass.degree < -10) bass.degree += 7;
      if (bass.degree > -2) bass.degree -= 7;
      if (i % 16 === 0) bass.degree = song.chord - 7;
      playBass(freq(bass.degree, 4), t, eighth * (hit === 2 ? 1.6 : 1.0), hit === 2 ? 1 : 0.8);
    }
    // Threat: a low pulse on the root every eighth, harder as it gets closer.
    if (threat > 0.12) playPulse(freq(0, 2), t, threat, inBar % 2 === 0);
    // The pump, on each beat.
    if (padPump && inBar % 2 === 0) {
      padPump.gain.cancelScheduledValues(t);
      padPump.gain.setValueAtTime(0.42, t);
      padPump.gain.linearRampToValueAtTime(1.0, t + beat() * 0.6);
    }
    nextEighth += eighth;
    eighthIndex++;
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
  // Two detuned saws per chord tone plus a square an octave under the root: the disco-loop body.
  const tones = [song.chord, song.chord + 2, song.chord + 4];
  const voices: Array<[number, number, OscillatorType, number, number]> = []; // deg, oct, type, detune, gain
  for (const deg of tones) {
    voices.push([deg, 3, "sawtooth", rnd(-12, -6), 0.028]);
    voices.push([deg, 3, "sawtooth", rnd(6, 12), 0.028]);
  }
  voices.push([song.chord, 2, "square", 0, 0.03]);
  for (const [deg, oct, type, det, gain] of voices) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = freq(deg, oct);
    o.detune.value = det;
    if (wobble) wobble.connect(o.detune);
    if (flutter) flutter.connect(o.detune);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.setTargetAtTime(gain * (1 - ducked * 0.6), t, 0.9);
    o.connect(g).connect(padFilter!);
    o.start(t);
    padVoices.push({ o, g });
  }
}

/** The last bass note's body, so a new note can choke it the way one string does. */
let lastBass: GainNode | null = null;

function playBass(f: number, t: number, _dur: number, accent: number): void {
  if (!ctx || !bassFilter) return;
  const c = ctx;
  const st = BASS[song.bass];
  const fund = f / 2;
  // One string at a time: the previous body fades quickly under the new hit.
  if (lastBass) lastBass.gain.setTargetAtTime(0.0001, t, 0.04);

  // Body: fundamental (triangle) plus sub (sine), ringing out on its own clock.
  const body = c.createGain();
  const bodyPeak = st.gain * accent;
  body.gain.setValueAtTime(0.0001, t);
  body.gain.exponentialRampToValueAtTime(bodyPeak, t + 0.006);
  body.gain.setTargetAtTime(0.0001, t + 0.02, st.ring * 0.33);
  body.connect(bassFilter);
  lastBass = body;
  const stop = t + st.ring * 1.6 + 0.2;
  const voice = (wave: OscillatorType, fr: number, det: number, amp: number, into: AudioNode): void => {
    const o = c.createOscillator();
    o.type = wave;
    o.frequency.setValueAtTime(fr * (1 + st.dip), t);
    o.frequency.exponentialRampToValueAtTime(fr, t + 0.035);
    o.detune.value = det;
    const g = c.createGain();
    g.gain.value = amp;
    o.connect(g).connect(into);
    o.start(t);
    o.stop(stop);
  };
  voice("triangle", fund, 0, 1, body);
  if (st.sub) voice("sine", fund / 2, 0, st.sub, body);

  // Bright layer: a saw (two if chorused) through a filter that snaps open on the hit and closes
  // over `bright`; its own amp decays on the same clock so the pluck dies before the body does.
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.Q.value = st.q;
  filt.frequency.setValueAtTime(st.cutoff + st.env * accent, t);
  filt.frequency.exponentialRampToValueAtTime(st.cutoff, t + st.bright);
  const bg = c.createGain();
  bg.gain.setValueAtTime(0.0001, t);
  bg.gain.exponentialRampToValueAtTime(bodyPeak * 0.9, t + 0.004);
  bg.gain.setTargetAtTime(0.0001, t + 0.01, st.bright * 0.5);
  filt.connect(bg).connect(bassFilter);
  voice("sawtooth", fund, 0, 0.7, filt);
  if (st.chorus) voice("sawtooth", fund, st.chorus, 0.45, filt);

  // Thumb: a short knock of band-limited noise at the onset.
  if (st.thumb) {
    const n = noise(0.04);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700;
    bp.Q.value = 1.4;
    const tg = c.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.12 * st.thumb * accent, t + 0.003);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(bp).connect(tg).connect(bassFilter);
    n.start(t);
  }
}

/** The threat pulse: a short, dark thud on the root, in the bass chain. */
function playPulse(f: number, t: number, level: number, strong: boolean): void {
  if (!ctx || !bassFilter) return;
  const c = ctx;
  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(f * 1.5, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  const g = c.createGain();
  const peak = (strong ? 0.14 : 0.08) * level * level;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
  o.connect(g).connect(bassFilter);
  o.start(t);
  o.stop(t + 0.15);
}

// ---------- threat ----------

/** 0..1: how close the nearest thing that can eat me is. Turns the arrangement, not a noise. */
export function soundThreat(level: number): void {
  if (!ctx || !padFilter) return;
  const t = ctx.currentTime;
  const k = Math.min(1, Math.max(0, level));
  threat = k;
  ducked = k;
  // The pad darkens and thins; the tension tone creeps in a step above the root.
  padFilter.frequency.setTargetAtTime(1100 - k * 750, t, 0.5);
  for (const v of padVoices) v.g.gain.setTargetAtTime(0.028 * (1 - k * 0.5), t, 0.5);
  if (tension) tension.g.gain.setTargetAtTime(k * k * 0.06, t, 0.4);
}

// ---------- lead: meals play the melody ----------

/**
 * Motifs in scale degrees relative to the current chord's root, the shapes trance leads are made
 * of: root-fifth pulses, climbs, arpeggios, octave jumps, falls, hooks, risers. A Markov table picks
 * the next motif when one ends, favouring related shapes. Because degrees are relative to the
 * chord, the same riff shifts with the harmony the way a real lead does.
 */
const MOTIFS: number[][] = [
  [0, 0, 4, 0, 0, 4, 2, 0], // pulse
  [0, 1, 2, 4, 2, 1, 0, -1], // climb
  [0, 2, 4, 7, 4, 2, 0, 2], // arp
  [0, 7, 0, 7, 4, 7, 2, 0], // octave
  [7, 6, 4, 2, 0, 2, 4, 0], // fall
  [4, 4, 2, 4, 0, 0, 2, 0], // hook
  [0, 2, 4, 5, 6, 7, 6, 4], // riser
  [0, -1, 0, 2, 0, -1, 0, 4], // turn
];
const MARKOV: number[][] = [
  [3, 2, 2, 1, 0, 3, 0, 2], // from pulse
  [1, 2, 3, 1, 1, 1, 2, 1], // from climb
  [2, 1, 2, 3, 2, 1, 1, 0], // from arp
  [3, 0, 2, 1, 2, 2, 0, 1], // from octave
  [3, 2, 1, 0, 1, 2, 0, 3], // from fall
  [2, 2, 1, 2, 1, 2, 1, 3], // from hook
  [1, 0, 1, 2, 3, 2, 0, 1], // from riser
  [3, 2, 1, 1, 0, 2, 1, 1], // from turn
];
const lead = { motif: 0, i: 0, last: 0, degree: 7, streak: 0 };

function nextMotif(): void {
  const row = MARKOV[lead.motif]!;
  const total = row.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let k = 0; k < row.length; k++) {
    r -= row[k]!;
    if (r <= 0) {
      lead.motif = k;
      break;
    }
  }
  lead.i = 0;
}

/**
 * One lead note per meal, the next note of the current motif. A long pause starts a fresh motif.
 * Register is kept low: specks an octave above the riff, prizes an octave below, never shrill.
 */
export function soundAbsorb(mass: number): void {
  if (!ctx || !leadBus) return;
  const c = ctx;
  const now = c.currentTime;
  if (now - lead.last > 4) nextMotif();
  lead.last = now;
  const motif = MOTIFS[lead.motif]!;
  const rel = motif[lead.i]!;
  lead.i++;
  if (lead.i >= motif.length) nextMotif();
  const deg = song.chord + rel;
  const oct = mass < 1 ? 4 : mass < 12 ? 3 : 2;
  const f = freq(deg, oct);
  const dur = 0.45 + Math.min(1.0, mass * 0.05);
  const t = now;
  // Three layers: a square, a detuned saw for width, and a sine an octave under for weight.
  const layers: Array<[OscillatorType, number, number, number]> = [
    ["square", f, rnd(-3, 3), 0.55],
    ["sawtooth", f, rnd(6, 11), 0.35],
    ["sine", f / 2, 0, 0.5],
  ];
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.Q.value = 2.2;
  filt.frequency.setValueAtTime(Math.min(3200, f * 5), t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(240, f * 1.3), t + 0.4);
  const drive = c.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(x * 1.5) / Math.tanh(1.5);
  }
  drive.curve = curve;
  const g = c.createGain();
  const peak = 0.08 + Math.min(0.07, mass * 0.007);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.setTargetAtTime(peak * 0.6, t + 0.05, 0.2);
  g.gain.setTargetAtTime(0.0001, t + dur, 0.15);
  filt.connect(drive).connect(g).connect(leadBus);
  for (const [type, fr, det, amp] of layers) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = fr;
    o.detune.value = det;
    const lg = c.createGain();
    lg.gain.value = amp;
    o.connect(lg).connect(filt);
    o.start(t);
    o.stop(t + dur + 0.9);
  }
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
    padFilter.frequency.setTargetAtTime(1100, ctx.currentTime, 0.8);
    if (leadDelay) leadDelay.delayTime.setTargetAtTime(beat() * 0.75, ctx.currentTime, 0.2);
    startClock();
  }
  return name;
}
