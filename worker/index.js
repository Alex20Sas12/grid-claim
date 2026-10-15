// GridClaim — Cloudflare Worker backend + UI.
// Turn-based 2-4 player strategy game on 8x8 grid. Human + agent. 15 cells to win.

const BOARD_N = 8;
const WIN_CELLS = 15;
const MAX_TURNS = 60;
const MAX_SEEDS = 4;
const SEED_BONUS_EVERY = 8;
const MATCH_TTL = 86400; // 24h

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b"];

// ---------- helpers ----------
const rnd = (n, cs = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") => {
  let s = "";
  for (let i = 0; i < n; i++) s += cs[Math.floor(Math.random() * cs.length)];
  return s;
};

const emptyBoard = () => Array.from({ length: BOARD_N }, () => Array(BOARD_N).fill(""));

const neighbors = (x, y) => {
  const out = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && nx < BOARD_N && ny >= 0 && ny < BOARD_N) out.push([nx, ny]);
  }
  return out;
};

const isPlace = (m, pid, x, y) =>
  x >= 0 && x < BOARD_N && y >= 0 && y < BOARD_N && m.board[y][x] === "";

const isSpread = (m, pid, x, y) => {
  if (!(x >= 0 && x < BOARD_N && y >= 0 && y < BOARD_N && m.board[y][x] === "")) return false;
  return neighbors(x, y).some(([nx, ny]) => m.board[ny][nx] === pid);
};

const counts = (m) => {
  const c = {};
  for (const p of m.players) c[p.id] = 0;
  for (const row of m.board) for (const v of row) if (v) c[v] = (c[v] || 0) + 1;
  return c;
};

const newMatch = (kinds) => {
  const id = "m_" + rnd(8);
  const code = rnd(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789").toUpperCase();
  const players = kinds.map((k, i) => ({ id: "p" + i, kind: k, color: COLORS[i] }));
  return {
    id, code, players,
    seeds: Object.fromEntries(players.map(p => [p.id, MAX_SEEDS])),
    board: emptyBoard(),
    turn: 0,
    current: players[0].id,
    status: "live",
    winner: null,
    createdAt: Math.floor(Date.now() / 1000),
    log: [],
  };
};

const advanceTurn = (m) => {
  const ids = m.players.map(p => p.id);
  const cur = ids.indexOf(m.current);
  m.current = ids[(cur + 1) % ids.length];
  if (m.turn % SEED_BONUS_EVERY === 0) {
    for (const pid of ids) m.seeds[pid] = (m.seeds[pid] || 0) + 1;
  }
};

const applyMove = (m, actor, x, y, action) => {
  m.board[y][x] = actor;
  m.turn += 1;
  m.log.push({
    seq: m.log.length + 1,
    turn: m.turn,
    actor,
    action,
    x, y,
    counts: counts(m),
    ts: Math.floor(Date.now() / 1000),
  });
  const c = counts(m);
  if ((c[actor] || 0) >= WIN_CELLS) { m.status = "finished"; m.winner = actor; return; }
  if (m.turn >= MAX_TURNS) {
    const top = Math.max(...Object.values(c));
    const winners = Object.entries(c).filter(([, v]) => v === top).map(([k]) => k);
    m.status = "finished";
    m.winner = winners.length === 1 ? winners[0] : null;
    return;
  }
  advanceTurn(m);
};

const agentPick = (m, pid) => {
  const empties = [];
  const spreads = [];
  for (let y = 0; y < BOARD_N; y++) for (let x = 0; x < BOARD_N; x++) {
    if (m.board[y][x] !== "") continue;
    empties.push([x, y]);
    if (isSpread(m, pid, x, y)) spreads.push([x, y]);
  }
  const cx = (BOARD_N - 1) / 2, cy = (BOARD_N - 1) / 2;
  const dist = p => (Math.abs(p[0] - cx) + Math.abs(p[1] - cy));
  const byDist = arr => arr.slice().sort((a, b) => dist(a) - dist(b));

  if (m.seeds[pid] <= 0) {
    if (!spreads.length) return null;
    const [x, y] = spreads[Math.floor(Math.random() * spreads.length)];
    return { x, y, action: "spread" };
  }
  // Early: consolidate around existing territory.
  if (spreads.length && (m.turn < 6 || spreads.length <= 2)) {
    const [x, y] = spreads[Math.floor(Math.random() * spreads.length)];
    return { x, y, action: "spread" };
  }
  // Mid/late: mix — mostly spread, occasionally grab new territory.
  if (spreads.length && Math.random() < 0.6) {
    const [x, y] = spreads[Math.floor(Math.random() * spreads.length)];
    return { x, y, action: "spread" };
  }
  const sorted = byDist(empties);
  const [x, y] = sorted[Math.floor(Math.random() * Math.min(4, sorted.length))];
  return { x, y, action: "place" };
};

// ---------- router ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent",
  "Cache-Control": "no-store",
};

// ponytail: KV has a 10 write rps/namespace limit on free tier; retry briefly instead
// of returning 429 to the client. Upgrade path: R2 or Durable Objects if matches get hot.
async function kvPut(env, key, value) {
  for (let i = 0; ; i++) {
    try {
      await env.GAMES.put(key, value, { expirationTtl: MATCH_TTL });
      return;
    } catch (e) {
      const parts = [
        (e && e.message) || "",
        (e && e.cause && (e.cause.message || String(e.cause))) || "",
        String(e),
      ].join(" | ");
      const is429 = /429|Too Many Requests/i.test(parts);
      if (is429 && i < 30) {
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 200));
        continue;
      }
      throw new Error("KV PUT failed: " + parts);
    }
  }
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const notFound = (msg = "not found") => json({ error: msg }, 404);
const bad = (msg, status = 400) => json({ error: msg }, status);

// ---------- HTML (single-page game UI) ----------
const GAME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GridClaim — 8×8 Turn-Based Strategy</title>
<style>
* { box-sizing: border-box }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; color: #111827; background: #f3f4f6; }
.wrap { max-width: 960px; margin: 0 auto; padding: 24px 20px 80px; }
h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }
.tag { color: #6b7280; font-size: 13px; margin-bottom: 16px; }
.card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 12px 0; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button, input, select { font: inherit; }
button { padding: 8px 14px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
button.primary { background: #111827; color: #fff; border-color: #111827; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
input, select { padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; }
.board { display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; max-width: 480px; margin: 12px auto; aspect-ratio: 1; }
.cell { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; cursor: pointer; position: relative; transition: transform 80ms ease; }
.cell:hover { transform: translateY(-1px); }
.cell.mine { box-shadow: inset 0 0 0 2px #111827; }
.player { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 8px; }
.player.active { background: #fef3c7; }
.dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.small { font-size: 12px; color: #6b7280; }
#log { max-height: 200px; overflow-y: auto; font-family: ui-monospace, monospace; font-size: 12px; }
.log-row { display: flex; gap: 8px; padding: 2px 0; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: #e5e7eb; color: #374151; }
.pill.live { background: #dcfce7; color: #166534; }
.pill.done { background: #fee2e2; color: #991b1b; }
code, pre { font-family: ui-monospace, monospace; background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 12px; }
pre { padding: 10px; overflow-x: auto; }
a { color: #2563eb; }
.api-block { background: #0f172a; color: #e2e8f0; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.api-block b { color: #fbbf24; }
.api-block .g { color: #4ade80; }
.footer { color: #6b7280; font-size: 12px; text-align: center; margin-top: 32px; }
@media (max-width: 520px) { h1 { font-size: 22px } .cell { font-size: 9px; } }
</style></head><body>
<div class="wrap">
  <h1>GridClaim</h1>
  <div class="tag">8×8 turn-based territory game for humans and agents. First to 15 cells wins.</div>

  <div class="card">
    <div class="row">
      <label><b>Players</b></label>
      <select id="pcount">
        <option value="2">2</option><option value="3">3</option><option value="4">4</option>
      </select>
      <button id="start-h" class="primary">Start as human</button>
      <button id="start-a">Start as agent</button>
      <button id="start-bot">Full-bot match</button>
      <span class="small" id="hint"></span>
    </div>
    <div class="row" style="margin-top:10px">
      <label><b>Join by code</b></label>
      <input id="join-code" size="8" maxlength="6" placeholder="ABC123">
      <button id="join">Join</button>
      <input id="join-as" value="p0" placeholder="p0 / p1 / …">
      <button id="join-go" class="primary">Enter</button>
    </div>
  </div>

  <div class="card" id="game" style="display:none">
    <div class="row" style="justify-content:space-between">
      <div>
        <div><b>Match</b> <code id="mid"></code></div>
        <div><b>Code</b> <code id="mcode" style="font-size:14px"></code></div>
      </div>
      <div class="row">
        <span id="turn-count" class="pill"></span>
        <span id="status" class="pill live">live</span>
      </div>
    </div>
    <div id="players" class="row" style="margin:10px 0"></div>
    <div class="board" id="board"></div>
    <div class="row">
      <button id="bot-move">Bot moves</button>
      <button id="agent-move">Agent moves</button>
      <button id="new">New match</button>
      <span class="small">Click any empty cell on your turn. PLACE uses a seed, SPREAD is next to your own cell.</span>
    </div>
    <div id="log"></div>
  </div>

  <div class="card">
    <h2 style="margin-top:0">Rules</h2>
    <p>GridClaim is a territory game played on an <b>8×8 grid</b> (64 cells). <b>2-4 players</b> take turns. Each move you either <b>PLACE</b> a fresh cell (uses a seed — you start with 4) or <b>SPREAD</b> by placing orthogonally adjacent to your own existing cell. First to <b>15 cells</b> wins. Matches auto-end at 60 turns. Every 8 total turns, every player gains +1 seed, so you're never fully cut off. There's always a real choice: spread to consolidate, place to grab new territory, or block a rival's growth.</p>
  </div>

  <div class="card">
    <h2 style="margin-top:0">API for agents</h2>
    <p class="small">Base URL: <code id="base"></code>. All endpoints return JSON.</p>
    <div class="api-block">
GET  /rules                — full rule summary
GET  /health               — {ok: true}
GET  /match/by-code?code=  — snapshot by lobby code
GET  /match/:id            — full snapshot + move log
POST /match/create         — {players:["human","bot","agent"]}  — creates a live match
POST /match/:id            — {actor:"p1", x:3, y:2, action:"spread"|"place"}
    </div>
    <p class="small" style="margin-top:8px"><b>Sample bot (Node.js, no deps):</b></p>
    <pre>const b="<span id="base2"></span>";
async function get(url){ const r=await fetch(b+url); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function post(url, body){ return await fetch(b+url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json()); }

// create a 2-player match with an agent in seat p1
const m = await post("/match/create", {players:["bot","agent"]});

// one move per turn until finished
while (m.status === "live") {
  const move = await get("/bot/choose?"+"match="+m.id+"&actor="+m.current);
  if (m.current === "p1") {
    m2 = await post("/match/"+m.id, {actor:"p1", x:move.x, y:move.y, action:move.action});
  } else {
    m2 = await post("/match/"+m.id+"/bot", {actor:"p0"});
  }
  m = m2;
}
console.log(m.winner, "wins with", m.turn, "moves");</pre>
  </div>

  <div class="footer">GridClaim · MIT · <a id="repo" href="#">source</a></div>
</div>

<script>
const B = document.getElementById("base").textContent;
document.getElementById("base2").textContent = B;
let M = null, AS_HUMAN = false;

const $ = id => document.getElementById(id);
const el = id => $(id);

async function api(url, body){
  const opt = body ? {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)} : {};
  const r = await fetch(B + url, opt);
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

function renderPlayers(){
  const box = el("players"); box.innerHTML = "";
  const c = M.counts || countsClient(M.board);
  for(const p of M.players){
    const d = document.createElement("div");
    d.className = "player" + (p.id === M.current ? " active" : "");
    d.innerHTML = '<span class="dot" style="background:'+p.color+'"></span> <b>'+p.id+'</b> <span class="small">(' + p.kind + ')</span> · ' + (c[p.id]||0) + ' cells · seeds ' + (M.seeds[p.id]||0);
    box.appendChild(d);
  }
}

function countsClient(board){
  const c = {};
  for(const p of M.players) c[p.id]=0;
  for(const row of board) for(const v of row) if(v) c[v]=(c[v]||0)+1;
  return c;
}

function renderBoard(){
  const box = el("board"); box.innerHTML = "";
  for(let y=0;y<8;y++) for(let x=0;x<8;x++){
    const d = document.createElement("div");
    d.className = "cell";
    const v = M.board[y][x];
    if(v){
      const p = M.players.find(pp => pp.id === v);
      d.style.background = p.color;
      d.style.color = "#fff";
      d.textContent = v;
    }
    if(M.status === "live" && M.current === "p0" && !v && AS_HUMAN){
      d.classList.add("mine");
      d.onclick = async () => {
        // determine action: spread if adjacent to own; else place
        const spread = neighborsClient(x,y).some(([nx,ny]) => M.board[ny][nx] === "p0");
        try {
          M = await api("/match/" + M.id, {actor:"p0", x, y, action: spread ? "spread" : "place"});
          render();
        } catch (e) { alert(e.message); }
      };
    }
    box.appendChild(d);
  }
}

function neighborsClient(x,y){
  const out=[];
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const nx=x+dx, ny=y+dy;
    if(nx>=0&&nx<8&&ny>=0&&ny<8) out.push([nx,ny]);
  }
  return out;
}

function renderLog(){
  const box = el("log");
  box.innerHTML = (M.moves||M.log||[]).map(m =>
    '<div class="log-row"><b>#'+m.seq+'</b> <code>'+m.actor+'</code> '+m.action+' ('+m.x+','+m.y+') <span class="small">t'+m.turn+'</span></div>'
  ).join("");
  box.scrollTop = box.scrollHeight;
}

function render(){
  if(!M) return;
  el("mid").textContent = M.id;
  el("mcode").textContent = M.code;
  el("turn-count").textContent = "turn " + M.turn + " / " + (M.players.length);
  const s = el("status");
  s.textContent = M.status;
  s.className = "pill " + (M.status === "live" ? "live" : "done");
  if(M.winner){
    s.textContent = "won: " + M.winner;
  }
  renderPlayers();
  renderBoard();
  renderLog();
}

function startMatch(kinds){
  return api("/match/create", {players: kinds}).then(m => {
    M = m; AS_HUMAN = kinds.includes("human") ? true : false;
    el("game").style.display = "block";
    el("hint").textContent = "";
    render();
    window.location.hash = m.id;
  });
}

el("start-h").onclick = async () => {
  const n = +el("pcount").value;
  const kinds = ["human", ...Array(n-1).fill("bot")];
  await startMatch(kinds);
};
el("start-a").onclick = async () => {
  const n = +el("pcount").value;
  const kinds = ["agent", ...Array(n-1).fill("bot")];
  await startMatch(kinds);
};
el("start-bot").onclick = async () => {
  const n = +el("pcount").value;
  const kinds = Array(n).fill("bot");
  await startMatch(kinds);
};
el("join").onclick = () => {};
el("join-go").onclick = async () => {
  const code = el("join-code").value.trim().toUpperCase();
  const as = el("join-as").value.trim() || "p0";
  const m = await api("/match/by-code?code=" + encodeURIComponent(code));
  M = m; AS_HUMAN = (as === "p0");
  el("game").style.display = "block";
  render();
  window.location.hash = m.id;
};
el("new").onclick = () => { M = null; el("game").style.display="none"; location.hash = ""; };
el("bot-move").onclick = async () => {
  if(!M || M.status !== "live") return;
  try { M = await api("/match/" + M.id + "/bot", {actor: M.current}); render(); } catch(e){ alert(e.message); }
};
el("agent-move").onclick = async () => {
  if(!M || M.status !== "live") return;
  try {
    const mv = await api("/bot/choose?match=" + M.id + "&actor=" + M.current);
    M = await api("/match/" + M.id, {actor: M.current, x: mv.x, y: mv.y, action: mv.action});
    render();
  } catch(e){ alert(e.message); }
};

// load from hash if present
(function(){
  const h = (location.hash || "").replace(/^#/,"");
  if(h.startsWith("m_")){
    api("/match/" + h).then(m => {
      M = m; AS_HUMAN = (m.players.find(p => p.kind === "human") ? true : false);
      el("game").style.display = "block";
      render();
    }).catch(e => el("hint").textContent = "load failed: " + e.message);
  }
})();
</script>
</body></html>`;

// ---------- bot route: choose a move ----------
const chooseMove = async (env, m, actor) => {
  const mv = agentPick(m, actor);
  if (!mv) return bad("no legal moves for " + actor, 409);
  return mv;
};

// ---------- main fetch ----------
export default {
  async fetch(req, env) {
    try {
      return await this.handle(req, env);
    } catch (e) {
      return json({ error: "worker error: " + (e && e.message ? e.message : String(e)) }, 500);
    }
  },
  async handle(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = CORS;

    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    // ---- static UI ----
    if (req.method === "GET" && (path === "/" || path === "/game" || path === "/index.html")) {
      return new Response(GAME_HTML, { headers: { ...cors, "Content-Type": "text/html; charset=utf-8" } });
    }

    // ---- health & rules ----
    if (req.method === "GET" && path === "/health") return json({ ok: true, game: "GridClaim", version: 1 });
    if (req.method === "GET" && path === "/rules") {
      return json({
        name: "GridClaim",
        board: BOARD_N + "x" + BOARD_N,
        win: "First to " + WIN_CELLS + " cells",
        seeds: "start " + MAX_SEEDS + ", +1 every " + SEED_BONUS_EVERY + " turns",
        turnCap: MAX_TURNS,
        actions: ["place", "spread"],
        api: [
          "GET  /health",
          "GET  /rules",
          "GET  /match/by-code?code=XXX",
          "GET  /match/:id",
          "POST /match/create {players:[\"human\",\"bot\",\"agent\"]}",
          "POST /match/:id      {actor:\"p1\", x:3, y:2, action:\"spread\"|\"place\"}",
          "POST /match/:id/bot  {actor?} — bot auto-plays one move for current turn (or specified actor)",
          "GET  /bot/choose?match=<id>&actor=<pid> — returns {x,y,action} without applying",
        ],
      });
    }

    // ---- bot helpers ----
    if (req.method === "GET" && path === "/bot/choose") {
      const mid = url.searchParams.get("match");
      const actor = url.searchParams.get("actor");
      if (!mid || !actor) return bad("match and actor required");
      const m = await env.GAMES.get(mid);
      if (!m) return notFound("match");
      const snap = JSON.parse(m);
      const mv = await chooseMove(env, snap, actor);
      if (mv instanceof Response) return mv;
      return json(mv);
    }

    // ---- match routes ----
    if (path === "/match" || path.startsWith("/match/")) {
      const parts = path.split("/");
      // POST /match/create
      if (req.method === "POST" && parts.length === 3 && parts[2] === "create") {
        const body = await req.json().catch(() => ({}));
        let kinds = body.players || ["human", "bot"];
        if (!Array.isArray(kinds) || kinds.length < 2 || kinds.length > 4) return bad("players must be 2-4");
        for (const k of kinds) if (!["human", "agent", "bot"].includes(k)) return bad("bad kind: " + k);
        const m = newMatch(kinds);
        await kvPut(env, m.id, JSON.stringify(m));
        return json(m, 201);
      }
      // GET /match/:id
      const mid = parts[2];
      if (!mid) return notFound();
      if (req.method === "GET") {
        const raw = await env.GAMES.get(mid);
        if (!raw) return notFound("match");
        return json(JSON.parse(raw));
      }
      // POST /match/:id/bot  — auto-play one move for current turn
      if (req.method === "POST" && parts.length === 4 && parts[3] === "bot") {
        try {
          const raw = await env.GAMES.get(mid);
          if (!raw) return notFound("match");
          const m = JSON.parse(raw);
          if (m.status !== "live") return bad("match not live", 409);
          const rawBody = await req.text().catch(() => "");
          let body = {};
          try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }
          const actor = body.actor || m.current;
          const snap = JSON.parse(JSON.stringify(m));
          const mv = await chooseMove(env, snap, actor);
          if (mv instanceof Response) return mv;
          if (mv.action === "place") {
            if ((m.seeds[actor] || 0) <= 0) return bad("no seeds", 400);
            m.seeds[actor] -= 1;
          }
          applyMove(m, actor, mv.x, mv.y, mv.action);
          await kvPut(env, mid, JSON.stringify(m));
          return json(m);
        } catch (e) {
          return bad("bot error: " + (e && e.message ? e.message : String(e)), 500);
        }
      }
      // POST /match/:id  — apply human/agent move
      if (req.method === "POST" && parts.length === 3) {
        const raw = await env.GAMES.get(mid);
        if (!raw) return notFound("match");
        const m = JSON.parse(raw);
        if (m.status !== "live") return bad("match not live", 409);
        const body = await req.json().catch(() => ({}));
        const actor = body.actor;
        const x = body.x, y = body.y;
        const action = body.action || "place";
        if (!actor || typeof x !== "number" || typeof y !== "number") return bad("actor,x,y required");
        if (m.current !== actor) return bad("not your turn", 409);
        if (action === "spread") {
          if (!isSpread(m, actor, x, y)) return bad("illegal spread", 400);
        } else if (action === "place") {
          if (!(x >= 0 && x < BOARD_N && y >= 0 && y < BOARD_N && m.board[y][x] === "")) return bad("illegal place", 400);
          if ((m.seeds[actor] || 0) <= 0) return bad("no seeds", 400);
          m.seeds[actor] -= 1;
        } else return bad("bad action", 400);
        applyMove(m, actor, x, y, action);
        await kvPut(env, mid, JSON.stringify(m));
        return json(m);
      }
      return notFound();
    }

    return notFound();
  },
};
