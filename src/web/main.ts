import {
  GUST,
  ORB,
  VOID,
  lumens,
  defaultConfig,
  effectiveSpeed,
  human,
  newGame,
  randomSeed,
  reach,
  round,
  spawnRate,
  type GameState,
  type Orb,
  type OrbKind,
  type Player,
  type RoundResult,
  type SimConfig,
  type SimEvent,
} from "../sim";

// ---------- config + persistence ----------

const STORAGE_KEY = "lumen.config.v3";

function loadConfig(): SimConfig {
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

const cfg: SimConfig = loadConfig();

interface SliderSpec {
  key: keyof SimConfig;
  min: number;
  max: number;
  step: number;
  label: string;
}

const SLIDERS: SliderSpec[] = [
  { key: "opponents", min: 0, max: 6, step: 1, label: "opponents (new board)" },
  { key: "maxJump", min: 0, max: 800, step: 10, label: "reach at base size px (0=∞)" },
  { key: "gustChance", min: 0, max: 0.5, step: 0.01, label: "gust chance" },
  { key: "gustBoost", min: 0, max: 1, step: 0.05, label: "gust speed boost" },
  { key: "strength", min: 0, max: 300, step: 1, label: "strength (px at 0)" },
  { key: "falloff", min: 20, max: 800, step: 5, label: "falloff (half-pull dist)" },
  { key: "maxTravel", min: 10, max: 400, step: 5, label: "max travel" },
  { key: "drift", min: 0, max: 1, step: 0.01, label: "drift (momentum)" },
  { key: "inertia", min: 0, max: 1.5, step: 0.05, label: "inertia (heavy orbs move less)" },
  { key: "playerDrag", min: 0, max: 1, step: 0.05, label: "player drag" },
  { key: "playerPull", min: 0, max: 3, step: 0.05, label: "player pull / 10px" },
  { key: "voidPull", min: 0, max: 3, step: 0.05, label: "void pull" },
  { key: "spawnPerTurn", min: 0, max: 5, step: 0.25, label: "spawn per round (at start)" },
  { key: "spawnFade", min: 0, max: 200, step: 5, label: "spawn fades out by round (0=never)" },
  { key: "initialOrbs", min: 4, max: 40, step: 1, label: "initial orbs (new board)" },
  { key: "playerGrowth", min: 0, max: 5, step: 0.1, label: "player growth" },
  { key: "travelCost", min: 0, max: 5, step: 0.05, label: "travel cost / 100px" },
  { key: "voidAppetite", min: 0, max: 6, step: 0.25, label: "void appetite (growth)" },
  { key: "startLight", min: 0, max: 50, step: 1, label: "start light (new board)" },
];

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
const elScore = $("score");
const elLight = $("light");
const elTurn = $("turn");
const elOrbs = $("orbs");
const elSeed = $("seed");
const elRivals = $("rivals");
const elHint = $("hint");
const elPanel = $("panel");
const elLog = $("log");
const elPreview = $<HTMLInputElement>("preview");
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
  kind: OrbKind;
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
  alpha: number;
  dying: boolean;
  swallowed: number;
  stored: number;
  /** Per-sprite phase for idle breathing. */
  phase: number;
  /** Players only. */
  name: string;
  light: number;
  ai: boolean;
  speed: number;
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
  /** Player id to home toward, or null. */
  home: number | null;
}

const COLOR: Record<OrbKind, { core: string; glow: string }> = {
  0: { core: "#c9d6ee", glow: "120,150,210" },
  1: { core: "#e4f0ff", glow: "140,190,255" },
  2: { core: "#ffd28a", glow: "255,170,70" },
  3: { core: "#fff4fb", glow: "255,120,220" },
  4: { core: "#0a0612", glow: "120,60,200" },
  5: { core: "#eafff0", glow: "110,255,160" },
};
const HUMAN = { core: "#f2fbff", glow: "120,230,255" };
const RIVALS = [
  { core: "#fff0f6", glow: "255,110,170" },
  { core: "#f0fff4", glow: "120,255,170" },
  { core: "#fff8ec", glow: "255,200,90" },
  { core: "#f6f0ff", glow: "190,140,255" },
  { core: "#fffbe8", glow: "240,240,120" },
  { core: "#eefaff", glow: "90,200,230" },
];

function playerColor(p: { id: number; ai: boolean }): { core: string; glow: string } {
  if (!p.ai) return HUMAN;
  return RIVALS[(-p.id - 2) % RIVALS.length]!;
}

const SPRING_K = 150;
const SPRING_ZETA = 0.5; // < 1 → overshoot
const SPRING_C = 2 * Math.sqrt(SPRING_K) * SPRING_ZETA;

let state: GameState;
let seed = randomSeed();
const sprites = new Map<number, Sprite>();
const players = new Map<number, Sprite>();
const particles: Particle[] = [];
let shake = 0;
let flash = 0;
let endReason = "";
let endBy = "";
let hoverId: number | null = null;
let preview: RoundResult | null = null;
let previewDirty = true;
let tapped = false;

function makeSprite(o: Orb, fresh: boolean): Sprite {
  return {
    id: o.id,
    kind: o.kind,
    radius: o.radius,
    x: o.x,
    y: o.y,
    vx: 0,
    vy: 0,
    scale: fresh ? 0 : 1,
    vscale: 0,
    tx: o.x,
    ty: o.y,
    tscale: 1,
    alpha: 1,
    dying: false,
    swallowed: o.swallowed,
    stored: o.stored,
    phase: Math.random() * Math.PI * 2,
    name: "",
    light: 0,
    ai: false,
    speed: 1,
  };
}

function makePlayerSprite(p: Player): Sprite {
  const s = makeSprite({ id: p.id, kind: 1, radius: p.radius, x: p.x, y: p.y, dx: 0, dy: 0, swallowed: 0, stored: 0 }, false);
  s.speed = p.speed;
  s.name = p.name;
  s.light = p.light;
  s.ai = p.ai;
  s.tscale = p.radius / cfg.playerBaseRadius;
  s.scale = s.tscale;
  return s;
}

function syncSprites(fresh: boolean): void {
  const seen = new Set<number>();
  for (const o of state.orbs) {
    seen.add(o.id);
    let s = sprites.get(o.id);
    if (!s) {
      s = makeSprite(o, fresh);
      sprites.set(o.id, s);
    }
    s.tx = o.x;
    s.ty = o.y;
    s.kind = o.kind;
    s.radius = o.radius;
    s.swallowed = o.swallowed;
    s.stored = o.stored;
    s.dying = false;
  }
  for (const s of sprites.values()) if (!seen.has(s.id)) s.dying = true;
  for (const p of state.players) {
    let s = players.get(p.id);
    if (!s) {
      s = makePlayerSprite(p);
      players.set(p.id, s);
    }
    s.tx = p.x;
    s.ty = p.y;
    s.radius = p.radius;
    s.light = p.light;
    s.speed = p.speed;
    s.tscale = p.radius / cfg.playerBaseRadius;
    s.dying = !p.alive;
  }
}

function startGame(newSeed: number): void {
  seed = newSeed;
  state = newGame(seed, cfg);
  sprites.clear();
  players.clear();
  particles.length = 0;
  endReason = "";
  endBy = "";
  syncSprites(true);
  // Snap everything into place on a new board.
  for (const s of sprites.values()) {
    s.x = s.tx;
    s.y = s.ty;
  }
  previewDirty = true;
  hoverId = null;
  updateHud();
  log(`— new universe, seed ${seed}, ${cfg.opponents} opponent${cfg.opponents === 1 ? "" : "s"}`);
}

function updateHud(): void {
  const me = human(state);
  const shown = me.light < 10 ? Math.max(0, me.light).toFixed(1) : String(Math.floor(me.light));
  elLight.textContent = `${shown} lumens`;
  elScore.textContent = `score ${me.score}`;
  elTurn.textContent = `round ${state.turn} · speed ${effectiveSpeed(me, cfg).toFixed(2)}`;
  const rate = spawnRate(state.turn, cfg);
  elOrbs.textContent = `${state.orbs.length} orbs · ${rate > 0 ? `+${rate.toFixed(1)}/round` : "no more light"}`;
  elSeed.textContent = String(seed);
  const rivals = state.players.filter((p) => p.ai);
  elRivals.replaceChildren();
  for (const p of rivals) {
    const span = document.createElement("span");
    span.textContent = p.alive ? `${p.name} ${p.light < 10 ? Math.max(0, p.light).toFixed(1) : Math.floor(p.light)}` : `${p.name} ✕`;
    span.style.color = p.alive ? `rgb(${playerColor(p).glow})` : "";
    span.style.opacity = p.alive ? "0.9" : "0.4";
    span.style.marginRight = "12px";
    elRivals.append(span);
  }
}

// ---------- effects ----------

function burst(x: number, y: number, glow: string, count: number, home: number | null): void {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 60 + Math.random() * 220;
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0,
      max: 0.5 + Math.random() * 0.6,
      size: 1.5 + Math.random() * 2.5,
      color: glow,
      home,
    });
  }
}

const who = (id: number): string => state.players.find((p) => p.id === id)?.name ?? "?";

function applyEvents(events: SimEvent[]): void {
  const me = human(state).id;
  for (const e of events) {
    switch (e.type) {
      case "travel":
        if (e.actor === me && e.cost > 0) log(`−${e.cost.toFixed(1)} light for ${Math.round(e.dist)}px`);
        break;
      case "collect": {
        burst(e.orb.x, e.orb.y, COLOR[e.orb.kind].glow, e.by === "tap" ? 18 : 10, e.actor);
        const s = players.get(e.actor);
        if (s) s.vscale += 1.2;
        if (e.actor === me) log(`+${e.value} ${ORB[e.orb.kind].name}${e.by === "overlap" ? " (pulled in)" : ""}`);
        else log(`${who(e.actor)} took a ${ORB[e.orb.kind].name}`);
        break;
      }
      case "fuse": {
        burst(e.result.x, e.result.y, COLOR[e.result.kind].glow, 26, null);
        shake = Math.max(shake, e.result.kind === VOID ? 10 : 4);
        log(`${ORB[e.a.kind].name} + ${ORB[e.b.kind].name} → ${ORB[e.result.kind].name}`);
        const s = sprites.get(e.result.id);
        if (s) {
          s.x = (e.a.x + e.b.x) / 2;
          s.y = (e.a.y + e.b.y) / 2;
          s.scale = 0.4;
          s.vscale = 4;
        }
        break;
      }
      case "swallow":
        burst(e.orb.x, e.orb.y, COLOR[e.orb.kind].glow, 12, null);
        shake = Math.max(shake, 3);
        log(`void swallowed a ${ORB[e.orb.kind].name} (holds ${e.void_.stored}, r${e.void_.radius.toFixed(0)})`);
        break;
      case "merge":
        burst(e.result.x, e.result.y, COLOR[VOID].glow, 30, null);
        shake = Math.max(shake, 8);
        log(`two voids merged (holds ${e.result.stored}, r${e.result.radius.toFixed(0)})`);
        break;
      case "eat": {
        burst(e.prey.x, e.prey.y, playerColor(e.prey).glow, 40, e.predator.id);
        shake = Math.max(shake, 12);
        const s = players.get(e.predator.id);
        if (s) s.vscale += 2.5;
        log(`${who(e.predator.id)} absorbed ${who(e.prey.id)} (+${e.value.toFixed(0)})`);
        break;
      }
      case "eliminate":
        if (e.player.ai && e.reason !== "eaten") log(`${e.player.name} ${e.reason}`);
        break;
      case "miss": {
        burst(e.at.x, e.at.y, "150,150,170", 8, null);
        log(e.actor === me ? "too slow — it was already taken" : `${who(e.actor)} arrived too late`);
        break;
      }
      case "boost":
        log(`${e.actor === me ? "speed" : `${who(e.actor)} speed`} → ${e.speed.toFixed(2)}`);
        break;
      case "draw":
        endReason = "draw";
        flash = 0.5;
        shake = 6;
        log(`DRAW — ${e.a.name} and ${e.b.name} met as equals`);
        break;
      case "blackout":
        endReason = e.reason;
        endBy = e.byPlayer ? e.byPlayer.name : e.by ? `${ORB[e.by.kind].name} (${lumens(e.by)} lumens)` : "";
        shake = e.reason === "absorbed" || e.reason === "eaten" ? 16 : 4;
        flash = e.reason === "absorbed" || e.reason === "eaten" ? 1 : 0.3;
        burst(e.at.x, e.at.y, e.byPlayer ? playerColor(e.byPlayer).glow : COLOR[e.by?.kind ?? VOID].glow, 60, null);
        log(`${e.reason.toUpperCase()}${endBy ? ` by ${endBy}` : ""} — score ${human(state).score}`);
        break;
      case "win":
        endReason = "won";
        flash = 0.6;
        shake = 6;
        log(`YOU ABSORBED THEM ALL — score ${human(state).score}`);
        break;
      case "spawn":
      case "separate":
        break;
    }
  }
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

function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  return { x: (clientX - view.ox) / view.scale, y: (clientY - view.oy) / view.scale };
}

type Tappable = { id: number; x: number; y: number; radius: number };

/** Nearest orb under the pointer, or an opponent you outweigh. */
function targetAt(p: { x: number; y: number }): Tappable | null {
  let best: Tappable | null = null;
  let bestD = Infinity;
  const me = human(state);
  const candidates: Tappable[] = [...state.orbs, ...state.players.filter((q) => q.alive && q.ai && q.light < me.light)];
  for (const o of candidates) {
    const d = Math.hypot(o.x - p.x, o.y - p.y) - o.radius;
    if (d < 16 && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

function tap(id: number): void {
  const result = round(state, id, cfg);
  if (result.state === state) return;
  state = result.state;
  syncSprites(true);
  for (const t of result.turns) applyEvents(t.events);
  updateHud();
  previewDirty = true;
  if (!tapped) {
    tapped = true;
    elHint.classList.add("gone");
  }
}

canvas.addEventListener("pointerdown", (ev) => {
  if (state.status !== "playing") {
    startGame(randomSeed());
    return;
  }
  const t = targetAt(toWorld(ev.clientX, ev.clientY));
  if (t) tap(t.id);
});

canvas.addEventListener("pointermove", (ev) => {
  const t = targetAt(toWorld(ev.clientX, ev.clientY));
  const id = t ? t.id : null;
  if (id !== hoverId) {
    hoverId = id;
    previewDirty = true;
  }
});

canvas.addEventListener("pointerleave", () => {
  hoverId = null;
  preview = null;
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "r" || ev.key === "R") startGame(randomSeed());
  if (ev.key === "t" || ev.key === "T") elPanel.classList.toggle("hidden");
});

$("toggle").addEventListener("click", () => elPanel.classList.add("hidden"));
$("newboard").addEventListener("click", () => startGame(randomSeed()));
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

  // Specular highlight for a hint of volume.
  const h = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, 0, x - r * 0.35, y - r * 0.4, r * 0.9);
  h.addColorStop(0, "rgba(255,255,255,0.9)");
  h.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = h;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawVoid(x: number, y: number, r: number, stored: number, alpha: number, t: number): void {
  const glow = COLOR[VOID].glow;
  const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 3.2);
  g.addColorStop(0, `rgba(${glow},${0.5 * alpha})`);
  g.addColorStop(0.4, `rgba(${glow},${0.12 * alpha})`);
  g.addColorStop(1, `rgba(${glow},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = alpha;
  ctx.fillStyle = COLOR[VOID].core;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = `rgba(${glow},0.9)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r * (1.03 + 0.03 * Math.sin(t * 3)), 0, Math.PI * 2);
  ctx.stroke();

  if (stored > 0) {
    ctx.font = `${Math.max(10, r * 0.5)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `rgba(${glow},0.9)`;
    ctx.fillText(String(stored), x, y);
    ctx.textBaseline = "alphabetic";
  }
  ctx.globalAlpha = 1;
}

function threatRing(x: number, y: number, r: number, t: number, phase: number): void {
  ctx.strokeStyle = `rgba(255,70,100,${0.55 + 0.3 * Math.sin(t * 5 + phase)})`;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(x, y, r + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawOrb(s: Sprite, t: number, threat: boolean): void {
  const r = s.radius * s.scale * (1 + 0.03 * Math.sin(t * 2 + s.phase));
  if (r <= 0.1) return;
  if (s.kind === VOID) drawVoid(s.x, s.y, r, s.stored, s.alpha, t);
  else glowCircle(s.x, s.y, r, COLOR[s.kind].core, COLOR[s.kind].glow, s.alpha, s.kind === 3 ? 4 : s.kind === 0 ? 2.2 : 3);
  // Worth, written on anything big enough to carry a number. Gusts get a speed glyph.
  const value = ORB[s.kind].value;
  if (s.kind === GUST || (value >= 3 && s.kind !== VOID)) {
    ctx.font = `bold ${Math.max(9, r * 0.9)}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = s.kind === GUST ? "rgba(20,60,35,0.9)" : "rgba(40,30,20,0.85)";
    ctx.globalAlpha = s.alpha;
    ctx.fillText(s.kind === GUST ? "»" : String(value), s.x, s.y + 0.5);
    ctx.globalAlpha = 1;
    ctx.textBaseline = "alphabetic";
  }
  if (threat && !s.dying) threatRing(s.x, s.y, r, t, s.phase);
}

function drawPlayer(s: Sprite, t: number, threat: boolean): void {
  const r = cfg.playerBaseRadius * s.scale;
  if (r <= 0.1) return;
  const c = playerColor(s);
  glowCircle(s.x, s.y, r, c.core, c.glow, s.alpha, 3.5);
  if (!s.dying) {
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = `rgba(${c.glow},0.85)`;
    const lum = s.light < 10 ? Math.max(0, s.light).toFixed(1) : String(Math.floor(s.light));
    ctx.fillText(s.ai ? `${s.name} ${lum}` : lum, s.x, s.y + r + 14);
  }
  if (threat && !s.dying) threatRing(s.x, s.y, r, t, s.phase);
  else if (s.ai && !s.dying && s.light < human(state).light) {
    // Prey: you outweigh it. Tap to hunt.
    ctx.strokeStyle = `rgba(120,255,170,${0.35 + 0.2 * Math.sin(t * 4 + s.phase)})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawPreview(): void {
  if (!preview || !elPreview.checked || state.status !== "playing") return;
  const next = preview.state;
  const before = new Map(state.orbs.map((o) => [o.id, o]));
  ctx.save();
  ctx.setLineDash([3, 5]);
  ctx.lineWidth = 1;
  for (const o of next.orbs) {
    const b = before.get(o.id);
    if (b && (Math.abs(b.x - o.x) > 0.5 || Math.abs(b.y - o.y) > 0.5)) {
      ctx.strokeStyle = "rgba(160,190,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(o.x, o.y);
      ctx.stroke();
    }
    ctx.strokeStyle = b ? `rgba(${COLOR[o.kind].glow},0.45)` : "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.arc(o.x, o.y, o.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Where every player ends up, including opponents' replies.
  for (const p of next.players) {
    if (!p.alive) continue;
    const c = playerColor(p);
    ctx.strokeStyle = `rgba(${c.glow},0.5)`;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const e of preview.events) {
    if (e.type === "fuse") {
      ctx.strokeStyle = e.result.kind === VOID ? "rgba(255,80,120,0.9)" : `rgba(${COLOR[e.result.kind].glow},0.9)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.result.x, e.result.y, e.result.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.type === "blackout") {
      ctx.strokeStyle = "rgba(255,60,90,0.95)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(e.at.x, e.at.y, 40, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.type === "collect" && e.by === "overlap" && e.actor === human(state).id) {
      ctx.strokeStyle = "rgba(120,230,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.orb.x, e.orb.y, e.orb.radius + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const target = hoverId === null ? null : [...state.orbs, ...state.players].find((o) => o.id === hoverId);
  if (target) {
    const net = human(next).light - human(state).light;
    const dead = preview.events.some((e) => (e.type === "blackout" && e.reason !== "dark") || e.type === "draw");
    const won = preview.events.some((e) => e.type === "win");
    const missed = preview.events.some((e) => e.type === "miss" && e.actor === human(state).id);
    ctx.font = "13px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = dead ? "rgba(255,80,110,1)" : won ? "rgba(120,255,170,1)" : net < 0 ? "rgba(255,170,120,0.95)" : "rgba(220,235,255,0.9)";
    const label = dead ? "DEATH" : won ? "WIN" : missed ? "TOO SLOW" : `${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(1)}`;
    ctx.fillText(label, target.x, target.y - target.radius - 12);
  }
  ctx.restore();
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
    preview = hoverId !== null && state.status === "playing" ? round(state, hoverId, cfg) : null;
  }

  // Integrate.
  for (const s of sprites.values()) {
    springTo(s, dt, springs);
    if (s.dying && s.scale < 0.03 && Math.abs(s.vscale) < 0.5) sprites.delete(s.id);
  }
  for (const s of players.values()) springTo(s, dt, springs);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life += dt;
    if (p.life >= p.max) {
      particles.splice(i, 1);
      continue;
    }
    const homeSprite = p.home === null ? undefined : players.get(p.home);
    if (homeSprite) {
      const k = p.life / p.max;
      p.vx += (homeSprite.x - p.x) * 180 * k * dt;
      p.vy += (homeSprite.y - p.y) * 180 * k * dt;
    }
    p.vx *= 1 - 2.5 * dt;
    p.vy *= 1 - 2.5 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
  shake *= 1 - 8 * dt;
  flash *= 1 - 3 * dt;

  // Draw.
  ctx.clearRect(0, 0, view.w, view.h);
  ctx.save();
  const sx = (Math.random() - 0.5) * shake;
  const sy = (Math.random() - 0.5) * shake;
  ctx.translate(view.ox + sx, view.oy + sy);
  ctx.scale(view.scale, view.scale);

  ctx.strokeStyle = "rgba(90,110,160,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cfg.width - 1, cfg.height - 1);

  ctx.globalCompositeOperation = "lighter";
  drawPreview();
  const meNow = human(state);
  const myReach = reach(meNow, cfg);
  for (const s of sprites.values()) {
    const far = Math.hypot(s.tx - meNow.x, s.ty - meNow.y) > myReach;
    s.alpha = far ? 0.45 : 1;
    drawOrb(s, t, lumens(s) > meNow.light);
  }
  for (const s of players.values()) if (s.ai) drawPlayer(s, t, s.light > meNow.light);
  const me = players.get(human(state).id);
  if (me) drawPlayer(me, t, false);
  if (cfg.maxJump > 0 && state.status === "playing") {
    // Your reach, and the reach of anything that can eat you.
    for (const p of state.players) {
      if (!p.alive) continue;
      const mine = !p.ai;
      if (!mine && p.light <= human(state).light) continue;
      const c = playerColor(p);
      ctx.strokeStyle = `rgba(${c.glow},${mine ? 0.14 : 0.1})`;
      ctx.lineWidth = 1;
      ctx.setLineDash(mine ? [] : [6, 6]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, reach(p, cfg) + p.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  for (const p of particles) {
    const a = 1 - p.life / p.max;
    ctx.fillStyle = `rgba(${p.color},${a * 0.9})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  if (state.status !== "playing") {
    const won = state.status === "won";
    const drawn = state.status === "draw";
    ctx.fillStyle = `rgba(4,3,10,${0.55 + 0.4 * flash})`;
    ctx.fillRect(0, 0, cfg.width, cfg.height);
    ctx.textAlign = "center";
    ctx.fillStyle = won ? "rgba(200,255,220,0.95)" : "rgba(230,235,255,0.95)";
    const title = won
      ? "you absorbed them all"
      : drawn
        ? "a draw"
        : endReason === "faded"
        ? "faded"
        : endReason === "dark"
          ? "the universe went dark"
          : endReason === "eaten"
            ? `absorbed by ${endBy}`
            : "absorbed";
    ctx.font = `300 ${title.length > 12 ? 40 : 54}px ui-monospace, Menlo, monospace`;
    ctx.fillText(title, cfg.width / 2, cfg.height / 2 - 10);
    ctx.font = "14px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "rgba(150,165,200,0.9)";
    ctx.fillText(`${human(state).score} light gathered in ${state.turn} rounds`, cfg.width / 2, cfg.height / 2 + 26);
    ctx.fillText("tap for a new universe", cfg.width / 2, cfg.height / 2 + 50);
  }
  ctx.restore();

  requestAnimationFrame(frame);
}

// ---------- boot ----------

buildSliders();
resize();
startGame(seed);
requestAnimationFrame(frame);
