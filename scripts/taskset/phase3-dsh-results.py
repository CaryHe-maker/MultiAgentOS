"""Collects the dsh control runs of phase 3 (~/bench/p3dsh) into phase3-dsh-results.json: per task the set it
belongs to, the agent time, the score, requests, tokens and the cost by the project's price table (USD per
million tokens: cache hit 0.003, miss 0.15, output 0.60). Raw logs stay in ~/bench/p3dsh.
Usage (in WSL): python3 phase3-dsh-results.py
"""

import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.expanduser("~/bench/p3dsh")
sealed = json.load(open(os.path.join(HERE, "phase3.json")))
where = {}
for lst in ("finalSmall", "finalLarge", "devSmall", "devLarge"):
    for t in sealed[lst]:
        where.setdefault(t["id"], f"{lst}:{t.get('role', 'dev')}")


def cost(u):
    return round((u.get("cacheRead", 0) * 0.003 + (u.get("input", 0) + u.get("cacheWrite", 0)) * 0.15
                  + u.get("output", 0) * 0.60) / 1e6, 4)


def key_for(task_name):
    for tid in where:
        if tid.split("/", 1)[-1] == task_name or tid.endswith("/" + task_name):
            return tid
    return task_name


runs = []
for line in open(os.path.join(RUNS, "small.jsonl")):
    j = json.loads(line)
    u = j.get("usage") or {}
    tid = key_for(j["task"])
    runs.append({"id": tid, "set": where.get(tid), "harness": "agentrun", "at": j["at"], "agentSeconds": j.get("agentSeconds"),
                 "score": j.get("reward"), "timedOut": j.get("agentTimedOut"), "exit": j.get("agentExit"),
                 "offline": j.get("offline", False), "requests": u.get("requests"), "tokens": u, "usd": cost(u),
                 "runId": j["runId"]})
for f in sorted(glob.glob(os.path.join(RUNS, "results", "p3dsh-*", "**", "dsh-usage.json"), recursive=True)):
    task = f.split("/results/")[1].split("/")[0][len("p3dsh-"):]
    u = json.load(open(f))
    harness, score = None, None
    lb = os.path.join(RUNS, "results", f"p3dsh-{task}", "results.json")
    if os.path.exists(lb):
        harness = "loopsbench"
        r = json.load(open(lb))
        r = (r.get("results") or [r])[0]
        score = r.get("is_resolved")
    for p in glob.glob(os.path.join(RUNS, "results", f"p3dsh-{task}", "*", "result.json")):
        harness = "pier"
        score = ((json.load(open(p)).get("verifier_result") or {}).get("rewards") or {}).get("reward")
    tid = ("lb/" if harness == "loopsbench" else "deepswe/") + task
    rounds = [r for r in runs if r["id"] == tid]
    entry = rounds[0] if rounds else None
    if entry:  # LoopsBench may run several rounds; add them up
        entry["agentSeconds"] = round(entry["agentSeconds"] + u["seconds"], 1)
        for k, v in u["usage"].items():
            entry["tokens"][k] = entry["tokens"].get(k, 0) + v
        entry["requests"] = entry["tokens"]["requests"]
        entry["usd"] = cost(entry["tokens"])
        continue
    runs.append({"id": tid, "set": where.get(tid), "harness": harness, "agentSeconds": u["seconds"], "score": score,
                 "timedOut": u.get("timedOut"), "requests": u["usage"]["requests"], "tokens": u["usage"],
                 "usd": cost(u["usage"]), "runId": u["runId"]})
voided = [l.strip() for l in open(os.path.join(RUNS, "voided", "README.txt"))] if os.path.exists(
    os.path.join(RUNS, "voided", "README.txt")) else []
replacements = [l.strip() for l in open(os.path.join(RUNS, "replacements.log"))]
out = {"note": "one dsh run per task (deepseek-flash, neutral prompt); agentSeconds is the agent's own time",
       "totalUsd": round(sum(r["usd"] for r in runs), 3), "runs": runs, "voided": voided,
       "replacements": replacements}
json.dump(out, open(os.path.join(HERE, "phase3-dsh-results.json"), "w"), indent=1, ensure_ascii=False)
print(len(runs), "runs, total", out["totalUsd"], "USD")
for r in runs:
    if r["set"] is None:
        print("  not in any set:", r["id"])
