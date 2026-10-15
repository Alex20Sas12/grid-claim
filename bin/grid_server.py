"""GridClaim — turn-based multiplayer strategy game on an 8x8 grid.

2-4 players. Human + agent. 15 cells = win. Every turn a real choice:
place fresh or spread from your territory.

Run locally:  python grid_server.py            # -> http://localhost:8791
"""

from __future__ import annotations
import hashlib, json, os, random, re, string, time, uuid
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ------- Game rules ------------------------------------------------------
BOARD_N = 8
WIN_CELLS = 15          # claim >= 15 of 64 cells to win
MAX_TURNS = 60          # anti-stall ceiling
MAX_SEEDS = 4           # 1 seed per player; +1 every 8 turns for fairness
SEED_BONUS_EVERY = 8

# Player kinds: "human", "agent", "bot:<name>"
COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b"]

# ------- State -----------------------------------------------------------
_lock = None  # imported at bottom (threading.RLock)
_matches: dict[str, dict] = {}
_log: dict[str, list] = {}  # move log for replay
_log_seq: dict[str, int] = {}


def _new_id(prefix: str, n: int = 8) -> str:
    return prefix + "".join(random.choices(string.ascii_letters + string.digits, k=n))


def _new_match(players: list[dict]) -> dict:
    assert 2 <= len(players) <= 4
    m = {
        "id": _new_id("m", 6),
        "code": _new_id("", 6).upper(),
        "players": players,   # [{id, kind, color}]
        "seeds": {p["id"]: MAX_SEEDS for p in players},
        "board": [[0] * BOARD_N for _ in range(BOARD_N)],  # 0=empty, else player_id
        "turn": 0,             # total moves played
        "current": players[0]["id"],
        "status": "waiting",   # waiting | live | finished
        "winner": None,
        "createdAt": int(time.time()),
    }
    _matches[m["id"]] = m
    _log[m["id"]] = []
    _log_seq[m["id"]] = 0
    return m


def _neighbors(x: int, y: int):
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < BOARD_N and 0 <= ny < BOARD_N:
            yield nx, ny


def _legal_place(m, pid, x, y):
    return 0 <= x < BOARD_N and 0 <= y < BOARD_N and m["board"][y][x] == 0


def _legal_spread(m, pid, x, y):
    """Spread: place next to YOUR OWN existing territory cell (orthogonal)."""
    if not (0 <= x < BOARD_N and 0 <= y < BOARD_N and m["board"][y][x] == 0):
        return False
    return any(m["board"][ny][nx] == pid for nx, ny in _neighbors(x, y))


def _counts(m):
    c = {p["id"]: 0 for p in m["players"]}
    for row in m["board"]:
        for v in row:
            if v:
                c[v] = c.get(v, 0) + 1
    return c


def _record(m, actor: str, action: str, x: int, y: int):
    _log_seq[m["id"]] += 1
    _log[m["id"]].append({
        "seq": _log_seq[m["id"]],
        "turn": m["turn"],
        "actor": actor,
        "action": action,   # "place" | "spread"
        "x": x, "y": y,
        "counts": _counts(m),
        "ts": int(time.time()),
    })


def _apply_move(m, actor, x, y, kind="place"):
    assert m["board"][y][x] == 0
    m["board"][y][x] = actor
    m["turn"] += 1
    _record(m, actor, kind, x, y)
    counts = _counts(m)
    if counts.get(actor, 0) >= WIN_CELLS:
        m["status"] = "finished"
        m["winner"] = actor
        return m
    if m["turn"] >= MAX_TURNS:
        # draw at cap — highest count wins, tie -> None
        top = max(counts.values())
        winners = [pid for pid, v in counts.items() if v == top]
        m["status"] = "finished"
        m["winner"] = winners[0] if len(winners) == 1 else None
        return m
    # advance turn (skip finished/absent not needed here — all are active)
    ids = [p["id"] for p in m["players"]]
    cur = ids.index(m["current"])
    m["current"] = ids[(cur + 1) % len(ids)]
    # seed bonus every 8 total turns, to the player just finished
    if m["turn"] % SEED_BONUS_EVERY == 0:
        for pid in ids:
            m["seeds"][pid] += 1
    return m


def _find_spots(m, pid):
    """Empty cells where pid can place fresh (needs seeds>0) or spread."""
    out = []
    for y in range(BOARD_N):
        for x in range(BOARD_N):
            if m["board"][y][x] != 0:
                continue
            if _legal_place(m, pid, x, y) and m["seeds"].get(pid, 0) > 0:
                out.append((x, y, "place"))
            if _legal_spread(m, pid, x, y):
                out.append((x, y, "spread"))
    return out


def _agent_pick(m, pid):
    """Deterministic-ish strategy: prefer spreads next to own, else center-place."""
    if m["seeds"].get(pid, 0) <= 0:
        # must spread
        options = [(x, y) for y in range(BOARD_N) for x in range(BOARD_N)
                   if _legal_spread(m, pid, x, y)]
        if not options:
            return None
    else:
        # Try spread first if it grows our count meaningfully; else center-place.
        spreads = [(x, y) for y in range(BOARD_N) for x in range(BOARD_N)
                   if _legal_spread(m, pid, x, y)]
        empties = [(x, y) for y in range(BOARD_N) for x in range(BOARD_N)
                   if m["board"][y][x] == 0]
        if not spreads:
            if not empties:
                return None
            cx, cy = BOARD_N // 2 - 1, BOARD_N // 2 - 1
            best = min(empties, key=lambda p: (abs(p[0]-cx), abs(p[1]-cy)))
            return (best, "place")
        if m["turn"] < 6 or len(spreads) <= 2:
            # early: consolidate
            return (random.choice(spreads), "spread")
        # mix: 60% spread, 40% place to grab new territory
        if random.random() < 0.6:
            return (random.choice(spreads), "spread")
        if not empties:
            return (random.choice(spreads), "spread")
        cx, cy = BOARD_N // 2 - 1, BOARD_N // 2 - 1
        best = min(empties, key=lambda p: (abs(p[0]-cx), abs(p[1]-cy)))
        return (best, "place")
    return None


def public_match(m):
    return deepcopy(m)


# ------- HTTP -----------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):  # silence
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    # ---- ROUTES ----
    def do_GET(self):
        p = urlparse(self.path).path
        q = parse_qs(urlparse(self.path).query)
        if p in ("/", "/health"):
            return self._json({"ok": True, "game": "GridClaim", "board": BOARD_N, "win": WIN_CELLS})
        if p == "/rules":
            return self._json({
                "board": f"{BOARD_N}x{BOARD_N} = {BOARD_N*BOARD_N} cells",
                "win": f"First to claim >= {WIN_CELLS} cells wins",
                "moves": "PLACE (fresh, uses a seed) or SPREAD (orthogonal next to your own cell)",
                "seeds": f"start with {MAX_SEEDS}, +1 every {SEED_BONUS_EVERY} total turns",
                "turnCap": MAX_TURNS,
            })
        if p.startswith("/match/"):
            mid = p.split("/match/")[1]
            if mid == "list":
                return self._json([public_match(m) for m in _matches.values()])
            with _lock:
                m = _matches.get(mid)
            if not m:
                return self._json({"error": "not found"}, 404)
            with _lock:
                snap = public_match(m)
                snap["moves"] = list(_log[mid])
            return self._json(snap)
        if p == "/match/by-code":
            code = (q.get("code") or [""])[0].strip().upper()
            with _lock:
                hit = next((m for m in _matches.values() if m["code"] == code), None)
            if not hit:
                return self._json({"error": "not found"}, 404)
            with _lock:
                snap = public_match(hit)
                snap["moves"] = list(_log[hit["id"]])
            return self._json(snap)
        return self._json({"error": "nope"}, 404)

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/match/create":
            body = self._read()
            kinds = body.get("players") or ["human"]
            if not (2 <= len(kinds) <= 4):
                return self._json({"error": "2-4 players"}, 400)
            players = [{"id": f"p{i}", "kind": k, "color": COLORS[i]} for i, k in enumerate(kinds)]
            with _lock:
                m = _new_match(players)
                m["status"] = "live"
                snap = public_match(m)
            return self._json(snap, 201)
        if p.startswith("/match/"):
            mid = p.split("/match/")[1]
            with _lock:
                m = _matches.get(mid)
            if not m:
                return self._json({"error": "not found"}, 404)
            body = self._read()
            actor = body.get("actor") or body.get("player")
            x = body.get("x")
            y = body.get("y")
            kind = body.get("action", "place")   # place | spread
            with _lock:
                if m["status"] != "live":
                    return self._json({"error": "not live", "status": m["status"]}, 409)
                if m["current"] != actor:
                    return self._json({"error": "not your turn", "current": m["current"]}, 409)
                if kind == "spread":
                    ok = _legal_spread(m, actor, x, y)
                elif kind == "place":
                    ok = _legal_place(m, actor, x, y) and m["seeds"].get(actor, 0) > 0
                    if ok:
                        m["seeds"][actor] -= 1
                else:
                    return self._json({"error": "bad action"}, 400)
                if not ok:
                    return self._json({"error": "illegal move", "kind": kind, "x": x, "y": y}, 400)
                _apply_move(m, actor, x, y, kind)
                snap = public_match(m)
                snap["moves"] = list(_log[mid])
            return self._json(snap)
        return self._json({"error": "nope"}, 404)


if __name__ == "__main__":
    import threading
    global _lock
    _lock = threading.RLock()
    port = int(os.environ.get("PORT", "8791"))
    print(f"GridClaim server on http://localhost:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
