import {
  burn,
  defaultConfig,
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
  type State,
} from "../sim3";
import { botTurn, type Memories } from "../sim3/bots";

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
const hintEl = $("hint");
const endEl = $("end");
const endTitle = $("endtitle");
const endSub = $("endsub");
const panel = $("panel");
const logEl = $("log");
const showPath = $("showpath") as HTMLInputElement;
const showAll = $("showall") as HTMLInputElement;

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

let seed = (Date.now() % 100000) | 0;
let state: State = newGame(seed, cfg);
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
const BURN_RANGE = 220; // screen px for a full-strength burn

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

canvas.addEventListener("pointermove", (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.inside = true;
});
canvas.addEventListener("pointerleave", () => (pointer.inside = false));
canvas.addEventListener("pointerdown", (e) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.down = true;
  pointer.inside = true;
  if (!hinted) {
    hinted = true;
    hintEl.classList.add("gone");
  }
  if (state.status !== "playing") {
    reset(seed + 1);
    return;
  }
  burnToward();
});
window.addEventListener("pointerup", () => (pointer.down = false));
window.addEventListener("keydown", (e) => {
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
  if (b.mass > me.mass) return b.mass > me.mass * 3 ? "18 100% 62%" : "348 90% 66%";
  if (b.mass < me.mass) return b.mass < me.mass * 0.2 ? "215 50% 88%" : "200 85% 78%";
  return "220 10% 70%";
}

function onEvents(ev: Ev[]): void {
  for (const e of ev) {
    if (e.type === "burn") {
      const b = state.bodies.find((x) => x.id === e.id);
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
      const me = human(state);
      endTitle.textContent = "ABSORBED";
      const killer = log[0]?.replace(/^You absorbed by /, "") ?? "";
      endSub.textContent = `${killer ? `by ${killer} · ` : ""}${me.mass.toFixed(1)} lumens at the end · tap for a new sky`;
      endEl.classList.add("on");
    } else if (e.type === "win") {
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
  for (const t of threats(state, me, cfg)) {
    if (t.d > 1400) break;
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

function draw(dt: number): void {
  drawBackground();
  const me = human(state);
  const z = zoom();

  // Paths first, under everything.
  if (showAll.checked) for (const l of lights(state)) if (l !== me) drawPath(l, 0.25);
  if (showPath.checked && me.alive) drawPath(me, 0.5);

  // Bodies, big first so lights and orbs sit on top of sun halos.
  const bodies = state.bodies.filter((b) => b.alive).sort((a, b) => b.mass - a.mass);
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
    if (heavier && isLight) {
      ctx.strokeStyle = "hsla(350 90% 65% / 0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (isLight) {
      ctx.fillStyle = `hsla(${identity(b)} / 0.9)`;
      ctx.font = "11px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${b.ai ? b.name + " " : ""}${b.mass.toFixed(b.mass < 10 ? 1 : 0)}`, sx, sy - r - 9);
    }
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

  if (me.alive) drawEdgeMarkers(me);

  // Hover: the lumens of whatever is under the cursor.
  if (pointer.inside) {
    let hit: { b: Body; sx: number; sy: number; r: number } | null = null;
    for (const b of bodies) {
      if (b === me) continue;
      const [sx, sy] = toScreen(b.x, b.y);
      const r = Math.max(8, radiusOf(b.mass, cfg) * z * 1.4);
      const d = Math.hypot(pointer.x - sx, pointer.y - sy);
      if (d < r && (!hit || d < Math.hypot(pointer.x - hit.sx, pointer.y - hit.sy))) hit = { b, sx, sy, r };
    }
    if (hit) {
      const b = hit.b;
      const verdict = b.mass > me.mass ? "absorbs you" : b.mass < me.mass ? "food" : "equal";
      ctx.font = "12px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillStyle = `hsla(${hueOf(b, me)} / 0.95)`;
      const label = `${b.kind === "light" ? b.name + " · " : ""}${b.mass.toFixed(b.mass < 10 ? 1 : 0)} · ${verdict}`;
      ctx.fillText(label, hit.sx, hit.sy + hit.r + 16);
      ctx.strokeStyle = `hsla(${hueOf(b, me)} / 0.6)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(hit.sx, hit.sy, hit.r + 2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Aim: a line from me to the cursor with the burn strength as its brightness.
  if (me.alive && pointer.inside && state.status === "playing") {
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

// ---------- hud ----------

function hud(): void {
  const me = human(state);
  lightEl.textContent = me.mass.toFixed(me.mass < 10 ? 1 : 0);
  const ranked = state.bodies
    .filter((b) => b.kind === "light")
    .sort((a, b) => b.mass - a.mass);
  rankEl.innerHTML = ranked
    .map((b) => `<span style="color:hsl(${identity(b)})${b.alive ? "" : ";opacity:.35;text-decoration:line-through"}"><b>${b.name}</b> ${b.mass.toFixed(1)}</span>`)
    .join("");
  levelEl.textContent = `${cfg.players - 1} rival${cfg.players - 1 === 1 ? "" : "s"} · ${state.time.toFixed(0)}s · seed ${seed}`;
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
      if (pointer.down) burnToward();
      step(state, cfg, DT, ev);
      onEvents(ev);
    }
    acc -= DT;
  }
  updateCamera(elapsed);
  draw(elapsed);
  hud();
  requestAnimationFrame(frame);
}
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
say(`seed ${seed} · ${cfg.players - 1} rivals`);

// Debug hook for headless checks.
(window as unknown as { __lumen: unknown }).__lumen = { cam, get state() { return state; }, cfg };
