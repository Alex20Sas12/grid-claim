"""E2E test — bot vs bot match on live Worker."""
import json, urllib.request, sys, time

BASE = "https://grid-claim.shablony-pro.workers.dev"

def req(method, path, body=None):
    data = json.dumps(body).encode() if body else None
    hdrs = {"User-Agent": "gridclaim-e2e/1.0"}
    if body is not None:
        hdrs["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=hdrs)
    with urllib.request.urlopen(r, timeout=15) as resp:
        return json.loads(resp.read())

# 1) rules & health
assert req("GET", "/health")["ok"] is True
rules = req("GET", "/rules")
assert rules["board"] == "8x8"

# 2) create a 4-bot match
m = req("POST", "/match/create", {"players": ["bot"] * 4})
assert m["status"] == "live", m
mid = m["id"]
print("match", mid, "code", m["code"])

# 3) loop bot moves until finished
turns = 0
while m["status"] == "live":
    mv = req("GET", f"/bot/choose?match={mid}&actor={m['current']}")
    assert mv and mv["x"] is not None, mv
    m2 = req("POST", f"/match/{mid}/bot", {"actor": m["current"]})
    m = m2
    turns += 1
    if turns > 200:
        raise AssertionError("loop too long")

print("turns:", turns, "winner:", m["winner"], "status:", m["status"])
counts = {}
for row in m["board"]:
    for v in row:
        if v: counts[v] = counts.get(v, 0) + 1
print("final counts:", counts)

# 4) validate final state
assert m["status"] == "finished"
assert m["winner"] is not None or turns >= 60  # either a winner or the turn cap
if m["winner"]:
    assert counts.get(m["winner"], 0) >= 15 or turns >= 60

# 5) log integrity
log = m["log"]
assert len(log) == turns, (len(log), turns)
for i, mv in enumerate(log, 1):
    assert mv["seq"] == i
    assert mv["turn"] == i
    assert mv["actor"] in m["players"][0]["id"] or any(mv["actor"] == p["id"] for p in m["players"])

# 6) illegal move rejected
m2 = req("POST", "/match/create", {"players": ["bot", "bot"]})
assert m2["current"] == "p0"
try:
    req("POST", f"/match/{m2['id']}", {"actor": "p1", "x": 0, "y": 0, "action": "place"})
    raise AssertionError("expected 409 for wrong turn")
except urllib.error.HTTPError as e:
    assert e.code == 409, e.code

print("PASS all e2e")
