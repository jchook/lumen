import { newGame, step, defaultConfig, ORB, VOID, type GameState, type SimConfig } from "../src/sim";
type Policy = (s: GameState, cfg: SimConfig) => number;
const live = (s: GameState) => s.orbs.filter(o=>o.radius<=s.player.radius);
const nearest: Policy = (s) => live(s).sort((a,b)=>Math.hypot(a.x-s.player.x,a.y-s.player.y)-Math.hypot(b.x-s.player.x,b.y-s.player.y))[0]!.id;
const greedy: Policy = (s) => live(s).sort((a,b)=>ORB[b.kind].value-ORB[a.kind].value)[0]!.id;
const random: Policy = (s) => { const c=live(s); return c[Math.floor(Math.random()*c.length)]!.id; };
const planner: Policy = (s, cfg) => {
  let best=-Infinity, id=live(s)[0]!.id;
  for (const o of live(s)) { const r=step(s,o.id,cfg); const v = r.state.status==="over" && r.state.light>=0 && live(r.state).length>0 ? -1e9 : r.state.status==="over" && r.state.light<0 ? -1e9 : r.state.light - s.light; if (v>best){best=v;id=o.id;} }
  return id;
};
const pols = {random, nearest, greedy, planner};
const label = (c: Partial<SimConfig>) => Object.entries(c).map(([k,v])=>`${k}=${v}`).join(" ") || "defaults";
for (const over of [{}, {spawnFade: 40}, {spawnFade: 90}, {travelCost: 1.5}, {travelCost: 0.75}]) {
  const cfg = { ...defaultConfig, ...over };
  const rows: string[] = [];
  for (const [name, pol] of Object.entries(pols)) {
    const N=120, MAX=400; const turns:number[]=[]; const scores:number[]=[]; const why: Record<string,number> = {};
    for (let seed=1; seed<=N; seed++) {
      let s=newGame(seed,cfg); let reason="cap";
      while (s.status==="playing" && s.turn<MAX) { const r=step(s,pol(s,cfg),cfg); s=r.state; const b=r.events.find(e=>e.type==="blackout"); if (b && b.type==="blackout") reason=b.reason; }
      why[reason]=(why[reason]??0)+1; turns.push(s.turn); scores.push(s.score);
    }
    turns.sort((a,b)=>a-b); scores.sort((a,b)=>a-b);
    rows.push(`  ${name.padEnd(8)} taps p25/50/75 ${turns[N>>2]}/${turns[N>>1]}/${turns[(3*N)>>2]}  score p50 ${scores[N>>1]} p90 ${scores[Math.floor(N*0.9)]}  ends: ${Object.entries(why).map(([k,v])=>`${k} ${v}`).join(", ")}`);
  }
  console.log(`${label(over)}\n${rows.join("\n")}`);
}
