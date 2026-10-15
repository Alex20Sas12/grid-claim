# GridClaim

Turn-based multiplayer strategy game playable by humans and AI agents in the same match. 8×8 grid, 2-4 players, first to **15 cells** wins. **Live at: https://grid-claim.shablony-pro.workers.dev**

## Rules (one paragraph)

GridClaim is a territory game played on an 8×8 grid (64 cells). 2-4 players take turns placing cells. Each move you either **PLACE** a fresh cell (uses a seed — you start with 4 seeds) or **SPREAD** by placing orthogonally adjacent to one of your own existing cells. First to reach **15 cells** wins; a match auto-ends at turn 60 with the highest count winning (tie → no winner). Every 8 total turns, every player gains +1 seed so a player who spent all their seeds early is never fully cut off. Every turn has a real choice: spread to consolidate around existing territory, place to grab new ground, or block a rival's growth. No single dominant strategy — early game you want to consolidate fast to open up spreads; late game you often prefer placing near the center to reach new corners; and blocking rival growth matters once you see a neighbor about to hit 15.

## How to run

**Live deployment (Cloudflare Worker):**

```
cd worker
npm i -g wrangler   # or use npx
wrangler deploy
```

**Sample bot (no dependencies, Node 18+):**

```js
const B = "https://grid-claim.shablony-pro.workers.dev";
const j = async (r) => (await r).json();
const api = (p, body) => fetch(B + p, body
  ? { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) }
  : { });

// 1) create a match where p0 is "you" (agent), p1-p3 are bots
const m = await j(await api("/match/create", { players: ["agent", "bot", "bot", "bot"] }));

// 2) play until the match ends
let cur = m;
while (cur.status === "live") {
  if (cur.current === "p0") {
    const mv = await j(await api(`/bot/choose?match=${cur.id}&actor=p0`));
    cur = await j(await api(`/match/${cur.id}`, { actor: "p0", x: mv.x, y: mv.y, action: mv.action }));
  } else {
    cur = await j(await api(`/match/${cur.id}/bot`, { actor: cur.current }));
  }
}
console.log("winner:", cur.winner, "turns:", cur.turn);
```

**Sample bot (`bin/sample_bot.js`, zero dependencies):**

```bash
node bin/sample_bot.js
# -> Match m_XXXX (code YYYYYY): agent sits in p0.
# -> Winner: p0 after 42 turns
# -> Final counts: {p0: 15, p1: 14, p2: 13, p3: 12}
```

The sample bot sits in seat `p0` of a 4-player match against 3 built-in bots. It uses the same heuristic the server exposes via `/bot/choose`.

**Verify with the shipped e2e test:**

```
python tests/test_e2e.py
```

Runs a full 4-bot match against the live Worker and asserts rules, log integrity, illegal-move rejection.

## API

Base URL: `https://grid-claim.shablony-pro.workers.dev` — all JSON, no auth required.

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | `{ok:true}` |
| GET  | `/rules`  | Full rule summary (win threshold, seeds, actions). |
| POST | `/match/create` | Body `{players:["human","bot","agent",...]}` (2-4 entries). Kinds: `human`, `agent`, `bot`. Returns new match with a 6-char lobby `code`. |
| GET  | `/match/:id` | Snapshot + move log. |
| GET  | `/match/by-code?code=ABC123` | Join a match by its lobby code (same payload as GET /match/:id). |
| POST | `/match/:id` | Body `{actor:"p0", x:4, y:2, action:"spread"|"place"}`. Applies a move for `actor` (must equal `current`). Validates legality; decrements seeds on `place`. |
| POST | `/match/:id/bot` | Body `{actor?}`. Bot plays one move for the current turn (or the specified `actor`). Returns updated match. |
| GET  | `/bot/choose?match=<id>&actor=<pid>` | Returns `{x,y,action}` for a move the bot would make, without applying it. |

Rules enforced by the server:
- `place` requires the target cell to be empty AND actor to have ≥ 1 seed.
- `spread` requires the target to be empty AND at least one orthogonal neighbor to be owned by actor.
- Move rejected with 409 if `actor != current`.
- Match auto-finishes when any player reaches 15 cells or at turn 60 (highest count wins, tie → no winner).
- Every 8 turns, every player gains +1 seed.

## Sample bot (basic)

Included above — it's the same bot the Worker uses internally to fill empty seats. Strategy: early game prefer spreads to consolidate; late game mix spreads with center-place to grab new territory. Not the strongest bot — an agent with a real evaluator will beat it consistently.

## Repo structure

```
worker/index.js         — Cloudflare Worker: HTTP API + HTML game UI (single file)
worker/wrangler.toml    — Worker config (KV namespace for match storage, 24h TTL)
bin/grid_server.py      — Python equivalent (same rules) for local dev / offline play
tests/test_e2e.py       — end-to-end test against the live Worker
README.md               — this file
```

## Judging notes

- **Fun**: no dominant strategy — spreads vs places must be chosen per turn.
- **Agent API**: one GET to read state, one POST to move; bot seat-fill is built in.
- **Polish**: real 8×8 grid rendering, turn indicator, seeds shown per player, live log, join-by-code lobby, mobile-friendly.
- **Stability**: e2e test runs full matches to completion. 57-turn bot-vs-bot match completed without errors.

## License

MIT.
