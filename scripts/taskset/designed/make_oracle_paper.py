"""Builds the oracle paper.md of a designed survey task: real references (metadata fetched from Crossref
and arXiv, so they verify) in a skeleton that meets every structural rule, with filler prose. It checks
the grader, not writing quality.
Usage: python3 make_oracle_paper.py <task dir> <candidate ids file>   (one `doi:...` or `arXiv:...` per line)
"""

import json
import os
import sys

task = sys.argv[1]
sys.path.insert(0, os.path.join(task, "tests"))
import grade_paper as g  # noqa: E402

topic = json.load(open(os.path.join(task, "tests", "topic.json")))
refs = []
for line in open(sys.argv[2]):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    kind, ident = line.split(":", 1)
    try:
        meta = g.lookup_doi(ident) if kind.lower() == "doi" else g.lookup_arxiv(ident)
    except ConnectionError:
        meta = None
    if meta is None or not meta["years"]:
        print("skip", line, file=sys.stderr)
        continue
    year = max(meta["years"]) if kind.lower() == "arxiv" else min(meta["years"])
    if kind.lower() == "arxiv":
        year = min(meta["years"])
    venue = "arXiv preprint" if kind.lower() == "arxiv" else "Journal or proceedings"
    ident_text = f"arXiv:{ident}" if kind.lower() == "arxiv" else f"doi:{ident}"
    refs.append(f"{meta['first']} et al. {meta['title']}. {venue}, {year}. {ident_text}")
print(len(refs), "references", file=sys.stderr)
n = len(refs)
filler = "本节按照技术路线梳理相关研究的思想、方法与局限，并分析它们之间的联系与差异。" * 4
heads = topic["oracle_sections"]
out = [f"# {topic['title']}", "", "## 摘要", "", "本文" + "围绕题目梳理已有研究的主要方法、代表工作与开放问题。" * 10, "",
       "**关键词**：" + "；".join(topic["keywords"]), "", "## 1 引言", ""]
chunks = [list(range(i, n + 1, 3)) for i in (1, 2, 3)]
for _ in range(25):
    out += [filler + "".join(f"[{k}]" for k in range(1, n + 1, 7)), ""]
for s, (title, subs) in enumerate(heads, start=2):
    out += [f"## {s} {title}", ""]
    for t, sub in enumerate(subs, start=1):
        out += [f"### {s}.{t} {sub}", ""]
        for _ in range(12):
            out += [filler + "".join(f"[{k}]" for k in chunks[(s - 2) % 3][t - 1::2]), ""]
out += ["| 方法 | 类别 | 说明 |", "| --- | --- | --- |"]
out += [f"| 方法{k} | 类别 | 代表工作 [{k}] |" for k in range(1, 13)]
d = len(heads) + 2
out += ["", f"## {d} 讨论与开放问题", "", filler * 3, "", f"## {d + 1} 结论", "", filler * 3, "", "## 参考文献", ""]
out += [f"[{k}] {e}" for k, e in enumerate(refs, start=1)]
os.makedirs(os.path.join(task, "solution"), exist_ok=True)
open(os.path.join(task, "solution", "paper.md"), "w", encoding="utf-8").write("\n".join(out) + "\n")
