import {
  ORB,
  VOID,
  bodyRadius,
  defaultConfig,
  lumensOf,
  newGame,
  options,
  play,
  reachOf,
  search,
  wellRadius,
  type Config,
  type Ev,
  type Light,
  type Orb,
  type State,
} from "../sim2";

// ---------- config + persistence ----------

const STORAGE_KEY = "lumen2.config.v1";
const LEVEL_KEY = "lumen2.level";

function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultConfig, ...JSON.parse(raw) };
  } catch {}
  return { ...defaultConfig };
}
function saveConfig(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {}
}
const cfg: Config = loadConfig();

/** Difficulty is how far ahead Umbra thinks. */
const LEVELS = [1, 2, 3, 4, 5, 6];
function loadLevel(): number {
  try {
    const n = Number(localStorage.getItem(LEVEL_KEY));
    if (Number.isFinite(n) && n >= 0 && n < LEVELS.length) return n;
  } catch {}
  return 0;
}
let level = loadLevel();
let levelCleared = false;

interface SliderSpec {
  key: keyof Config;
  min: number;
  max: number;
  step: number;
  label: string;
}
const SLIDERS: SliderSpec[] = [
  { key: "G", min: 0, max: 30000, step: 500, label: "gravity" },
  { key: "damping", min: 0.5, max: 0.99, step: 0.01, label: "momentum kept per tick" },
  { key: "impulse", min: 0, max: 8, step: 0.1, label: "landing impulse" },
  { key: "siphon", min: 0, max: 0.5, step: 0.01, label: "siphon rate" },
  { key: "reach", min: 60, max: 600, step: 10, label: "reach at start" },
  { key: "jumpCost", min: 0, max: 3, step: 0.05, label: "jump cost / 100px" },
  { key: "wellGrowth", min: 0, max: 40, step: 1, label: "well growth" },
  { key: "startLumens", min: 1, max: 30, step: 1, label: "start lumens (new game)" },
  { key: "orbCount", min: 6, max: 60, step: 2, label: "orbs (new game)" },
  { key: "maxPly", min: 10, max: 200, step: 2, label: "plies until dark" },
];

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
const elLight = $("light");
const elThem = $("them");
const elClock = $("clock");
const elLevel = $("level");
const elStatus = $("status");
const elHint = $("hint");
const elPanel = $("panel");
const elLog = $("log");
const elHold = $<HTMLButtonElement>("hold");
const elSelfPreview = $<HTMLInputElement>("selfpreview");
const elSprings = $<HTMLInputElement>("springs");

function buildSliders(): void {
  const host = $("sliders");
  host.replaceChildren();
  for (const spec of SLIDERS) {
    const wrap = document.createElement("div");
    wrap.className = "slider";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = spec.label;
    const val = document.createElement("span");
    val.className = "val";
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(cfg[spec.key]);
    const show = () => (val.textContent = String(cfg[spec.key]));
    show();
    input.addEventListener("input", () => {
      (cfg as unknown as Record<string, number>)[spec.key] = Number(input.value);
      show();
      saveConfig();
      previewDirty = true;
    });
    wrap.append(name, val, input);
    host.append(wrap);
  }
}
function log(line: string): void {
  elLog.textContent = (line + "\n" + elLog.textContent).slice(0, 4000);
}

// ---------- view model ----------

interface Sprite {
  id: number;
  kind: number;
  radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  scale: number;
  vscale: number;
  tx: number;
  ty: number;
  tscale: number;
  dying: boolean;
  phase: number;
  /** Sim velocity, for motion streaks. */
  mx: number;
  my: number;
  stored: number;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  home: number | null; // light id
}

const COLOR: Record<number, { core: string; glow: string }> = {
  1: { core: "#e4f0ff", glow: "140,190,255" },
  2: { core: "#ffd28a", glow: "255,170,70" },
  3: { core: "#fff4fb", glow: "255,120,220" },
  4: { core: "#0a0612", glow: "120,60,200" },
};
const LIGHTS = [
  { core: "#f2fbff", glow: "120,230,255" },
  { core: "#fff0f6", glow: "255,110,170" },
];

const SPRING_K = 150;
const SPRING_C = 2 * Math.sqrt(SPRING_K) * 0.5;

let state: State;
let seed = (Math.random() * 0xffffffff) >>> 0;
const sprites = new Map<number, Sprite>();
const lights: Sprite[] = [];
const particles: Particle[] = [];
let shake = 0;
let flash = 0;
let hoverId: number | null = null;
let preview: State | null = null;
let previewDirty = true;
let tapped = false;
let thinking = false;
let endNote = "";

function makeSprite(id: number, kind: number, radius: number, x: number, y: number, fresh: boolean): Sprite {
  return { id, kind, radius, x, y, vx: 0, vy: 0, scale: fresh ? 0 : 1, vscale: 0, tx: x, ty: y, tscale: 1, dying: false, phase: Math.random() * 6.28, mx: 0, my: 0, stored: 0 };
}

function sync(fresh: boolean): void {
  const seen = new Set<number>();
  for (const o of state.orbs) {
    seen.add(o.id);
    let s = sprites.get(o.id);
    if (!s) {
      s = makeSprite(o.id, o.kind, o.radius, o.x, o.y, fresh);
      sprites.set(o.id, s);
    }
    s.tx = o.x;
    s.ty = o.y;
    s.kind = o.kind;
    s.radius = o.radius;
    s.mx = o.vx;
    s.my = o.vy;
    s.stored = o.stored;
    s.dying = false;
  }
  for (const s of sprites.values()) if (!seen.has(s.id)) s.dying = true;
  for (const l of state.lights) {
    let s = lights[l.id];
    if (!s) {
      s = makeSprite(-1 - l.id, 0, bodyRadius(l, cfg), l.x, l.y, false);
      lights[l.id] = s;
    }
    s.tx = l.x;
    s.ty = l.y;
    s.tscale = bodyRadius(l, cfg) / cfg.bodyBase;
    s.dying = !l.alive;
  }
}

function startGame(newSeed: number): void {
  seed = newSeed;
  state = newGame(seed, cfg);
  sprites.clear();
  lights.length = 0;
  particles.length = 0;
  endNote = "";
  levelCleared = false;
  thinking = false;
  sync(true);
  for (const s of sprites.values()) {
    s.x = s.tx;
    s.y = s.ty;
  }
  for (const s of lights) s.scale = s.tscale;
  hoverId = null;
  previewDirty = true;
  updateHud();
  log(`— new game, seed ${seed}, Umbra thinks ${LEVELS[level]} pl${LEVELS[level] === 1 ? "y" : "ies"} ahead`);
}

const fmt = (n: number) => (n < 10 ? Math.max(0, n).toFixed(1) : String(Math.floor(n)));

function updateHud(): void {
  const [me, them] = state.lights;
  elLight.textContent = `${fmt(me.lumens)} lumens`;
  elThem.textContent = `Umbra ${fmt(them.lumens)}`;
  const left = state.orbs.filter((o) => o.kind !== VOID).reduce((a, o) => a + lumensOf(o), 0);
  elClock.textContent = `${Math.max(0, cfg.maxPly - state.ply)} plies left · ${fmt(left)} light on the field`;
  elLevel.textContent = `level ${level + 1} of ${LEVELS.length} · Umbra thinks ${LEVELS[level]} ${LEVELS[level] === 1 ? "ply" : "plies"} ahead`;
  elStatus.textContent = state.status !== "playing" ? "" : thinking ? "Umbra is thinking…" : state.toMove === 0 ? "your move" : "";
  elHold.disabled = state.status !== "playing" || state.toMove !== 0 || thinking;
}

// ---------- effects ----------

function burst(x: number, y: number, glow: string, count: number, home: number | null): void {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 60 + Math.random() * 220;
    particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0, max: 0.5 + Math.random() * 0.6, size: 1.5 + Math.random() * 2.5, color: glow, home });
  }
}

function applyEvents(events: Ev[]): void {
  for (const e of events) {
    switch (e.type) {
      case "jump":
        if (e.who === 0 && e.value) log(`jumped ${Math.round(e.value)}px`);
        break;
      case "absorb": {
        if (e.at) burst(e.at.x, e.at.y, e.who === 0 ? LIGHTS[0]!.glow : LIGHTS[1]!.glow, 14, e.who ?? null);
        const s = lights[e.who ?? 0];
        if (s) s.vscale += 1;
        log(`${e.who === 0 ? "you" : "Umbra"} +${e.value}`);
        break;
      }
      case "fuse":
        if (e.at) burst(e.at.x, e.at.y, e.value && e.value >= 20 ? COLOR[4]!.glow : COLOR[3]!.glow, 24, null);
        shake = Math.max(shake, e.value && e.value >= 20 ? 10 : 4);
        log(`fusion → ${e.value}`);
        break;
      case "swallow":
        if (e.at) burst(e.at.x, e.at.y, COLOR[4]!.glow, 12, null);
        shake = Math.max(shake, 3);
        break;
      case "siphon":
        break;
      case "eliminated":
        shake = 16;
        flash = 1;
        endNote = `${e.who === 0 ? "you were" : "Umbra was"} ${e.note ?? "eliminated"}`;
        log(endNote.toUpperCase());
        break;
      case "over":
        if (e.note) endNote = e.note;
        break;
    }
  }
}

// ---------- turn flow ----------

function afterMove(events: Ev[]): void {
  sync(true);
  applyEvents(events);
  updateHud();
  previewDirty = true;
  if (state.status !== "playing") {
    if (state.winner === 0) {
      flash = 0.6;
      log(`YOU WIN — ${endNote}`);
      if (level < LEVELS.length - 1) {
        levelCleared = true;
        level += 1;
        try {
          localStorage.setItem(LEVEL_KEY, String(level));
        } catch {}
      }
    } else if (state.winner === 1) log(`UMBRA WINS — ${endNote}`);
    else log(`DRAW — ${endNote}`);
    updateHud();
  }
}

function humanMove(targetId: number | null): void {
  if (state.status !== "playing" || state.toMove !== 0 || thinking) return;
  const r = play(state, targetId, cfg);
  if (r.state === state) return;
  state = r.state;
  afterMove(r.events);
  if (!tapped) {
    tapped = true;
    elHint.classList.add("gone");
  }
  if (state.status === "playing" && state.toMove === 1) {
    thinking = true;
    updateHud();
    setTimeout(umbraMove, 650);
  }
}

function umbraMove(): void {
  if (state.status !== "playing" || state.toMove !== 1) {
    thinking = false;
    updateHud();
    return;
  }
  const depth = LEVELS[level]!;
  const t0 = performance.now();
  const m = search(state, depth, cfg).move;
  const r = play(state, m, cfg);
  thinking = false;
  state = r.state;
  afterMove(r.events);
  if (m === null) log("Umbra holds");
  const ms = performance.now() - t0;
  if (ms > 200) log(`(Umbra took ${Math.round(ms)}ms)`);
}

// ---------- input ----------

let view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * dpr);
  canvas.height = Math.round(view.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const pad = 24;
  view.scale = Math.min((view.w - pad * 2) / cfg.width, (view.h - pad * 2) / cfg.height);
  view.ox = (view.w - cfg.width * view.scale) / 2;
  view.oy = (view.h - cfg.height * view.scale) / 2;
}
function toWorld(cx: number, cy: number): { x: number; y: number } {
  return { x: (cx - view.ox) / view.scale, y: (cy - view.oy) / view.scale };
}
function targetAt(p: { x: number; y: number }): Orb | null {
  if (state.status !== "playing" || state.toMove !== 0) return null;
  let best: Orb | null = null;
  let bestD = Infinity;
  for (const o of options(state, cfg)) {
    const d = Math.hypot(o.x - p.x, o.y - p.y) - o.radius;
    if (d < 16 && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

canvas.addEventListener("pointerdown", (ev) => {
  if (state.status !== "playing") {
    startGame((Math.random() * 0xffffffff) >>> 0);
    return;
  }
  const t = targetAt(toWorld(ev.clientX, ev.clientY));
  if (t) humanMove(t.id);
});
canvas.addEventListener("pointermove", (ev) => {
  const t = targetAt(toWorld(ev.clientX, ev.clientY));
  const id = t ? t.id : null;
  canvas.style.cursor = t ? "pointer" : "crosshair";
  if (id !== hoverId) {
    hoverId = id;
    previewDirty = true;
  }
});
canvas.addEventListener("pointerleave", () => {
  hoverId = null;
  preview = null;
});
elHold.addEventListener("click", () => humanMove(null));
window.addEventListener("keydown", (ev) => {
  if (ev.key === " ") {
    ev.preventDefault();
    humanMove(null);
  }
  if (ev.key === "r" || ev.key === "R") startGame((Math.random() * 0xffffffff) >>> 0);
  if (ev.key === "t" || ev.key === "T") elPanel.classList.toggle("hidden");
  if (ev.key === "[" && level > 0) {
    level -= 1;
    startGame((Math.random() * 0xffffffff) >>> 0);
  }
  if (ev.key === "]" && level < LEVELS.length - 1) {
    level += 1;
    startGame((Math.random() * 0xffffffff) >>> 0);
  }
});
$("toggle").addEventListener("click", () => elPanel.classList.add("hidden"));
$("newboard").addEventListener("click", () => startGame((Math.random() * 0xffffffff) >>> 0));
$("replay").addEventListener("click", () => startGame(seed));
$("reset").addEventListener("click", () => {
  Object.assign(cfg, defaultConfig);
  saveConfig();
  buildSliders();
  previewDirty = true;
});
$("copy").addEventListener("click", () => {
  const text = JSON.stringify(cfg, null, 2);
  navigator.clipboard?.writeText(text);
  log("config copied:\n" + text);
});
elSelfPreview.addEventListener("change", () => (previewDirty = true));
window.addEventListener("resize", resize);

// ---------- drawing ----------

function glowCircle(x: number, y: number, r: number, core: string, glow: string, alpha: number, halo: number): void {
  const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * halo);
  g.addColorStop(0, `rgba(${glow},${0.55 * alpha})`);
  g.addColorStop(0.35, `rgba(${glow},${0.18 * alpha})`);
  g.addColorStop(1, `rgba(${glow},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * halo, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = core;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  const h = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x - r * 0.35, y - r * 0.4, r * 0.9);
  h.addColorStop(0, "rgba(255,255,255,0.9)");
  h.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = h;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawWell(l: Light, s: Sprite, mine: boolean, t: number): void {
  if (!l.alive) return;
  const c = LIGHTS[l.id]!;
  const R = wellRadius(l, cfg);
  // Influence: a soft field, brighter toward the centre, with a faint edge.
  const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, R);
  g.addColorStop(0, `rgba(${c.glow},0.16)`);
  g.addColorStop(0.7, `rgba(${c.glow},0.05)`);
  g.addColorStop(1, `rgba(${c.glow},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${c.glow},${0.18 + 0.05 * Math.sin(t * 2 + l.id)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
  ctx.stroke();
  if (mine && state.status === "playing") {
    ctx.strokeStyle = `rgba(${c.glow},0.12)`;
    ctx.setLineDash([3, 7]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, reachOf(l, cfg), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawSiphon(t: number): void {
  const [a, b] = state.lights;
  if (!a.alive || !b.alive) return;
  const sa = lights[0]!;
  const sb = lights[1]!;
  const d = Math.hypot(sa.x - sb.x, sa.y - sb.y);
  const overlap = wellRadius(a, cfg) + wellRadius(b, cfg) - d;
  if (overlap <= 0) return;
  const [big, small] = a.lumens >= b.lumens ? [sa, sb] : [sb, sa];
  const bigLight = a.lumens >= b.lumens ? a : b;
  const c = LIGHTS[bigLight.id]!;
  ctx.strokeStyle = `rgba(${c.glow},0.35)`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(small.x, small.y);
  ctx.lineTo(big.x, big.y);
  ctx.stroke();
  // Beads flowing from the smaller light to the larger.
  for (let i = 0; i < 6; i++) {
    const k = ((t * 0.6 + i / 6) % 1);
    const x = small.x + (big.x - small.x) * k;
    const y = small.y + (big.y - small.y) * k;
    ctx.fillStyle = `rgba(${c.glow},${0.9 * (1 - k)})`;
    ctx.beginPath();
    ctx.arc(x, y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawOrb(s: Sprite, t: number, heavier: boolean): void {
  const r = s.radius * s.scale * (1 + 0.03 * Math.sin(t * 2 + s.phase));
  if (r <= 0.1) return;
  const c = COLOR[s.kind]!;
  // Motion streak: where it came from.
  const speed = Math.hypot(s.mx, s.my);
  if (speed > 0.6 && !s.dying) {
    const len = Math.min(60, speed * 6);
    const g = ctx.createLinearGradient(s.x - (s.mx / speed) * len, s.y - (s.my / speed) * len, s.x, s.y);
    g.addColorStop(0, `rgba(${c.glow},0)`);
    g.addColorStop(1, `rgba(${c.glow},0.45)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1, r * 0.6);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s.x - (s.mx / speed) * len, s.y - (s.my / speed) * len);
    ctx.lineTo(s.x, s.y);
    ctx.stroke();
  }
  if (s.kind === VOID) {
    const g = ctx.createRadialGradient(s.x, s.y, r * 0.8, s.x, s.y, r * 3);
    g.addColorStop(0, `rgba(${c.glow},0.5)`);
    g.addColorStop(1, `rgba(${c.glow},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c.core;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${c.glow},0.9)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 1.04, 0, Math.PI * 2);
    ctx.stroke();
  } else glowCircle(s.x, s.y, r, c.core, c.glow, 1, s.kind === 3 ? 4 : 3);
  const value = s.kind === VOID ? s.stored : ORB[s.kind as 1 | 2 | 3].value;
  if (value >= 3) {
    ctx.font = `bold ${Math.max(9, r * 0.9)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = s.kind === VOID ? `rgba(${c.glow},0.95)` : "rgba(40,30,20,0.85)";
    ctx.fillText(String(value), s.x, s.y + 0.5);
    ctx.textBaseline = "alphabetic";
  }
  if (heavier && !s.dying) {
    ctx.strokeStyle = `rgba(255,70,100,${0.55 + 0.3 * Math.sin(t * 5 + s.phase)})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawLight(l: Light, s: Sprite, t: number): void {
  const r = cfg.bodyBase * s.scale;
  if (r <= 0.1) return;
  const c = LIGHTS[l.id]!;
  glowCircle(s.x, s.y, r, c.core, c.glow, 1, 3.5);
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(${c.glow},0.9)`;
  ctx.fillText(l.id === 0 ? fmt(l.lumens) : `${l.name} ${fmt(l.lumens)}`, s.x, s.y + r + 14);
}

function drawPreview(): void {
  if (!preview || !elSelfPreview.checked || state.status !== "playing" || hoverId === null) return;
  const before = new Map(state.orbs.map((o) => [o.id, o]));
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.lineWidth = 1;
  for (const o of preview.orbs) {
    const b = before.get(o.id);
    if (b && Math.hypot(b.x - o.x, b.y - o.y) > 0.5) {
      ctx.strokeStyle = "rgba(160,190,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(o.x, o.y);
      ctx.stroke();
    }
    const c = COLOR[o.kind]!;
    ctx.strokeStyle = b ? `rgba(${c.glow},0.5)` : "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const me = preview.lights[0];
  const target = state.orbs.find((o) => o.id === hoverId);
  if (target) {
    // Where I land, my well after the move, and the net lumens.
    ctx.strokeStyle = `rgba(${LIGHTS[0]!.glow},0.35)`;
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.arc(me.x, me.y, wellRadius(me, cfg), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const net = me.lumens - state.lights[0].lumens;
    const dead = preview.status === "over" && preview.winner !== 0;
    ctx.font = "13px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = dead ? "rgba(255,80,110,1)" : net < 0 ? "rgba(255,170,120,0.95)" : "rgba(220,235,255,0.9)";
    ctx.fillText(dead ? "DEATH" : `${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(1)}`, target.x, target.y - target.radius - 12);
  }
  ctx.restore();
}

function drawHover(): void {
  if (hoverId === null || state.status !== "playing") return;
  const s = sprites.get(hoverId);
  if (!s || s.dying) return;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(s.x, s.y, s.radius * s.scale + 10, 0, Math.PI * 2);
  ctx.stroke();
}

// ---------- loop ----------

function springTo(s: Sprite, dt: number, springs: boolean): void {
  if (!springs) {
    s.x = s.tx;
    s.y = s.ty;
    s.scale = s.dying ? 0 : s.tscale;
    return;
  }
  const ax = -SPRING_K * (s.x - s.tx) - SPRING_C * s.vx;
  const ay = -SPRING_K * (s.y - s.ty) - SPRING_C * s.vy;
  s.vx += ax * dt;
  s.vy += ay * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  const target = s.dying ? 0 : s.tscale;
  const as = -SPRING_K * 1.4 * (s.scale - target) - SPRING_C * 1.2 * s.vscale;
  s.vscale += as * dt;
  s.scale += s.vscale * dt;
}

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  const springs = elSprings.checked;

  if (previewDirty) {
    previewDirty = false;
    preview = hoverId !== null && state.status === "playing" && state.toMove === 0 ? play(state, hoverId, cfg).state : null;
  }

  for (const s of sprites.values()) {
    springTo(s, dt, springs);
    if (s.dying && s.scale < 0.03 && Math.abs(s.vscale) < 0.5) sprites.delete(s.id);
  }
  for (const s of lights) springTo(s, dt, springs);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life += dt;
    if (p.life >= p.max) {
      particles.splice(i, 1);
      continue;
    }
    const home = p.home === null ? undefined : lights[p.home];
    if (home) {
      const k = p.life / p.max;
      p.vx += (home.x - p.x) * 180 * k * dt;
      p.vy += (home.y - p.y) * 180 * k * dt;
    }
    p.vx *= 1 - 2.5 * dt;
    p.vy *= 1 - 2.5 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  shake *= 1 - 8 * dt;
  flash *= 1 - 3 * dt;

  ctx.clearRect(0, 0, view.w, view.h);
  ctx.save();
  ctx.translate(view.ox + (Math.random() - 0.5) * shake, view.oy + (Math.random() - 0.5) * shake);
  ctx.scale(view.scale, view.scale);
  ctx.strokeStyle = "rgba(90,110,160,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cfg.width - 1, cfg.height - 1);

  ctx.globalCompositeOperation = "lighter";
  for (const l of state.lights) if (lights[l.id]) drawWell(l, lights[l.id]!, l.id === 0, t);
  drawSiphon(t);
  drawPreview();
  const mine = state.lights[0].lumens;
  for (const s of sprites.values()) drawOrb(s, t, (s.kind === VOID ? s.stored : ORB[s.kind as 1 | 2 | 3].value) > mine);
  for (const l of state.lights) if (lights[l.id] && l.alive) drawLight(l, lights[l.id]!, t);
  drawHover();
  for (const p of particles) {
    const a = 1 - p.life / p.max;
    ctx.fillStyle = `rgba(${p.color},${a * 0.9})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  if (state.status !== "playing") {
    const won = state.winner === 0;
    ctx.fillStyle = `rgba(4,3,10,${0.55 + 0.4 * flash})`;
    ctx.fillRect(0, 0, cfg.width, cfg.height);
    ctx.textAlign = "center";
    ctx.fillStyle = won ? "rgba(200,255,220,0.95)" : "rgba(230,235,255,0.95)";
    const title = won ? "you win" : state.winner === 1 ? "Umbra wins" : "a draw";
    ctx.font = "300 54px ui-monospace, Menlo, monospace";
    ctx.fillText(title, cfg.width / 2, cfg.height / 2 - 10);
    ctx.font = "14px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "rgba(150,165,200,0.9)";
    ctx.fillText(`${endNote} · ${fmt(state.lights[0].lumens)} to ${fmt(state.lights[1].lumens)} in ${Math.ceil(state.ply / 2)} rounds`, cfg.width / 2, cfg.height / 2 + 26);
    const next = levelCleared ? `level ${level} cleared · tap for level ${level + 1}` : won ? "you cleared the ladder · tap to play again" : `tap to retry level ${level + 1}`;
    ctx.fillText(next, cfg.width / 2, cfg.height / 2 + 50);
  }
  ctx.restore();
  requestAnimationFrame(frame);
}

buildSliders();
resize();
startGame(seed);
requestAnimationFrame(frame);
