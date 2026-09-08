import {
  ORB,
  VOID,
  defaultConfig,
  newGame,
  randomSeed,
  spawnRate,
  step,
  type GameState,
  type Orb,
  type OrbKind,
  type SimConfig,
  type SimEvent,
  type StepResult,
} from "../sim";

// ---------- config + persistence ----------

const STORAGE_KEY = "lumen.config.v1";

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
  { key: "strength", min: 0, max: 300, step: 1, label: "strength (px at 0)" },
  { key: "falloff", min: 20, max: 800, step: 5, label: "falloff (half-pull dist)" },
  { key: "maxTravel", min: 10, max: 400, step: 5, label: "max travel" },
  { key: "drift", min: 0, max: 1, step: 0.01, label: "drift (momentum)" },
  { key: "playerPull", min: 0, max: 3, step: 0.05, label: "player pull / 10px" },
  { key: "voidPull", min: 0, max: 3, step: 0.05, label: "void pull" },
  { key: "spawnPerTurn", min: 0, max: 5, step: 0.25, label: "spawn per tap (at start)" },
  { key: "spawnFade", min: 0, max: 200, step: 5, label: "spawn fades out by tap (0=never)" },
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
  /** Optional homing target (the player). */
  home: boolean;
}

const COLOR: Record<OrbKind, { core: string; glow: string }> = {
  1: { core: "#e4f0ff", glow: "140,190,255" },
  2: { core: "#ffd28a", glow: "255,170,70" },
  3: { core: "#fff4fb", glow: "255,120,220" },
  4: { core: "#0a0612", glow: "120,60,200" },
};
const PLAYER = { core: "#f2fbff", glow: "120,230,255" };

const SPRING_K = 150;
const SPRING_ZETA = 0.5; // < 1 → overshoot
const SPRING_C = 2 * Math.sqrt(SPRING_K) * SPRING_ZETA;

let state: GameState;
let seed = randomSeed();
const sprites = new Map<number, Sprite>();
let player: Sprite;
const particles: Particle[] = [];
let shake = 0;
let flash = 0;
let endReason = "";
let hoverId: number | null = null;
let preview: StepResult | null = null;
let previewDirty = true;
let pointerWorld: { x: number; y: number } | null = null;
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
  };
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
  player.tx = state.player.x;
  player.ty = state.player.y;
  player.tscale = state.player.radius / cfg.playerBaseRadius;
}

function startGame(newSeed: number): void {
  seed = newSeed;
  state = newGame(seed, cfg);
  sprites.clear();
  particles.length = 0;
  player = makeSprite(
    { id: 0, kind: 1, radius: cfg.playerBaseRadius, x: state.player.x, y: state.player.y, dx: 0, dy: 0, swallowed: 0, stored: 0 },
    false,
  );
  player.tscale = 1;
  syncSprites(true);
  // Snap everything into place on a new board.
  for (const s of sprites.values()) {
    s.x = s.tx;
    s.y = s.ty;
  }
  previewDirty = true;
  hoverId = null;
  updateHud();
  log(`— new board, seed ${seed}`);
}

function updateHud(): void {
  elLight.textContent = String(Math.max(0, Math.round(state.light)));
  elScore.textContent = `score ${state.score}`;
  elTurn.textContent = `turn ${state.turn}`;
  const rate = spawnRate(state.turn, cfg);
  elOrbs.textContent = `${state.orbs.length} orbs · ${rate > 0 ? `+${rate.toFixed(1)}/tap` : "no more light"}`;
  elSeed.textContent = String(seed);
}

// ---------- effects ----------

function burst(x: number, y: number, kind: OrbKind, count: number, home: boolean): void {
  const c = COLOR[kind].glow;
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
      color: c,
      home,
    });
  }
}

function applyEvents(events: SimEvent[]): void {
  for (const e of events) {
    switch (e.type) {
      case "travel":
        if (e.cost > 0) log(`−${e.cost.toFixed(1)} light for ${Math.round(e.dist)}px`);
        break;
      case "collect":
        burst(e.orb.x, e.orb.y, e.orb.kind, e.by === "tap" ? 18 : 10, true);
        player.vscale += 1.2;
        log(`+${e.value} ${ORB[e.orb.kind].name}${e.by === "overlap" ? " (pulled in)" : ""}`);
        break;
      case "fuse": {
        burst(e.result.x, e.result.y, e.result.kind, 26, false);
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
        burst(e.orb.x, e.orb.y, e.orb.kind, 12, false);
        shake = Math.max(shake, 3);
        log(`void swallowed a ${ORB[e.orb.kind].name} (holds ${e.void_.stored}, r${e.void_.radius.toFixed(0)})`);
        break;
      case "merge":
        burst(e.result.x, e.result.y, VOID, 30, false);
        shake = Math.max(shake, 8);
        log(`two voids merged (holds ${e.result.stored}, r${e.result.radius.toFixed(0)})`);
        break;
      case "spawn":
        break;
      case "separate":
        break;
      case "blackout":
        endReason = e.reason;
        shake = e.reason === "absorbed" ? 16 : 4;
        flash = e.reason === "absorbed" ? 1 : 0.3;
        burst(e.at.x, e.at.y, e.by?.kind ?? VOID, 60, false);
        log(`${e.reason.toUpperCase()}${e.by ? ` by a ${ORB[e.by.kind].name} (r${e.by.radius.toFixed(0)})` : ""} — score ${state.score}`);
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

function orbAt(p: { x: number; y: number }): Orb | null {
  let best: Orb | null = null;
  let bestD = Infinity;
  for (const o of state.orbs) {
    const d = Math.hypot(o.x - p.x, o.y - p.y) - o.radius;
    if (d < 16 && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  return best;
}

function tap(orb: Orb): void {
  const result = step(state, orb.id, cfg);
  state = result.state;
  syncSprites(true);
  applyEvents(result.events);
  updateHud();
  previewDirty = true;
  if (!tapped) {
    tapped = true;
    elHint.classList.add("gone");
  }
}

canvas.addEventListener("pointerdown", (ev) => {
  if (state.status === "over") {
    startGame(randomSeed());
    return;
  }
  const orb = orbAt(toWorld(ev.clientX, ev.clientY));
  if (orb) tap(orb);
});

canvas.addEventListener("pointermove", (ev) => {
  pointerWorld = toWorld(ev.clientX, ev.clientY);
  const orb = orbAt(pointerWorld);
  const id = orb ? orb.id : null;
  if (id !== hoverId) {
    hoverId = id;
    previewDirty = true;
  }
});

canvas.addEventListener("pointerleave", () => {
  pointerWorld = null;
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

function drawOrb(s: Sprite, t: number, threat: boolean): void {
  const r = s.radius * s.scale * (1 + 0.03 * Math.sin(t * 2 + s.phase));
  if (r <= 0.1) return;
  if (s.kind === VOID) drawVoid(s.x, s.y, r, s.stored, s.alpha, t);
  else glowCircle(s.x, s.y, r, COLOR[s.kind].core, COLOR[s.kind].glow, s.alpha, s.kind === 3 ? 4 : 3);
  if (threat && !s.dying) {
    // Bigger than you: it eats you. Pulsing red ring.
    ctx.strokeStyle = `rgba(255,70,100,${0.55 + 0.3 * Math.sin(t * 5 + s.phase)})`;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
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
    const r = o.radius;
    if (b && (Math.abs(b.x - o.x) > 0.5 || Math.abs(b.y - o.y) > 0.5)) {
      ctx.strokeStyle = "rgba(160,190,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(o.x, o.y);
      ctx.stroke();
    }
    ctx.strokeStyle = b ? `rgba(${COLOR[o.kind].glow},0.45)` : "rgba(255,255,255,0.15)";
    ctx.beginPath();
    ctx.arc(o.x, o.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // Highlight consequences.
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
    } else if (e.type === "collect" && e.by === "overlap") {
      ctx.strokeStyle = "rgba(120,230,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(e.orb.x, e.orb.y, e.orb.radius + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // Predicted gain, near the tapped orb.
  const tappedOrb = state.orbs.find((o) => o.id === hoverId);
  if (tappedOrb) {
    const net = next.light - state.light;
    const blackout = preview.events.some((e) => e.type === "blackout" && e.reason === "absorbed");
    const faded = preview.events.some((e) => e.type === "blackout" && e.reason === "faded");
    ctx.font = "13px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = blackout || faded ? "rgba(255,80,110,1)" : net < 0 ? "rgba(255,170,120,0.95)" : "rgba(220,235,255,0.9)";
    const label = blackout ? "ABSORBED" : faded ? "FADE" : `${net >= 0 ? "+" : "−"}${Math.abs(net).toFixed(1)}`;
    ctx.fillText(label, tappedOrb.x, tappedOrb.y - tappedOrb.radius - 12);
    // Player ghost.
    ctx.strokeStyle = "rgba(120,230,255,0.5)";
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(next.player.x, next.player.y, next.player.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
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
    preview = hoverId !== null && state.status === "playing" ? step(state, hoverId, cfg) : null;
  }

  // Integrate.
  for (const s of sprites.values()) {
    springTo(s, dt, springs);
    if (s.dying && s.scale < 0.03 && Math.abs(s.vscale) < 0.5) sprites.delete(s.id);
  }
  springTo(player, dt, springs);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!;
    p.life += dt;
    if (p.life >= p.max) {
      particles.splice(i, 1);
      continue;
    }
    if (p.home) {
      const k = p.life / p.max;
      const dx = player.x - p.x;
      const dy = player.y - p.y;
      p.vx += dx * 18 * k * dt * 10;
      p.vy += dy * 18 * k * dt * 10;
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

  // Board edge.
  ctx.strokeStyle = "rgba(90,110,160,0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, cfg.width - 1, cfg.height - 1);

  ctx.globalCompositeOperation = "lighter";
  drawPreview();
  for (const s of sprites.values()) drawOrb(s, t, s.radius > state.player.radius);

  // Player.
  const pr = cfg.playerBaseRadius * player.scale;
  glowCircle(player.x, player.y, pr, PLAYER.core, PLAYER.glow, 1, 3.5);

  for (const p of particles) {
    const a = 1 - p.life / p.max;
    ctx.fillStyle = `rgba(${p.color},${a * 0.9})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * a, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  if (state.status === "over") {
    ctx.fillStyle = `rgba(4,3,10,${0.55 + 0.4 * flash})`;
    ctx.fillRect(0, 0, cfg.width, cfg.height);
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(230,235,255,0.95)";
    ctx.font = `300 ${endReason === "dark" ? 40 : 54}px ui-monospace, Menlo, monospace`;
    const title = endReason === "faded" ? "faded" : endReason === "dark" ? "the universe went dark" : "absorbed";
    ctx.fillText(title, cfg.width / 2, cfg.height / 2 - 10);
    ctx.font = "14px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "rgba(150,165,200,0.9)";
    ctx.fillText(`${state.score} light gathered in ${state.turn} taps`, cfg.width / 2, cfg.height / 2 + 26);
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
