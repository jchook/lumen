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
let masterTone: BiquadFilterNode | null = null;
let songGain: GainNode | null = null;
let stopped = false;
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
  bass: "deep" as BassStyle,
  swing: 0.1, // fraction of an eighth the off-beats are pushed late
};

/**
 * Bass styles. A pattern is one bar of eighths; each step says what happens on it:
 *   v    velocity 0..1 (0 = rest, ~0.35 = ghost)
 *   len  how many eighths the note holds (0.5 = staccato, 2 = held)
 *   s    slide: legato into this note (glide, no retrigger) — the 303 move
 *   o    an octave up (the disco bounce)
 *   deep:   on the beat, long holds, a slide into beat three, ghosts.
 *   funk:   tresillo with ghosts and staccato, a thumb on accents, a slide before the turnaround.
 *   bounce: root and octave on every eighth, tight, one held root at the top of the bar.
 * The voice is one mono synth: envelopes retrigger, notes glide, nothing is ever cut.
 */
type BassStyle = "deep" | "funk" | "bounce";
const BASS_STYLES: BassStyle[] = ["deep", "funk", "bounce"];
interface Step {
  v: number;
  len: number;
  s?: boolean;
  o?: boolean;
}
const R: Step = { v: 0, len: 0 };
const st = (v: number, len: number, extra: Partial<Step> = {}): Step => ({ v, len, ...extra });
const BASS: Record<BassStyle, { pattern: Step[]; cutoff: number; q: number; env: number; bright: number; ring: number; thumb: number; dip: number; drive: number; sub: number; chorus: number; gain: number; glide: number; attack: number }> = {
  deep: {
    pattern: [st(1, 2), R, st(0.35, 0.5), st(0.6, 1, { s: true }), st(0.85, 2), R, st(0.35, 0.5), st(0.5, 0.5)],
    cutoff: 260, q: 0.9, env: 420, bright: 0.35, ring: 1.2, thumb: 0, dip: 0.012, drive: 1.5, sub: 0.7, chorus: 0, gain: 0.15, glide: 0.03, attack: 0.012,
  },
  funk: {
    pattern: [st(1, 0.5), R, st(0.35, 0.5), st(0.8, 1), R, st(0.35, 0.5), st(0.8, 0.5), st(0.6, 1, { s: true })],
    cutoff: 240, q: 3.0, env: 1400, bright: 0.18, ring: 0.8, thumb: 0.9, dip: 0.05, drive: 2.2, sub: 0.45, chorus: 6, gain: 0.14, glide: 0.012, attack: 0.006,
  },
  bounce: {
    pattern: [st(0.8, 1), st(0.7, 0.5, { o: true }), st(0.8, 0.5), st(0.7, 0.5, { o: true }), st(0.8, 0.5), st(0.7, 0.5, { o: true }), st(1, 0.5), st(0.7, 0.5, { o: true })],
    cutoff: 240, q: 2.0, env: 900, bright: 0.11, ring: 0.45, thumb: 0.25, dip: 0.03, drive: 2.6, sub: 0.5, chorus: 4, gain: 0.12, glide: 0.006, attack: 0.005,
  },
};

function applyBassStyle(): void {
  if (!mono || !bassDrive) return;
  const st = BASS[song.bass];
  mono.vcf.Q.value = st.q;
  mono.brightOscs[1]!.detune.value = st.chorus || 0;
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
  song.bpm = 90 + Math.floor(r() * 33);
  song.bass = BASS_STYLES[Math.floor(r() * BASS_STYLES.length)]!;
  song.swing = 0.07 + r() * 0.1;
  song.chord = 0;
  lead.motif = Math.floor(r() * MOTIFS.length);
  lead.i = 0;
  return `${NOTE_NAMES[song.root]} ${song.modeName} · ${song.bpm} bpm · ${song.bass} bass · swing ${Math.round(50 + song.swing * 50)}%`;
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
// The mixer: one bus per instrument into the master compressor. Pad and lead go through the
// sidechain duck, keyed from the kick, so the whole mix breathes with the beat.
let duck: GainNode | null = null;
let drumBus: GainNode | null = null;
let bassBus: GainNode | null = null;
let bassDrive: WaveShaperNode | null = null;
let bassDuck: GainNode | null = null;
let bassTone: BiquadFilterNode | null = null;
/** The bass is one monophonic synth. */
let mono: { oscs: OscillatorNode[]; vcf: BiquadFilterNode; vca: GainNode; bright: GainNode; brightOscs: OscillatorNode[] } | null = null;
let tension: { o: OscillatorNode; g: GainNode } | null = null;
let leadDelay: DelayNode | null = null;
let leadBus: GainNode | null = null;

/**
 * iOS plays Web Audio through the "ambient" session, which the ring/silent switch mutes. A looping
 * silent <audio> element started from a user gesture moves the page to the "playback" session,
 * and Web Audio follows. Harmless elsewhere, so it isn't gated on the user agent.
 */
let silentTrack: HTMLAudioElement | null = null;
function unlockSilentSwitch(): void {
  if (silentTrack) return;
  try {
    // 0.1 s of 8-bit mono silence as a WAV: a 44-byte header plus 800 mid-point samples.
    const n = 800;
    const buf = new Uint8Array(44 + n);
    const dv = new DataView(buf.buffer);
    const tag = (o: number, t: string) => { for (let i = 0; i < t.length; i++) buf[o + i] = t.charCodeAt(i); };
    tag(0, "RIFF"); dv.setUint32(4, 36 + n, true); tag(8, "WAVE"); tag(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
    tag(36, "data"); dv.setUint32(40, n, true);
    buf.fill(128, 44);
    const a = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
    a.loop = true;
    a.setAttribute("playsinline", "");
    a.volume = 0.01;
    a.play().catch(() => {});
    silentTrack = a;
    document.addEventListener("visibilitychange", () => {
      if (!silentTrack) return;
      if (document.hidden) silentTrack.pause();
      else silentTrack.play().catch(() => {});
    });
  } catch {}
}

/** Call from any user gesture: browsers start the context suspended until one, and phones suspend it again on interruptions. */
export function soundResume(): void {
  unlockSilentSwitch();
  if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
}

export function soundInit(): void {
  if (ctx) return;
  try {
    ctx = new AudioContext();
    const c = ctx;
    if (c.state !== "running") c.resume().catch(() => {});
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    master = c.createGain();
    master.gain.value = muted ? 0 : 0.6;
    masterTone = c.createBiquadFilter();
    masterTone.type = "lowpass";
    masterTone.frequency.value = 20000;
    masterTone.Q.value = 0.5;
    songGain = c.createGain();
    songGain.gain.value = 1;
    comp.connect(songGain).connect(masterTone).connect(master).connect(c.destination);
    dry = c.createGain();
    dry.connect(comp);
    duck = c.createGain();
    duck.gain.value = 1;
    duck.connect(comp);
    drumBus = c.createGain();
    drumBus.gain.value = 0.9;
    drumBus.connect(comp);
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
    padPump = null;
    padBus = c.createGain();
    padBus.gain.value = 0.9;
    padFilter.connect(padDrive).connect(padHp).connect(padBus);
    padBus.connect(duck);
    padBus.connect(send);
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.06;
    const lfoG = c.createGain();
    lfoG.gain.value = 90;
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
    // Bass: one mono synth. Oscillators run forever; notes retrigger the envelopes and glide the
    // pitch, so nothing ever clicks or cuts. body (tri + sub) → vca; saws → vcf → bright → vca.
    const vca = c.createGain();
    vca.gain.value = 0.0001;
    bassDrive = c.createWaveShaper();
    bassDrive.oversample = "2x";
    bassTone = c.createBiquadFilter();
    bassTone.type = "lowpass";
    bassTone.frequency.value = 1400;
    bassTone.Q.value = 0.6;
    bassDuck = c.createGain();
    bassDuck.gain.value = 1;
    bassBus = c.createGain();
    bassBus.gain.value = 1;
    vca.connect(bassDrive).connect(bassTone).connect(bassDuck).connect(bassBus).connect(comp);
    const vcf = c.createBiquadFilter();
    vcf.type = "lowpass";
    const bright = c.createGain();
    bright.gain.value = 0.0001;
    vcf.connect(bright).connect(vca);
    const mk = (type: OscillatorType, amp: number, into: AudioNode, det = 0): OscillatorNode => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = 55;
      o.detune.value = det;
      const g = c.createGain();
      g.gain.value = amp;
      o.connect(g).connect(into);
      o.start();
      return o;
    };
    mono = {
      oscs: [mk("triangle", 1, vca), mk("sine", 0.6, vca)],
      brightOscs: [mk("sawtooth", 0.7, vcf), mk("sawtooth", 0.45, vcf, 5)],
      vcf,
      vca,
      bright,
    };
    // The second saw drifts against the first, so the tone moves inside a note.
    const drift = c.createOscillator();
    drift.frequency.value = 0.31;
    const driftG = c.createGain();
    driftG.gain.value = 5;
    drift.connect(driftG).connect(mono.brightOscs[1]!.detune);
    drift.start();
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

    // Lead: through a dotted-eighth delay so single notes become phrases. Ducked with the pad.
    leadBus = c.createGain();
    leadBus.gain.value = 0.85;
    leadBus.connect(duck);
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
    leadDelay.connect(wet).connect(duck);
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
/** "none" before the first gesture, then the AudioContext state. */
export const soundState = (): string => ctx?.state ?? "none";

// ---------- the clock: chords, pad, bass ----------

let nextEighth = 0;
let eighthIndex = 0;
let clockTimer = 0;
let clockStart = 0;
let threat = 0; // 0..1, from soundThreat
let ducked = 0; // same thing, as the pad sees it

/**
 * The round has a shape and the arrangement follows it. Sections switch on bar lines:
 *   intro    the first eight bars: pad, bass and hats, no kick, no clap
 *   groove   the full kit
 *   break    a minute before the bell: kick and clap drop, the pad opens, the bass thins
 *   build    kick returns, hats double up
 *   finale   the last thirty seconds: full kit, a riser sweeping up under everything
 * `arc.t` is game time and `arc.total` the round length (0 = no bell, so groove for ever).
 */
type Section = "intro" | "groove" | "break" | "build" | "finale";
const arc = { t: 0, total: 0, section: "intro" as Section, riser: false };
function wantedSection(t: number): Section {
  if (eighthIndex < 64) return "intro";
  if (!arc.total) return "groove";
  const left = arc.total - t;
  if (left <= 30) return "finale";
  if (left <= 44) return "build";
  if (left <= 60) return "break";
  return "groove";
}
/** Where the round is, from the game each frame. */
export function soundArc(t: number, total: number): void {
  arc.t = t;
  arc.total = total;
}
export const soundSection = (): Section => arc.section;

/** The finale's riser: filtered noise climbing for thirty seconds, swelling into the bell. */
function riser(t: number, seconds: number): void {
  if (!ctx || !drumBus) return;
  const c = ctx;
  const n = noise(seconds + 0.5);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.2;
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(7000, t + seconds);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.012, t + 2);
  g.gain.exponentialRampToValueAtTime(0.07, t + seconds);
  g.gain.setTargetAtTime(0.0001, t + seconds, 0.08);
  n.connect(bp).connect(g).connect(drumBus);
  n.start(t);
}

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
  if (!ctx || stopped) return;
  const eighth = beat() / 2;
  while (nextEighth < ctx.currentTime + 0.3) {
    const i = eighthIndex;
    const inBar = i % 8;
    // Swing: off-beat eighths land late. That's the pocket.
    const t = nextEighth + (inBar % 2 === 1 ? eighth * song.swing : 0);
    const r = hash((song.seed * 31 + i * 17) >>> 0);
    // Game time at this eighth, and the section it falls in. Sections only change on a bar line.
    const gt = arc.t + (t - ctx.currentTime);
    if (inBar === 0) {
      const want = wantedSection(gt);
      if (want !== arc.section) {
        arc.section = want;
        if (want === "break" && padFilter) padFilter.frequency.setTargetAtTime(2600, t, 1.5);
        if (want === "finale" && !arc.riser) {
          arc.riser = true;
          riser(t, Math.max(4, arc.total - gt));
        }
      }
    }
    const sec = arc.section;
    const kicks = sec === "groove" || sec === "build" || sec === "finale";
    // Harmonic rhythm: a new chord every two bars.
    if (i > 0 && i % 16 === 0) {
      const options = NEXT[song.chord] ?? CHORDS;
      song.chord = options[Math.floor(r() * options.length)]!;
      playChord(t);
      if (tension) tension.o.frequency.setTargetAtTime(freq(song.chord + 1, 4), t, 0.1);
    }
    // Bass: the style's pattern, wandering by step, fond of chord tones, home on the chord change.
    const style = BASS[song.bass];
    const step = style.pattern[inBar]!;
    // In the break the bass keeps only its real hits; the ghosts and slides go with the kick.
    if (step.v > 0 && !(sec === "break" && step.v < 0.5)) {
      // Ghosts and octave hits don't move the line; real hits wander, fond of chord tones.
      if (step.v >= 0.5 && !step.o) {
        const roll = r();
        if (roll < 0.5) bass.degree += r() < 0.5 ? 1 : -1;
        else if (roll < 0.85) {
          const tones = chordTones().map((d) => d - 7).sort((a, b) => Math.abs(a - bass.degree) - Math.abs(b - bass.degree));
          bass.degree = tones[0]!;
        }
        if (bass.degree < -10) bass.degree += 7;
        if (bass.degree > -2) bass.degree -= 7;
        if (i % 16 === 0) bass.degree = song.chord - 7;
      }
      const deg = step.o ? bass.degree + 7 : bass.degree;
      playBass(freq(deg, 4), t, step.v, step.len * eighth, !!step.s);
    }
    // The drum bed: four on the floor keys both sidechains; clap on two and four; hats on the swung
    // off-beats, open on the last; a shaker on the sixteenths in between, quiet.
    if (inBar % 2 === 0) {
      if (kicks) {
        kick(t, inBar === 0 || sec === "finale" ? 1 : 0.85);
        if (duck) {
          duck.gain.cancelScheduledValues(t);
          duck.gain.setValueAtTime(0.45, t);
          duck.gain.linearRampToValueAtTime(1.0, t + beat() * 0.55);
        }
        if (bassDuck) {
          bassDuck.gain.cancelScheduledValues(t);
          bassDuck.gain.setValueAtTime(0.62, t);
          bassDuck.gain.linearRampToValueAtTime(1.0, t + beat() * 0.4);
        }
        if ((inBar === 2 || inBar === 6) && sec !== "build") clap(t);
      }
      // The break: an open hat washes each beat instead of the kick.
      if (sec === "break") hat(t, 0.45, true);
    } else hat(t, inBar === 7 ? 0.8 : 0.5, inBar === 7 && sec !== "intro");
    // Build and finale: hats on every eighth, and in the finale on the sixteenths too.
    if (sec === "build" || sec === "finale") {
      if (inBar % 2 === 0) hat(t, 0.4, false);
      if (sec === "finale") hat(t + eighth * 0.5, 0.3, false);
    }
    // The last two bars before the bell: the clap rolls in on every eighth, louder each one.
    if (sec === "finale" && arc.total - gt < beat() * 8 && arc.total - gt > 0) clap(t, 0.5 + 0.5 * (1 - (arc.total - gt) / (beat() * 8)));
    shaker(t + eighth * 0.5 + (inBar % 2 === 0 ? eighth * song.swing * 0.5 : 0), sec === "intro" ? 0.35 : 0.5);
    // The disco filter: a sweep across four bars on the pad and the bass tone. Open in the break,
    // and opening further through the finale.
    const phase = (i % 32) / 32;
    const sweep = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    const lift = sec === "break" ? 1400 : sec === "finale" ? 600 * (1 - Math.max(0, arc.total - gt) / 30) : 0;
    if (padFilter) padFilter.frequency.setTargetAtTime((700 + 900 * sweep + lift) * (1 - ducked * 0.6), t, 0.12);
    if (bassTone) bassTone.frequency.setTargetAtTime(700 + 1100 * sweep, t, 0.12);
    // Threat: a low pulse on the root every eighth, harder as it gets closer.
    if (threat > 0.12) playPulse(freq(0, 2), t, threat, inBar % 2 === 0);
    nextEighth += eighth;
    eighthIndex++;
  }
}

function playChord(t: number, attack = 0.9): void {
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
    g.gain.setTargetAtTime(gain * (1 - ducked * 0.6), t, attack);
    o.connect(g).connect(padFilter!);
    o.start(t);
    padVoices.push({ o, g });
  }
}

/** Retrigger a param from wherever it is right now, without a jump. */
function hold(p: AudioParam, t: number): void {
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
  if (anyP.cancelAndHoldAtTime) anyP.cancelAndHoldAtTime(t);
  else {
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
  }
}

/**
 * One note on the mono bass. `slide` glides in without retriggering the amp (legato); otherwise
 * the envelopes retrigger from wherever they are. `len` is when the release starts. The bright
 * pluck and the thumb only come on accents, so the kick keeps the transients and the bass keeps
 * the tone.
 */
function playBass(f: number, t: number, v: number, len: number, slide: boolean): void {
  if (!ctx || !mono) return;
  const style = BASS[song.bass];
  const fund = f / 2;
  const pitches: Array<[OscillatorNode, number]> = [
    [mono.oscs[0]!, fund],
    [mono.oscs[1]!, fund / 2],
    [mono.brightOscs[0]!, fund],
    [mono.brightOscs[1]!, fund],
  ];
  const glide = slide ? 0.07 : style.glide;
  for (const [o, fr] of pitches) {
    hold(o.frequency, t);
    if (slide) o.frequency.setTargetAtTime(fr, t, glide);
    else {
      o.frequency.setTargetAtTime(fr * (1 + style.dip), t, glide);
      o.frequency.setTargetAtTime(fr, t + 0.03, 0.02);
    }
  }
  const accent = v >= 0.95;
  // Filter: opens on the hit (a lot on accents), closes over `bright`.
  hold(mono.vcf.frequency, t);
  mono.vcf.frequency.setTargetAtTime(style.cutoff + style.env * (accent ? 1 : 0.45) * v, t, slide ? 0.03 : 0.002);
  mono.vcf.frequency.setTargetAtTime(style.cutoff, t + 0.01, style.bright * 0.4);
  // Bright layer: only really on accents; a whisper otherwise.
  hold(mono.bright.gain, t);
  mono.bright.gain.setTargetAtTime(accent ? 0.9 : 0.25 * v, t, 0.003);
  mono.bright.gain.setTargetAtTime(0.0001, t + 0.012, style.bright * 0.45);
  // Body: soft attack, holds for `len`, then rings down on its own clock.
  const peak = style.gain * (0.5 + 0.5 * v);
  hold(mono.vca.gain, t);
  if (!slide) mono.vca.gain.setTargetAtTime(peak, t, style.attack);
  else mono.vca.gain.setTargetAtTime(peak, t, 0.03);
  mono.vca.gain.setTargetAtTime(0.0001, t + Math.max(0.03, len), style.ring * 0.25);
  // Thumb on accents only.
  if (style.thumb && accent && bassBus) {
    const c = ctx;
    const n = noise(0.04);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700;
    bp.Q.value = 1.4;
    const tg = c.createGain();
    tg.gain.setValueAtTime(0.0001, t);
    tg.gain.exponentialRampToValueAtTime(0.1 * style.thumb, t + 0.003);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    n.connect(bp).connect(tg).connect(bassBus);
    n.start(t);
  }
}

/** The floor: a soft kick, more felt than heard. */
function kick(t: number, level: number): void {
  if (!ctx || !drumBus) return;
  const c = ctx;
  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.09);
  const g = c.createGain();
  const peak = 0.22 * level;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  o.connect(g).connect(drumBus);
  o.start(t);
  o.stop(t + 0.32);
  const n = noise(0.02);
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 2500;
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.0001, t);
  cg.gain.exponentialRampToValueAtTime(0.03 * level, t + 0.002);
  cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  n.connect(hp).connect(cg).connect(drumBus);
  n.start(t);
}

/** Hats on the swung off-beats: closed and short, or open and let ring. */
function hat(t: number, level: number, open: boolean): void {
  if (!ctx || !drumBus) return;
  const c = ctx;
  const n = noise(open ? 0.35 : 0.06);
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = open ? 6000 : 7000;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.035 * level, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (open ? 0.28 : 0.05));
  n.connect(hp).connect(g).connect(drumBus);
  n.start(t);
}

/** A clap on two and four: three quick bursts, band-limited, into the room. */
function clap(t: number, level = 1): void {
  if (!ctx || !drumBus || !send) return;
  const c = ctx;
  for (let k = 0; k < 3; k++) {
    const at = t + k * 0.011;
    const n = noise(0.2);
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1300;
    bp.Q.value = 0.9;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime((k === 2 ? 0.07 : 0.045) * level, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + (k === 2 ? 0.16 : 0.03));
    n.connect(bp).connect(g);
    g.connect(drumBus);
    if (k === 2) {
      const toVerb = c.createGain();
      toVerb.gain.value = 0.6;
      g.connect(toVerb).connect(send);
    }
    n.start(at);
  }
}

/** A shaker between the eighths, quiet, for the sixteenth pulse. */
function shaker(t: number, level: number): void {
  if (!ctx || !drumBus) return;
  const c = ctx;
  const n = noise(0.04);
  const bp = c.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 9000;
  bp.Q.value = 1.5;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.014 * level, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
  n.connect(bp).connect(g).connect(drumBus);
  n.start(t);
}

/** The threat pulse: a short, dark thud on the root, in the bass chain. */
function playPulse(f: number, t: number, level: number, strong: boolean): void {
  if (!ctx || !drumBus) return;
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
  o.connect(g).connect(drumBus);
  o.start(t);
  o.stop(t + 0.15);
}

// ---------- threat ----------

/** 0..1: how close the nearest thing that can eat me is. Turns the arrangement, not a noise. */
export function soundThreat(level: number): void {
  if (!ctx || !padFilter || stopped) return;
  const t = ctx.currentTime;
  const k = Math.min(1, Math.max(0, level));
  threat = k;
  ducked = k;
  // The pad darkens and thins; the tension tone creeps in a step above the root.
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

/** The lead voice: square + detuned saw + sub sine through a plucked filter and light drive. */
function leadVoice(f: number, t: number, dur: number, peak: number, opts: { bright?: number; glideFrom?: number; vibrato?: number; short?: boolean } = {}): void {
  if (!ctx || !leadBus) return;
  const c = ctx;
  const bright = opts.bright ?? 1;
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.Q.value = 2.2;
  filt.frequency.setValueAtTime(Math.min(3200, f * 5 * bright), t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(240, f * 1.3), t + (opts.short ? 0.12 : 0.4));
  const drive = c.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(x * 1.5) / Math.tanh(1.5);
  }
  drive.curve = curve;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.setTargetAtTime(peak * (opts.short ? 0.3 : 0.6), t + 0.05, opts.short ? 0.06 : 0.2);
  g.gain.setTargetAtTime(0.0001, t + dur, opts.short ? 0.05 : 0.15);
  filt.connect(drive).connect(g).connect(leadBus);
  const layers: Array<[OscillatorType, number, number, number]> = [
    ["square", f, rnd(-3, 3), 0.55],
    ["sawtooth", f, rnd(6, 11), 0.35],
    ["sine", f / 2, 0, 0.5],
  ];
  let vib: OscillatorNode | null = null;
  let vibG: GainNode | null = null;
  if (opts.vibrato) {
    vib = c.createOscillator();
    vib.frequency.value = 5.5;
    vibG = c.createGain();
    vibG.gain.setValueAtTime(0, t);
    vibG.gain.linearRampToValueAtTime(opts.vibrato, t + 0.35);
    vib.connect(vibG);
    vib.start(t);
    vib.stop(t + dur + 0.9);
  }
  for (const [type, fr, det, amp] of layers) {
    const o = c.createOscillator();
    o.type = type;
    if (opts.glideFrom) {
      o.frequency.setValueAtTime(fr * opts.glideFrom, t);
      o.frequency.exponentialRampToValueAtTime(fr, t + 0.06);
    } else o.frequency.value = fr;
    o.detune.value = det;
    if (vibG) vibG.connect(o.detune);
    const lg = c.createGain();
    lg.gain.value = amp;
    o.connect(lg).connect(filt);
    o.start(t);
    o.stop(t + dur + 0.9);
  }
}

/**
 * A short run that lands on `deg`: an approach from below by scale steps, each note gliding into
 * the next, the last held. `steps` is the approach length. Partial licks for the bigger meals.
 */
function miniLick(deg: number, oct: number, steps: number, holdSec: number, peak: number, vibrato: number): void {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const six = beat() / 4;
  const approach = [-7, -5, -4, -2, -1].slice(-steps);
  const run = [...approach, 0];
  run.forEach((rel, i) => {
    const t = t0 + i * six * 0.5;
    const last = i === run.length - 1;
    leadVoice(freq(deg + rel, oct), t, last ? holdSec : six * 0.55, last ? peak : peak * 0.8, { bright: 1.2, glideFrom: i > 0 ? 0.95 : undefined, vibrato: last ? vibrato : 0 });
  });
}

/**
 * One meal, one note of the current motif. Small meals are the melody itself, note for note.
 * Bigger meals arrive with a run-up that lands on that same note, longer as the meal grows, so
 * the phrase stays in the song and the size is still heard:
 *   speck, morsel (< 4):  the note.
 *   meal   (4–12):        a three-note run into the note.
 *   prize  (12+):         a five-note run, the note held with vibrato, and a sub thump.
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
  const t = now;
  if (mass < 4) {
    leadVoice(freq(deg, 3), t, 0.45 + mass * 0.06, 0.08 + mass * 0.005, {});
    return;
  }
  if (mass < 12) {
    miniLick(deg, 3, 3, 0.9, 0.11, 0);
    return;
  }
  miniLick(deg, 3, 5, 1.6, 0.13, 22);
  if (dry) {
    const sub = c.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(freq(song.chord, 2) * 1.4, t);
    sub.frequency.exponentialRampToValueAtTime(freq(song.chord, 1), t + 0.25);
    const sg = c.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.26, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    sub.connect(sg).connect(dry);
    sub.start(t);
    sub.stop(t + 0.7);
  }
}

/**
 * Absorbing a rival: the lick. A fast run up the scale from the chord root with slides between
 * notes, a turn at the top, and a long held note with vibrato. The floor drops out under it and
 * a crash opens over it. The Freebird moment.
 */
export function soundLick(): void {
  if (!ctx || !leadBus) return;
  const c = ctx;
  const t0 = c.currentTime;
  const six = beat() / 4;
  // Degrees relative to the chord root: a run up two octaves, a turn, and the held top.
  const run = [0, 2, 4, 7, 9, 11, 14, 16, 14, 16, 18, 16, 14, 16];
  run.forEach((rel, i) => {
    const t = t0 + i * six * 0.5;
    const f = freq(song.chord + rel, 2);
    const last = i === run.length - 1;
    const glideFrom = i > 0 && i % 3 === 0 ? 0.94 : undefined;
    leadVoice(f, t, last ? 2.4 : six * 0.55, last ? 0.16 : 0.12, { bright: 1.25, glideFrom, vibrato: last ? 28 : 0 });
  });
  // Under it: the sidechain stays open, the pad lifts, and a long open hat washes over.
  if (duck) {
    hold(duck.gain, t0);
    duck.gain.setTargetAtTime(1, t0, 0.02);
    duck.gain.setValueAtTime(1, t0 + run.length * six * 0.5 + 2.4);
  }
  if (drumBus) {
    const n = noise(1.6);
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5000;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.5);
    n.connect(hp).connect(g).connect(drumBus);
    if (send) {
      const toVerb = c.createGain();
      toVerb.gain.value = 0.7;
      g.connect(toVerb).connect(send);
    }
    n.start(t0);
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
  body.connect(drive).connect(bg).connect(drumBus ?? dry);
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
  click.connect(hp).connect(cg).connect(drumBus ?? dry);
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

/** Fade the whole song to silence, starting `after` seconds from now, over `seconds`. */
export function soundFade(after: number, seconds: number): void {
  if (!ctx || !songGain) return;
  const t = ctx.currentTime + after;
  hold(songGain.gain, ctx.currentTime);
  songGain.gain.setValueAtTime(1, t);
  songGain.gain.linearRampToValueAtTime(0.0001, t + seconds);
}

/** Every long-lived oscillator, so the tape can slow them together. */
function tapeVoices(): OscillatorNode[] {
  const out: OscillatorNode[] = padVoices.map((v) => v.o);
  if (mono) out.push(...mono.oscs, ...mono.brightOscs);
  if (tension) out.push(tension.o);
  return out;
}

/**
 * Absorbed: the tape stops. The clock halts, every voice slides down two and a half octaves over
 * a second and a half while the mix darkens, then a sub boom lands and a slow chord in the sky's
 * key blooms out into the room and hangs there.
 */
export function soundLost(): void {
  if (!ctx || !dry || !send || !masterTone || !padFilter) return;
  const c = ctx;
  const t = c.currentTime;
  stopped = true;
  const slow = 1.5;
  // 1. Undo the threat's ducking and darkening, right now, so the strike is heard in full.
  threat = 0;
  ducked = 0;
  if (duck) {
    hold(duck.gain, t);
    duck.gain.setTargetAtTime(1, t, 0.02);
  }
  if (bassDuck) {
    hold(bassDuck.gain, t);
    bassDuck.gain.setTargetAtTime(1, t, 0.02);
  }
  hold(padFilter.frequency, t);
  padFilter.frequency.setTargetAtTime(1500, t, 0.02);
  if (tension) tension.g.gain.setTargetAtTime(0.0001, t, 0.2);
  // 2. Strike: whatever pad was sounding stays, the chord is struck again fast and full, and a
  //    root bass note lands. Nothing below touches these params again before they've sounded.
  const wasSounding = tapeVoices();
  for (const v of padVoices) {
    hold(v.g.gain, t);
    v.g.gain.setTargetAtTime(0.03, t, 0.02);
  }
  playChord(t, 0.03);
  for (const v of padVoices) {
    v.g.gain.cancelScheduledValues(t + 0.001);
    v.g.gain.setTargetAtTime(0.045, t, 0.03);
    v.g.gain.setTargetAtTime(0.0001, t + slow * 0.8, 0.4);
  }
  playBass(freq(song.chord - 7, 4), t, 1, slow * 0.9, false);
  if (mono) mono.vca.gain.setTargetAtTime(0.0001, t + slow * 0.9, 0.3);
  // The grab: a knock as the tape catches.
  const grab = noise(0.12);
  const grabBp = c.createBiquadFilter();
  grabBp.type = "bandpass";
  grabBp.frequency.value = 900;
  grabBp.Q.value = 0.7;
  const grabG = c.createGain();
  grabG.gain.setValueAtTime(0.0001, t);
  grabG.gain.exponentialRampToValueAtTime(0.14, t + 0.004);
  grabG.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  grab.connect(grabBp).connect(grabG).connect(dry);
  grab.start(t);
  // 3. The tape slows: every voice, old and new, slides down together; the mix darkens.
  const voices = new Set<OscillatorNode>([...wasSounding, ...tapeVoices()]);
  for (const o of voices) {
    hold(o.detune, t);
    o.detune.linearRampToValueAtTime(o.detune.value - 3000, t + slow);
  }
  if (leadDelay) {
    hold(leadDelay.delayTime, t);
    leadDelay.delayTime.linearRampToValueAtTime(Math.min(1.9, beat() * 0.75 * 2.5), t + slow);
  }
  hold(masterTone.frequency, t);
  masterTone.frequency.setValueAtTime(20000, t);
  masterTone.frequency.exponentialRampToValueAtTime(220, t + slow);
  // 4. The boom: a sub that starts at the root and sinks, with a little saturation.
  const boomAt = t + slow;
  const o = c.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(freq(0, 2), boomAt);
  o.frequency.exponentialRampToValueAtTime(freq(0, 2) * 0.45, boomAt + 2.4);
  const shaper = c.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * 2 - 1;
    curve[i] = Math.tanh(x * 2.5) / Math.tanh(2.5);
  }
  shaper.curve = curve;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, boomAt);
  g.gain.exponentialRampToValueAtTime(0.5, boomAt + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, boomAt + 2.8);
  o.connect(shaper).connect(g).connect(dry);
  const boomVerb = c.createGain();
  boomVerb.gain.value = 0.5;
  g.connect(boomVerb).connect(send);
  o.start(boomAt);
  o.stop(boomAt + 3);
  // 5. The chord: the mode's i chord with its sixth, voiced low and slow, blooming after the boom.
  masterTone.frequency.setTargetAtTime(20000, boomAt + 0.3, 0.8);
  const dryBus = dry;
  const sendBus = send;
  const voicing: Array<[number, number, number]> = [
    [0, 3, 0.11],
    [2, 3, 0.07],
    [4, 3, 0.08],
    [5, 4, 0.05],
    [0, 4, 0.05],
  ];
  voicing.forEach(([deg, oct, gain], i) => {
    const at = boomAt + 0.35 + i * 0.09;
    const v = c.createOscillator();
    v.type = i === 3 ? "triangle" : "sawtooth";
    v.frequency.value = freq(deg, oct);
    v.detune.value = rnd(-8, 8);
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(260, at);
    lp.frequency.exponentialRampToValueAtTime(1600, at + 3.5);
    lp.frequency.exponentialRampToValueAtTime(300, at + 9);
    const vg = c.createGain();
    vg.gain.setValueAtTime(0.0001, at);
    vg.gain.exponentialRampToValueAtTime(gain, at + 2.2);
    vg.gain.exponentialRampToValueAtTime(0.0001, at + 10);
    v.connect(lp).connect(vg);
    vg.connect(dryBus);
    const toVerb = c.createGain();
    toVerb.gain.value = 1.1;
    vg.connect(toVerb).connect(sendBus);
    v.start(at);
    v.stop(at + 10.5);
  });
  // 6. And then, eventually, silence: nobody wants a menu loop.
  soundFade(10, 15);
}

/** A new sky: new key, the clock restarts, the pad opens back up. */
export function soundReset(seed: number): string {
  const name = soundKey(seed);
  stopped = false;
  arc.t = 0;
  arc.section = "intro";
  arc.riser = false;
  if (ctx && padFilter) {
    const t = ctx.currentTime;
    if (songGain) {
      hold(songGain.gain, t);
      songGain.gain.setTargetAtTime(1, t, 0.3);
    }
    for (const o of tapeVoices()) {
      hold(o.detune, t);
      o.detune.setTargetAtTime(0, t, 0.05);
    }
    if (mono) {
      mono.brightOscs[1]!.detune.setTargetAtTime(BASS[song.bass].chorus || 0, t, 0.05);
      mono.brightOscs[1]!.detune.value = BASS[song.bass].chorus || 0;
    }
    if (masterTone) {
      hold(masterTone.frequency, t);
      masterTone.frequency.setTargetAtTime(20000, t, 0.2);
    }
    for (const v of padVoices) {
      v.g.gain.setTargetAtTime(0.0001, t, 0.1);
      v.o.stop(t + 1);
    }
    padVoices = [];
    padFilter.frequency.setTargetAtTime(1100, t, 0.8);
    if (leadDelay) leadDelay.delayTime.setTargetAtTime(beat() * 0.75, ctx.currentTime, 0.2);
    startClock();
  }
  return name;
}
