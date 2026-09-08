import { newGame, round, defaultConfig, edibleTargets, ORB, human, type GameState, type SimConfig } from "../src/sim";
type Policy = (s: GameState, cfg: SimConfig) => number;
let CFG: SimConfig = defaultConfig;
const live = (s: GameState) => edibleTargets(s, human(s).id, CFG);
const nearest: Policy = (s) => live(s).sort((a,b)=>Math.hypot(a.x-human(s).x,a.y-human(s).y)-Math.hypot(b.x-human(s).x,b.y-human(s).y))[0]!.id;
const greedy: Policy = (s) => live(s).sort((a,b)=>ORB[b.kind].value-ORB[a.kind].value)[0]!.id;
const random: Policy = (s) => { const c=live(s); return c[Math.floor(Math.random()*c.length)]!.id; };
const planner: Policy = (s, cfg) => {
  let best=-Infinity, id=live(s)[0]!.id;
  for (const o of live(s)) { const r=round(s,o.id,cfg); const dead = r.events.some(e=>e.type==="blackout" && e.reason!=="dark"); const v = dead ? -1e9 : human(r.state).light - human(s).light; if (v>best){best=v;id=o.id;} }
  return id;
};
const pols = {random, nearest, greedy, planner};
const label = (c: Partial<SimConfig>) => Object.entries(c).map(([k,v])=>`${k}=${v}`).join(" ") || "defaults";
for (const over of [{opponents: 1, aiSkill: 0.1}, {opponents: 1, aiSkill: 0.4}, {opponents: 1, aiSkill: 0.7}, {opponents: 1, aiSkill: 1}, {opponents: 2, aiSkill: 0.5}]) {
  const cfg = { ...defaultConfig, ...over }; CFG = cfg;
  const rows: string[] = [];
  for (const [name, pol] of Object.entries(pols)) {
    const N=cfg.opponents>0 ? 40 : 120, MAX=400; const turns:number[]=[]; const scores:number[]=[]; const why: Record<string,number> = {};
    for (let seed=1; seed<=N; seed++) {
      let s=newGame(seed,cfg); let reason="cap";
      while (s.status==="playing" && s.turn<MAX) { if (!live(s).length) break; const r=round(s,pol(s,cfg),cfg); s=r.state; const b=r.events.find(e=>e.type==="blackout"); if (b && b.type==="blackout") reason=b.reason; if (s.status==="won") reason="won"; }
      why[reason]=(why[reason]??0)+1; turns.push(s.turn); scores.push(Math.round(human(s).score));
    }
    turns.sort((a,b)=>a-b); scores.sort((a,b)=>a-b);
    rows.push(`  ${name.padEnd(8)} taps p25/50/75 ${turns[N>>2]}/${turns[N>>1]}/${turns[(3*N)>>2]}  score p50 ${scores[N>>1]} p90 ${scores[Math.floor(N*0.9)]}  ends: ${Object.entries(why).map(([k,v])=>`${k} ${v}`).join(", ")}`);
  }
  console.log(`${label(over)}\n${rows.join("\n")}`);
}
