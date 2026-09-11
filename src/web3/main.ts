import {
  burn,
  burnDeltaV,
  defaultConfig,
  attracts,
  plan,
  queueGoal,
  setGoal,
  delta,
  dist,
  human,
  lights,
  newGame,
  predict,
  radiusOf,
  step,
  threats,
  type Body,
  type Config,
  type Ev,
  type Goal,
  type Plan,
  type State,
} from "../sim3";
import { botTurn, type Memories } from "../sim3/bots";
import { createBloom } from "./bloom";
import { soundAbsorb, soundBell, soundBurn, soundInit, soundLost, soundMute, soundMuted, soundPrize, soundThreat } from "./sound";

// ---------- config + persistence ----------

const STORAGE_KEY = "lumen3.config.v1";
const LEVEL_KEY = "lumen3.level";

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

/** Difficulty is company: how many rivals share the arena. */
const LEVELS = [1, 2, 3, 5, 7];
let level = 2;
try {
  const raw = localStorage.getItem(LEVEL_KEY);
  const v = raw === null ? NaN : Number(raw);
  if (Number.isFinite(v) && v >= 0 && v < LEVELS.length) level = v;
} catch {}
const applyLevel = () => {
  cfg.players = LEVELS[level]! + 1;
};
applyLevel();

// ---------- dom ----------

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const $ = (id: string) => document.getElementById(id)!;
const lightEl = $("light");
const rankEl = $("rank");
const levelEl = $("level");
const clockEl = $("clock");
const hintEl = $("hint");
const endEl = $("end");
const endTitle = $("endtitle");
const endSub = $("endsub");
const panel = $("panel");
const logEl = $("log");
const showPath = $("showpath") as HTMLInputElement;
const showAll = $("showall") as HTMLInputElement;
const bloomBox = $("bloom") as HTMLInputElement;
const glowCanvas = $("glow") as HTMLCanvasElement;
try {
  bloomBox.checked = localStorage.getItem("lumen3.bloom") !== "0";
} catch {}
bloomBox.addEventListener("change", () => {
  try {
    localStorage.setItem("lumen3.bloom", bloomBox.checked ? "1" : "0");
  } catch {}
});

let W = 0;
let H = 0;
let dpr = 1;
function resize(): void {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  // Draw in CSS pixels; the backing store is dpr times larger.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// ---------- game state ----------

/** The sky is in the URL: #s=<seed>&r=<rivals>, so a link is a challenge. */
function readUrl(): { seed: number | null; rivals: number | null } {
  const m = new URLSearchParams(location.hash.replace(/^#/, ""));
  const seed = Number(m.get("s"));
  const rivals = Number(m.get("r"));
  return { seed: Number.isFinite(seed) && m.has("s") ? seed : null, rivals: Number.isFinite(rivals) && m.has("r") ? rivals : null };
}
function writeUrl(): void {
  try {
    history.replaceState(null, "", `#s=${seed}&r=${cfg.players - 1}`);
  } catch {}
}
const fromUrl = readUrl();
if (fromUrl.rivals !== null) {
  const idx = LEVELS.indexOf(fromUrl.rivals);
  if (idx >= 0) {
    level = idx;
    applyLevel();
  }
}
let seed = fromUrl.seed ?? (Date.now() % 100000) | 0;
let state: State = newGame(seed, cfg);
try {
  if (localStorage.getItem("lumen3.mute") === "1") soundMute(true);
} catch {}
let mem: Memories = new Map();
let acc = 0;
let last = performance.now();
const DT = 1 / 60;
let hinted = false;
const log: string[] = [];
const say = (s: string) => {
  log.unshift(s);
  if (log.length > 12) log.pop();
  logEl.textContent = log.join("\n");
};

/** Presentation-only springs: displayed radius eases toward the true one; a burn jolts it. */
const shown = new Map<number, { r: number; v: number; flash: number }>();
const spring = (b: Body): { r: number; v: number; flash: number } => {
  let s = shown.get(b.id);
  if (!s) {
    s = { r: radiusOf(b.mass, cfg), v: 0, flash: 0 };
    shown.set(b.id, s);
  }
  return s;
};
interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  hue: string;
}
let puffs: Puff[] = [];

function reset(newSeed: number): void {
  seed = newSeed;
  state = newGame(seed, cfg);
  mem = new Map();
  shown.clear();
  puffs = [];
  cam.x = human(state).x;
  cam.y = human(state).y;
  endEl.classList.remove("on");
  writeUrl();
  say(`seed ${seed} · ${cfg.players - 1} rivals`);
}

// ---------- camera ----------

const cam = { x: 0, y: 0, view: 900 };
cam.x = human(state).x;
cam.y = human(state).y;
const zoom = () => Math.min(W, H) / cam.view;
/** World → screen through the torus-shortest offset from the camera. */
function toScreen(x: number, y: number): [number, number] {
  const [dx, dy] = delta(cam.x, cam.y, x, y, cfg);
  const z = zoom();
  return [W / 2 + dx * z, H / 2 + dy * z];
}

/** How close my free-fall path comes to anything heavier in the next few seconds. */
function dangerAhead(me: Body): { gap: number; body: Body } | null {
  const path = predict(state, me, cfg, 4, 0.2);
  let worst: { gap: number; body: Body } | null = null;
  for (const t of threats(state, me, cfg)) {
    if (t.d > 900) break;
    // Passive heavier orbs can't chase or pull; they only matter when I'm about to touch them.
    const active = t.body.kind === "light" || t.body.mass >= cfg.gravityMass;
    const R = radiusOf(t.body.mass, cfg) + radiusOf(me.mass, cfg);
    let gap = t.d;
    for (const p of path) {
      const [dx, dy] = delta(p.x, p.y, t.body.x, t.body.y, cfg);
      const g = Math.hypot(dx, dy) - R;
      if (g < gap) gap = g;
    }
    if (!active && gap > 40) continue;
    if (!worst || gap < worst.gap) worst = { gap, body: t.body };
  }
  return worst;
}

function updateCamera(dt: number): void {
  const me = human(state);
  const focus = me.alive ? me : (lights(state)[0] ?? me);
  // Follow on the torus: move by the shortest displacement.
  const [dx, dy] = delta(cam.x, cam.y, focus.x, focus.y, cfg);
  const k = 1 - Math.exp(-dt * 6);
  cam.x = ((cam.x + dx * k) % cfg.width + cfg.width) % cfg.width;
  cam.y = ((cam.y + dy * k) % cfg.height + cfg.height) % cfg.height;
  // Zoom out as you grow. Then, if anything heavier is near or on my path, zoom out enough to
  // show all of it with room around it, and further the closer the path comes to it.
  const r = radiusOf(focus.mass, cfg);
  let want = Math.max(760, r * 40);
  const danger = dangerAhead(focus);
  if (danger) {
    const R = radiusOf(danger.body.mass, cfg);
    const centre = dist(focus, danger.body, cfg);
    const fit = 2 * (centre + R + 140);
    const alarm = danger.gap < 220 ? 1 + (1 - Math.max(0, danger.gap) / 220) * 0.8 : 1;
    want = Math.max(want, fit * alarm, danger.gap < 220 ? 1300 : 0);
  }
  want = Math.min(want, Math.min(cfg.width, cfg.height));
  // Snap out fast, ease back in slowly.
  const rate = want > cam.view ? 4 : 0.8;
  cam.view += (want - cam.view) * (1 - Math.exp(-dt * rate));
}

// ---------- input ----------

const pointer = { x: W / 2, y: H / 2, down: false, inside: false };
const BURN_RANGE = 220; // screen px for a full-strength manual burn
const manual = $("manual") as HTMLInputElement;

/** Screen → world, through the camera. */
function toWorld(sx: number, sy: number): [number, number] {
  const z = zoom();
  const x = ((cam.x + (sx - W / 2) / z) % cfg.width + cfg.width) % cfg.width;
  const y = ((cam.y + (sy - H / 2) / z) % cfg.height + cfg.height) % cfg.height;
  return [x, y];
}

/** The body under the cursor, if any (not me). */
function under(me: Body): Body | null {
  const z = zoom();
  let hit: Body | null = null;
  let hd = Infinity;
  for (const b of state.bodies) {
    if (!b.alive || b === me || b.from) continue;
    const [sx, sy] = toScreen(b.x, b.y);
    const r = Math.max(10, radiusOf(b.mass, cfg) * z * 1.4);
    const d = Math.hypot(pointer.x - sx, pointer.y - sy);
    if (d < r && d < hd) {
      hit = b;
      hd = d;
    }
  }
  return hit;
}

/** What a tap at the cursor means right now. */
function goalAtCursor(me: Body): Goal {
  const b = under(me);
  if (b && b.mass < me.mass) return { x: b.x, y: b.y, follow: b.id };
  if (b && attracts(b, cfg)) {
    // Something that could eat me and pulls: enter orbit at my current distance, not too close.
    const r = Math.max(radiusOf(b.mass, cfg) + radiusOf(me.mass, cfg) + 70, dist(me, b, cfg));
    return { x: b.x, y: b.y, follow: b.id, orbit: r };
  }
  const [x, y] = toWorld(pointer.x, pointer.y);
  return { x, y, follow: 0 };
}

function burnToward(): void {
  const me = human(state);
  if (!me.alive || state.status !== "playing") return;
  const [sx, sy] = toScreen(me.x, me.y);
  const dx = pointer.x - sx;
  const dy = pointer.y - sy;
  const d = Math.hypot(dx, dy);
  if (d < 6) return;
  const ev: Ev[] = [];
  if (burn(state, me.id, dx, dy, d / BURN_RANGE, cfg, ev)) onEvents(ev);
}

function tap(queue: boolean): void {
  const me = human(state);
  if (!me.alive || state.status !== "playing") return;
  if (manual.checked) {
    burnToward();
    return;
  }
  const g = goalAtCursor(me);
  if (queue) queueGoal(state, me.id, g);
  else setGoal(state, me.id, g);
  const t = g.follow ? state.bodies.find((b) => b.id === g.follow) : null;
  const what = g.orbit ? `orbit a ${t?.mass.toFixed(0)} at ${g.orbit.toFixed(0)}` : t ? `→ ${t.kind === "light" ? t.name : `${t.mass.toFixed(1)}-lumen orb`}` : "→ point";
  say(queue && me.queue.length ? `then ${what}` : what);
}

canvas.addEventListener("pointermove", (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.inside = true;
  // Dragging moves a point destination with the cursor.
  if (pointer.down && !manual.checked) {
    const me = human(state);
    if (me.alive && me.goal && !me.goal.follow) {
      const [x, y] = toWorld(pointer.x, pointer.y);
      me.goal.x = x;
      me.goal.y = y;
    }
  }
});
canvas.addEventListener("pointerleave", () => (pointer.inside = false));
canvas.addEventListener("pointerdown", (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.down = true;
  pointer.inside = true;
  soundInit();
  if (!hinted) {
    hinted = true;
    hintEl.classList.add("gone");
  }
  if (state.status !== "playing") {
    reset(seed + 1);
    return;
  }
  tap(e.shiftKey);
});
window.addEventListener("pointerup", () => (pointer.down = false));
window.addEventListener("keydown", (e) => {
  soundInit();
  if (e.key === "m" || e.key === "M") {
    soundMute(!soundMuted());
    try {
      localStorage.setItem("lumen3.mute", soundMuted() ? "1" : "0");
    } catch {}
    say(soundMuted() ? "sound off" : "sound on");
  }
  if (e.key === " ") {
    e.preventDefault();
    setGoal(state, human(state).id, null);
    say("drift");
  }
  if (e.key === "r" || e.key === "R") reset(seed + 1);
  if (e.key === "t" || e.key === "T") panel.classList.toggle("hidden");
  if (e.key === "]" && level < LEVELS.length - 1) {
    level++;
    applyLevel();
    saveLevel();
    reset(seed + 1);
  }
  if (e.key === "[" && level > 0) {
    level--;
    applyLevel();
    saveLevel();
    reset(seed + 1);
  }
});
const saveLevel = () => {
  try {
    localStorage.setItem(LEVEL_KEY, String(level));
  } catch {}
};

// ---------- events ----------

const COLORS: Record<number, string> = {};
const PALETTE = ["200 90% 78%", "330 90% 70%", "40 95% 65%", "140 70% 60%", "270 80% 72%", "15 90% 65%", "180 70% 60%", "60 80% 65%"];
/** A light's identity colour. */
function identity(b: Body): string {
  if (!b.ai) return PALETTE[0]!;
  if (!COLORS[b.id]) {
    const n = Object.keys(COLORS).length;
    COLORS[b.id] = PALETTE[1 + (n % (PALETTE.length - 1))]!;
  }
  return COLORS[b.id]!;
}
/**
 * What a body's glow says about it, relative to me: warm and red if it can absorb me, cool and
 * blue-white if I can absorb it, dim grey if we're equal. Exhaust carries its owner's identity.
 */
function hueOf(b: Body, me: Body): string {
  if (b.kind === "light" && b === me) return identity(b);
  if (b.kind === "orb" && b.from) {
    const owner = state.bodies.find((x) => x.id === b.from);
    if (owner) return identity(owner);
  }
  if (b.prize && b.mass < me.mass) return "48 100% 65%";
  if (b.mass > me.mass) return b.mass > me.mass * 3 ? "18 100% 62%" : "348 90% 66%";
  if (b.mass < me.mass) return b.mass < me.mass * 0.2 ? "215 50% 88%" : "200 85% 78%";
  return "220 10% 70%";
}

function onEvents(ev: Ev[]): void {
  const me = human(state);
  for (const e of ev) {
    if (e.type === "absorb") {
      if (e.eater === me.id && e.amount > 0.02) soundAbsorb(e.amount);
    } else if (e.type === "prize") {
      say(`a ${e.mass.toFixed(0)}-lumen prize is falling`);
      soundPrize();
    } else if (e.type === "flare") {
      const g = state.bodies.find((x) => x.id === e.id);
      if (g) {
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          puffs.push({ x: g.x, y: g.y, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160, age: 0, hue: "35 100% 75%" });
        }
      }
    } else if (e.type === "bell") {
      const w = state.bodies.find((x) => x.id === e.winner);
      const mine = w === me;
      endTitle.textContent = mine ? "THE BELL · YOURS" : `THE BELL · ${w?.name.toUpperCase() ?? "NOBODY"}`;
      endSub.innerHTML = `${me.mass.toFixed(1)} lumens on seed ${seed} · <a href="${location.href}">this sky's link</a> · tap for a new one`;
      endEl.classList.add("on");
      soundBell();
    } else if (e.type === "burn") {
      const b = state.bodies.find((x) => x.id === e.id);
      if (b === me) soundBurn(Math.min(1, e.mass / (me.mass * cfg.burnFraction + 1e-6)));
      if (b) {
        const s = spring(b);
        s.v -= 40;
        s.flash = 1;
        for (let i = 0; i < 3; i++) {
          const a = Math.atan2(-e.dy, -e.dx) + (Math.random() - 0.5) * 0.9;
          const sp = 60 + Math.random() * 120;
          puffs.push({ x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, age: 0, hue: identity(b) });
        }
      }
    } else if (e.type === "gone" && e.kind === "light") {
      const by = state.bodies.find((x) => x.id === e.by);
      const who = by?.name || `a ${by?.mass.toFixed(0)}-lumen body`;
      say(`${e.name} absorbed by ${who}`);
    } else if (e.type === "over") {
      if (state.time < cfg.roundSeconds || !cfg.roundSeconds) soundLost();
      if (me.alive) continue; // the bell already spoke
      endTitle.textContent = "ABSORBED";
      const killer = log[0]?.replace(/^You absorbed by /, "") ?? "";
      endSub.textContent = `${killer ? `by ${killer} · ` : ""}${me.mass.toFixed(1)} lumens at the end · tap for a new sky`;
      endEl.classList.add("on");
    } else if (e.type === "win") {
      soundBell();
      endTitle.textContent = "LAST LIGHT";
      endSub.textContent = `${human(state).mass.toFixed(1)} lumens · ${state.time.toFixed(0)}s · tap for a new sky`;
      endEl.classList.add("on");
    }
  }
}

// ---------- draw ----------

const STARS = Array.from({ length: 260 }, (_, i) => ({ x: ((i * 7919) % 2400) / 2400, y: ((i * 104729) % 2400) / 2400, s: 0.4 + ((i * 31) % 10) / 12 }));

function drawBackground(): void {
  ctx.fillStyle = "#05060c";
  ctx.fillRect(-2, -2, W + 4, H + 4);
  // Parallax starfield tiled on the torus at half the camera motion.
  const z = zoom();
  const tile = Math.min(cfg.width, cfg.height) * z;
  const ox = ((-cam.x * 0.5 * z) % tile + tile) % tile;
  const oy = ((-cam.y * 0.5 * z) % tile + tile) % tile;
  ctx.fillStyle = "rgba(200, 215, 255, 0.55)";
  for (let ty = -1; ty <= Math.ceil(H / tile); ty++) {
    for (let tx = -1; tx <= Math.ceil(W / tile); tx++) {
      for (const st of STARS) {
        const x = ox + (tx + st.x) * tile;
        const y = oy + (ty + st.y) * tile;
        if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
        ctx.globalAlpha = 0.25 + st.s * 0.4;
        ctx.fillRect(x, y, st.s, st.s);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function glow(x: number, y: number, r: number, hue: string, inner = 1, halo = 2.6): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * halo);
  g.addColorStop(0, `hsla(${hue} / ${inner})`);
  g.addColorStop(Math.min(0.98, 1 / halo), `hsla(${hue} / ${0.55 * inner})`);
  g.addColorStop(1, `hsla(${hue} / 0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * halo, 0, Math.PI * 2);
  ctx.fill();
}

function drawPoints(from: { x: number; y: number }, p: Array<{ x: number; y: number }>, colour: string, width = 1, dash: number[] = [3, 5]): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  let [px, py] = toScreen(from.x, from.y);
  ctx.moveTo(px, py);
  for (const q of p) {
    const [x, y] = toScreen(q.x, q.y);
    if (Math.abs(x - px) > W / 2 || Math.abs(y - py) > H / 2) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    px = x;
    py = y;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

/** My path if I burn toward the cursor right now. */
function burnPreview(me: Body): Array<{ x: number; y: number }> | null {
  const [sx, sy] = toScreen(me.x, me.y);
  const dx = pointer.x - sx;
  const dy = pointer.y - sy;
  const d = Math.hypot(dx, dy);
  if (d < 6) return null;
  const dv = burnDeltaV(me.mass, d / BURN_RANGE, cfg);
  const ghost: Body = { ...me, vx: me.vx + (dx / d) * dv, vy: me.vy + (dy / d) * dv };
  return predict(state, ghost, cfg, 4, 0.1);
}

function drawPath(b: Body, alpha: number): void {
  const p = predict(state, b, cfg, 4, 0.1);
  ctx.strokeStyle = `hsla(${identity(b)} / ${alpha})`;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  let [px, py] = toScreen(b.x, b.y);
  ctx.moveTo(px, py);
  for (const q of p) {
    const [x, y] = toScreen(q.x, q.y);
    if (Math.abs(x - px) > W / 2 || Math.abs(y - py) > H / 2) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    px = x;
    py = y;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawEdgeMarkers(me: Body): void {
  const z = zoom();
  const prizes = state.bodies.filter((b) => b.alive && b.prize && b.mass < me.mass).map((body) => ({ body, d: dist(me, body, cfg) }));
  for (const t of [...prizes, ...threats(state, me, cfg)]) {
    if (t.d > 1400 && !t.body.prize) break;
    // Only things that can come for me: lights, and bodies heavy enough to pull. And prizes.
    if (!t.body.prize && t.body.kind !== "light" && t.body.mass < cfg.gravityMass) continue;
    const [sx, sy] = toScreen(t.body.x, t.body.y);
    const r = radiusOf(t.body.mass, cfg) * z;
    if (sx + r > 0 && sx - r < W && sy + r > 0 && sy - r < H) continue;
    // Chevron at the screen edge pointing to it, sized by how close it is.
    const ang = Math.atan2(sy - H / 2, sx - W / 2);
    const m = 26;
    const ex = Math.min(W - m, Math.max(m, W / 2 + Math.cos(ang) * W));
    const ey = Math.min(H - m, Math.max(m, H / 2 + Math.sin(ang) * H));
    const s = 6 + 10 * Math.max(0, 1 - t.d / 1400);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(ang);
    ctx.fillStyle = `hsla(${hueOf(t.body, me)} / 0.85)`;
    ctx.beginPath();
    ctx.moveTo(s, 0);
    ctx.lineTo(-s * 0.7, -s * 0.7);
    ctx.lineTo(-s * 0.3, 0);
    ctx.lineTo(-s * 0.7, s * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** World and UI are drawn separately so the bloom can sample the world alone. */
let uiGhost: Array<{ x: number; y: number }> | null = null;
const labels: Array<{ text: string; x: number; y: number; hue: string }> = [];
let uiRoute: { plan: Plan; goal: Goal } | null = null;

function drawWorld(dt: number): void {
  drawBackground();
  const me = human(state);
  const z = zoom();

  // Paths first, under everything.
  if (showAll.checked) for (const l of lights(state)) if (l !== me) drawPath(l, 0.25);
  if (showPath.checked && me.alive) drawPath(me, 0.35);
  // Where a click would take me. Manual: the burn path. Autopilot: the rehearsed route and its price.
  let ghost: Array<{ x: number; y: number }> | null = null;
  let route: { plan: Plan; goal: Goal } | null = null;
  if (showPath.checked && me.alive && pointer.inside && state.status === "playing") {
    if (manual.checked) {
      ghost = burnPreview(me);
      if (ghost) drawPoints(me, ghost, `hsla(${identity(me)} / 0.85)`, 1.5, [6, 4]);
    } else {
      const goal = goalAtCursor(me);
      const p = plan(state, me, goal, cfg, 8, 0.1);
      route = { plan: p, goal };
      ghost = p.path;
      if (p.blocked) {
        // Safe part in my colour, the rest in red from the point of impact.
        const cut = Math.max(0, Math.round(p.blocked.t / 0.1));
        drawPoints(me, p.path.slice(0, cut), `hsla(${identity(me)} / 0.85)`, 1.5, [6, 4]);
        const from = p.path[Math.max(0, cut - 1)] ?? me;
        drawPoints(from, p.path.slice(cut), "hsla(350 90% 65% / 0.8)", 1.5, [2, 4]);
        const [bx, by] = toScreen(from.x, from.y);
        ctx.strokeStyle = "hsla(350 90% 65% / 0.9)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(bx - 6, by - 6);
        ctx.lineTo(bx + 6, by + 6);
        ctx.moveTo(bx + 6, by - 6);
        ctx.lineTo(bx - 6, by + 6);
        ctx.stroke();
      } else {
        drawPoints(me, p.path, p.arrives ? `hsla(${identity(me)} / 0.85)` : "hsla(0 0% 100% / 0.3)", 1.5, [6, 4]);
      }
    }
  }
  // Queued destinations: a chain from the current goal onward.
  if (me.alive && me.goal && me.queue.length) {
    const spot = (g: Goal): [number, number] => {
      const t = g.follow ? state.bodies.find((b) => b.id === g.follow) : null;
      return toScreen(t ? t.x : g.x, t ? t.y : g.y);
    };
    let [px, py] = spot(me.goal);
    ctx.strokeStyle = `hsla(${identity(me)} / 0.35)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 6]);
    me.queue.forEach((g, i) => {
      const [x, y] = spot(g);
      ctx.beginPath();
      if (Math.abs(x - px) < W / 2 && Math.abs(y - py) < H / 2) {
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `hsla(${identity(me)} / 0.7)`;
      ctx.font = "10px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 2), x, y - 9);
      ctx.setLineDash([2, 6]);
      px = x;
      py = y;
    });
    ctx.setLineDash([]);
  }
  // The current destination and the leash to it.
  if (me.alive && me.goal) {
    const t = me.goal.follow ? state.bodies.find((b) => b.id === me.goal!.follow) : null;
    const gx = t ? t.x : me.goal.x;
    const gy = t ? t.y : me.goal.y;
    const [sx, sy] = toScreen(gx, gy);
    ctx.strokeStyle = `hsla(${identity(me)} / 0.7)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(sx, sy, t ? Math.max(6, radiusOf(t.mass, cfg) * z + 4) : 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - 11, sy);
    ctx.lineTo(sx - 4, sy);
    ctx.moveTo(sx + 4, sy);
    ctx.lineTo(sx + 11, sy);
    ctx.moveTo(sx, sy - 11);
    ctx.lineTo(sx, sy - 4);
    ctx.moveTo(sx, sy + 4);
    ctx.lineTo(sx, sy + 11);
    ctx.stroke();
  }

  // Orbit lanes: faint rings around anything that pulls, and the lane I'm holding in my colour.
  for (const b of state.bodies) {
    if (!b.alive || !attracts(b, cfg) || b === me) continue;
    const [sx, sy] = toScreen(b.x, b.y);
    const R = radiusOf(b.mass, cfg);
    for (const extra of [110, 220]) {
      const r = (R + extra) * z;
      if (r > Math.max(W, H)) continue;
      ctx.strokeStyle = "hsla(30 80% 80% / 0.07)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (me.alive && me.goal?.orbit && me.goal.follow === b.id) {
      ctx.strokeStyle = `hsla(${identity(me)} / 0.45)`;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(sx, sy, me.goal.orbit * z, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Bodies, big first so lights and orbs sit on top of sun halos.
  const bodies = state.bodies.filter((b) => b.alive).sort((a, b) => b.mass - a.mass);
  labels.length = 0;
  for (const b of bodies) {
    const [sx, sy] = toScreen(b.x, b.y);
    const target = radiusOf(b.mass, cfg);
    const s = spring(b);
    s.v += (target - s.r) * 140 * dt;
    s.v *= Math.exp(-dt * 9);
    s.r += s.v * dt;
    s.flash *= Math.exp(-dt * 8);
    const r = Math.max(0.6, s.r) * z;
    if (sx + r * 3 < 0 || sx - r * 3 > W || sy + r * 3 < 0 || sy - r * 3 > H) continue;
    const hue = hueOf(b, me);
    const isLight = b.kind === "light";
    if (b.from) {
      ctx.fillStyle = `hsla(${hue} / 0.55)`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(0.8, r * 0.5), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const heavier = b.mass > me.mass && me.alive && b !== me;
    // Halo says threat or food; the core is white for lights, tinted for orbs.
    glow(sx, sy, r, hue, isLight ? 0.9 + s.flash * 0.3 : 0.75, isLight ? 2.8 : b.mass >= cfg.gravityMass ? 1.9 : 2);
    if (isLight) {
      ctx.fillStyle = `hsla(${identity(b)} / 0.95)`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1, r * 0.62), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "hsla(0 0% 100% / 0.95)";
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(0.8, r * 0.36), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = b.mass >= cfg.gravityMass ? "hsla(30 80% 92% / 0.9)" : `hsla(${hue} / 0.9)`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(0.8, r * (b.mass >= cfg.gravityMass ? 0.82 : 0.5)), 0, Math.PI * 2);
      ctx.fill();
    }
    if (b.prize) {
      // A prize pulses so it reads as an event, not scenery.
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 180);
      ctx.strokeStyle = `hsla(48 100% 70% / ${0.35 + 0.5 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 6 + pulse * 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (heavier && isLight) {
      ctx.strokeStyle = "hsla(350 90% 65% / 0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isLight) labels.push({ text: `${b.ai ? b.name + " " : ""}${b.mass.toFixed(b.mass < 10 ? 1 : 0)}`, x: sx, y: sy - r - 9, hue: identity(b) });
  }

  // Exhaust puffs.
  puffs = puffs.filter((p) => p.age < 0.7);
  for (const p of puffs) {
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const [sx, sy] = toScreen(p.x, p.y);
    ctx.fillStyle = `hsla(${p.hue} / ${0.5 * (1 - p.age / 0.7)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, 1.5 * z, 0, Math.PI * 2);
    ctx.fill();
  }

  uiGhost = ghost;
  uiRoute = route;
}

function drawUi(): void {
  const me = human(state);
  const z = zoom();
  const ghost = uiGhost;
  const route = uiRoute;
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  for (const l of labels) {
    ctx.fillStyle = `hsla(${l.hue} / 0.9)`;
    ctx.fillText(l.text, l.x, l.y);
  }
  if (me.alive) drawEdgeMarkers(me);
  drawMinimap(me);
  // The hum: how close the nearest thing that can eat me is, on a 0..1 scale.
  if (me.alive) {
    const near = threats(state, me, cfg).filter((t) => t.body.kind === "light" || attracts(t.body, cfg))[0];
    soundThreat(near ? Math.max(0, 1 - near.d / 260) : 0);
  } else soundThreat(0);

  // Hover: the lumens of whatever is under the cursor.
  if (pointer.inside) {
    let hit: { b: Body; sx: number; sy: number; r: number } | null = null;
    for (const b of state.bodies) {
      if (!b.alive) continue;
      if (b === me) continue;
      const [sx, sy] = toScreen(b.x, b.y);
      const r = Math.max(8, radiusOf(b.mass, cfg) * z * 1.4);
      const d = Math.hypot(pointer.x - sx, pointer.y - sy);
      if (d < r && (!hit || d < Math.hypot(pointer.x - hit.sx, pointer.y - hit.sy))) hit = { b, sx, sy, r };
    }
    if (hit) {
      const b = hit.b;
      const verdict = b.mass > me.mass ? "absorbs you" : b.mass < me.mass ? "food" : "equal";
      // Its path, and where my path comes closest to it. Green when that's a catch.
      if (!b.anchored) {
        const theirs = predict(state, b, cfg, 4, 0.1);
        drawPoints(b, theirs, `hsla(${hueOf(b, me)} / 0.6)`, 1, [2, 4]);
        const mine = ghost ?? predict(state, me, cfg, 4, 0.1);
        const reach = radiusOf(b.mass, cfg) + radiusOf(me.mass, cfg);
        let best = Infinity;
        let at = -1;
        for (let i = 0; i < mine.length && i < theirs.length; i++) {
          const [dx, dy] = delta(mine[i]!.x, mine[i]!.y, theirs[i]!.x, theirs[i]!.y, cfg);
          const g = Math.hypot(dx, dy) - reach;
          if (g < best) {
            best = g;
            at = i;
          }
        }
        if (at >= 0) {
          const caught = best <= 0;
          const [mx, my] = toScreen(mine[at]!.x, mine[at]!.y);
          const [tx, ty] = toScreen(theirs[at]!.x, theirs[at]!.y);
          ctx.strokeStyle = caught ? "hsla(140 80% 60% / 0.9)" : "hsla(0 0% 100% / 0.35)";
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(tx, ty, Math.max(3, radiusOf(b.mass, cfg) * z), 0, Math.PI * 2);
          ctx.stroke();
          if (caught) {
            ctx.fillStyle = "hsla(140 80% 60% / 0.9)";
            ctx.font = "11px ui-monospace, Menlo, monospace";
            ctx.fillText(`${((at + 1) * 0.1).toFixed(1)}s`, tx, ty - Math.max(3, radiusOf(b.mass, cfg) * z) - 6);
          }
        }
      }
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = `hsla(${hueOf(b, me)} / 0.95)`;
      const price = route && route.goal.follow === b.id
        ? route.goal.orbit
          ? route.plan.arrives
            ? ` · orbit for ${route.plan.cost.toFixed(1)}`
            : " · orbit (costly)"
          : route.plan.blocked
          ? " · route hits something heavier"
          : route.plan.arrives
            ? ` · ${route.plan.cost.toFixed(1)} to catch in ${route.plan.t.toFixed(0)}s`
            : " · can't catch"
        : "";
      const label = `${b.kind === "light" ? b.name + " · " : ""}${b.mass.toFixed(b.mass < 10 ? 1 : 0)} · ${verdict}${price}`;
      ctx.fillText(label, hit.sx, hit.sy - hit.r - 12);
      ctx.strokeStyle = `hsla(${hueOf(b, me)} / 0.6)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hit.sx, hit.sy, hit.r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Price tag for a point destination.
  if (route && !route.goal.follow) {
    ctx.font = "11px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    const blocked = route.plan.blocked;
    ctx.fillStyle = blocked ? "hsla(350 90% 70% / 0.9)" : route.plan.arrives ? "hsla(200 90% 85% / 0.85)" : "hsla(0 0% 100% / 0.45)";
    ctx.fillText(blocked ? "route hits something heavier" : route.plan.arrives ? `${route.plan.cost.toFixed(1)} · ${route.plan.t.toFixed(0)}s` : "too far", pointer.x + 12, pointer.y - 10);
  }
  // Aim: a line from me to the cursor with the burn strength as its brightness (manual only).
  if (manual.checked && me.alive && pointer.inside && state.status === "playing") {
    const [sx, sy] = toScreen(me.x, me.y);
    const dx = pointer.x - sx;
    const dy = pointer.y - sy;
    const d = Math.hypot(dx, dy);
    const k = Math.min(1, d / BURN_RANGE);
    ctx.strokeStyle = `hsla(200 90% 80% / ${0.15 + 0.45 * k})`;
    ctx.lineWidth = 1 + 2 * k;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (dx / (d || 1)) * Math.min(d, BURN_RANGE), sy + (dy / (d || 1)) * Math.min(d, BURN_RANGE));
    ctx.stroke();
    ctx.strokeStyle = "hsla(200 90% 85% / 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pointer.x, pointer.y, 5 + 5 * k, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** The whole torus in a corner: pulls, lights, prizes, food, and the view. */
function drawMinimap(me: Body): void {
  const size = Math.min(180, Math.floor(Math.min(W, H) * 0.24));
  const pad = 14;
  const x0 = W - size - pad;
  const y0 = H - size - pad;
  const k = size / cfg.width;
  ctx.fillStyle = "rgba(5, 6, 12, 0.7)";
  ctx.fillRect(x0, y0, size, size);
  ctx.strokeStyle = "rgba(120, 140, 200, 0.25)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);
  // Centre the map on me so the view never straddles the seam.
  const cx = me.x;
  const cy = me.y;
  const at = (b: { x: number; y: number }): [number, number] => {
    const [dx, dy] = delta(cx, cy, b.x, b.y, cfg);
    return [x0 + size / 2 + dx * k, y0 + size / 2 + dy * k];
  };
  for (const b of state.bodies) {
    if (!b.alive || b.from) continue;
    const [px, py] = at(b);
    if (b.kind === "light") {
      ctx.fillStyle = `hsl(${identity(b)})`;
      ctx.beginPath();
      ctx.arc(px, py, b === me ? 3 : 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else if (attracts(b, cfg)) {
      ctx.fillStyle = "hsla(30 90% 70% / 0.8)";
      ctx.beginPath();
      ctx.arc(px, py, Math.max(2, radiusOf(b.mass, cfg) * k), 0, Math.PI * 2);
      ctx.fill();
    } else if (b.prize) {
      ctx.fillStyle = "hsl(48 100% 65%)";
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    } else {
      ctx.fillStyle = b.mass < me.mass ? "hsla(210 60% 85% / 0.55)" : "hsla(350 80% 65% / 0.55)";
      ctx.fillRect(px - 0.5, py - 0.5, 1.2, 1.2);
    }
  }
  // The view.
  const vw = (W / zoom()) * k;
  const vh = (H / zoom()) * k;
  const [vx, vy] = at(cam);
  ctx.strokeStyle = "rgba(220, 230, 255, 0.35)";
  ctx.strokeRect(vx - vw / 2, vy - vh / 2, vw, vh);
}

// ---------- hud ----------

function hud(): void {
  const me = human(state);
  lightEl.textContent = me.mass.toFixed(me.mass < 10 ? 1 : 0);
  const ranked = state.bodies
    .filter((b) => b.kind === "light")
    .sort((a, b) => b.mass - a.mass);
  rankEl.innerHTML = ranked
    .map((b) => `<span style="color:hsl(${identity(b)})${b.alive ? "" : ";opacity:.35;text-decoration:line-through"}"><b>${b.name}</b> ${b.mass.toFixed(1)}${b.ai && b.trait !== "rival" ? `<i>${b.trait}</i>` : ""}</span>`)
    .join("");
  const left = cfg.roundSeconds ? Math.max(0, cfg.roundSeconds - state.time) : state.time;
  const mm = Math.floor(left / 60);
  const ss = Math.floor(left % 60);
  clockEl.textContent = `${mm}:${String(ss).padStart(2, "0")}`;
  clockEl.classList.toggle("late", cfg.roundSeconds > 0 && left < 30);
  levelEl.textContent = `· ${cfg.players - 1} rival${cfg.players - 1 === 1 ? "" : "s"} · seed ${seed}`;
}

// ---------- loop ----------

function frame(now: number): void {
  const elapsed = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += elapsed;
  while (acc >= DT) {
    if (state.status === "playing") {
      const ev: Ev[] = [];
      for (const it of botTurn(state, cfg, DT, undefined, mem)) burn(state, it.id, it.dx, it.dy, it.strength, cfg, ev);
      if (pointer.down && manual.checked) burnToward();
      step(state, cfg, DT, ev);
      onEvents(ev);
    }
    acc -= DT;
  }
  updateCamera(elapsed);
  drawWorld(elapsed);
  const glowing = bloomBox.checked && bloom.ok;
  glowCanvas.classList.toggle("off", !glowing);
  if (glowing) bloom.render();
  drawUi();
  hud();
  requestAnimationFrame(frame);
}
const bloom = createBloom(canvas, glowCanvas);
requestAnimationFrame(frame);

// ---------- tuning panel ----------

interface SliderDef {
  key: keyof Config;
  min: number;
  max: number;
  stepSize: number;
  restart?: boolean;
}
const SLIDERS: SliderDef[] = [
  { key: "G", min: 500, max: 8000, stepSize: 100 },
  { key: "gravityMass", min: 5, max: 100, stepSize: 1 },
  { key: "orbMassMax", min: 20, max: 300, stepSize: 5, restart: true },
  { key: "giants", min: 0, max: 6, stepSize: 1, restart: true },
  { key: "absorbRate", min: 0.2, max: 10, stepSize: 0.1 },
  { key: "burnFraction", min: 0.01, max: 0.15, stepSize: 0.005 },
  { key: "ejectSpeed", min: 100, max: 1200, stepSize: 20 },
  { key: "burnCooldown", min: 0.02, max: 0.6, stepSize: 0.02 },
  { key: "orbs", min: 10, max: 200, stepSize: 5, restart: true },
  { key: "startMass", min: 2, max: 30, stepSize: 1, restart: true },
  { key: "radiusScale", min: 2, max: 8, stepSize: 0.25 },
  { key: "radiusFloor", min: 0, max: 8, stepSize: 0.5 },
  { key: "exhaustHalfLife", min: 0.2, max: 6, stepSize: 0.1 },
  { key: "cruise", min: 40, max: 400, stepSize: 10 },
  { key: "roundSeconds", min: 0, max: 600, stepSize: 30, restart: true },
  { key: "prizeEvery", min: 0, max: 120, stepSize: 5 },
  { key: "flareEvery", min: 0, max: 120, stepSize: 5 },
  { key: "approach", min: 0.2, max: 3, stepSize: 0.1 },
];
const slidersEl = $("sliders");
function buildSliders(): void {
  slidersEl.innerHTML = "";
  for (const def of SLIDERS) {
    const wrap = document.createElement("div");
    wrap.className = "slider";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = def.key;
    const val = document.createElement("span");
    val.className = "val";
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.stepSize);
    input.value = String(cfg[def.key]);
    val.textContent = String(cfg[def.key]);
    input.addEventListener("input", () => {
      (cfg as unknown as Record<string, number>)[def.key] = Number(input.value);
      val.textContent = input.value;
      saveConfig();
      if (def.restart) reset(seed);
    });
    wrap.append(name, val, input);
    slidersEl.append(wrap);
  }
}
buildSliders();
$("toggle").addEventListener("click", () => panel.classList.add("hidden"));
$("newboard").addEventListener("click", () => reset(seed + 1));
$("replay").addEventListener("click", () => reset(seed));
$("copy").addEventListener("click", () => navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2)));
$("reset").addEventListener("click", () => {
  Object.assign(cfg, defaultConfig);
  applyLevel();
  saveConfig();
  buildSliders();
  reset(seed);
});
writeUrl();
say(`seed ${seed} · ${cfg.players - 1} rivals`);

// Debug hook for headless checks.
(window as unknown as { __lumen: unknown }).__lumen = { cam, get state() { return state; }, cfg };
