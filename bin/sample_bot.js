// Sample bot — plays GridClaim via the public HTTP API.
// Node 18+, zero dependencies.
//
//   node bin/sample_bot.js [serverUrl]
//   default serverUrl: https://grid-claim.shablony-pro.workers.dev

const B = process.argv[2] || "https://grid-claim.shablony-pro.workers.dev";
const ua = { headers: { "User-Agent": "gridclaim-sample-bot/1.0" } };

async function get(path) {
  const r = await fetch(B + path, ua);
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}: ${await r.text()}`);
  return r.json();
}
async function post(path, body, retries = 3) {
  for (let i = 0; ; i++) {
    const r = await fetch(B + path, {
      ...ua,
      method: "POST",
      headers: { ...ua.headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 429 && i < retries) {
      // KV rate-limit — back off and retry.
      const wait = 500 * (i + 1);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    if (!r.ok) throw new Error(`POST ${path} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
}

// --- a simple "agent" that follows the same heuristic as the built-in bot ---
async function chooseMove(match, actor) {
  const mv = await get(`/bot/choose?match=${encodeURIComponent(match.id)}&actor=${encodeURIComponent(actor)}`);
  return mv;
}

async function play() {
  const kinds = ["agent", "bot", "bot", "bot"];
  let m = await post("/match/create", { players: kinds });
  console.log(`Match ${m.id} (code ${m.code}): agent sits in p0.`);

  let turns = 0;
  while (m.status === "live") {
    const mv = await chooseMove(m, m.current);
    m = await post(`/match/${m.id}`, { actor: m.current, x: mv.x, y: mv.y, action: mv.action });
    turns++;
  }

  const counts = m.players.reduce((acc, p) => {
    acc[p.id] = 0;
    for (const row of m.board) for (const v of row) if (v === p.id) acc[p.id]++;
    return acc;
  }, {});
  console.log(`Winner: ${m.winner ?? "draw"} after ${turns} turns`);
  console.log("Final counts:", counts);
}

play().catch((e) => { console.error(e); process.exit(1); });
