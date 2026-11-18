"""Builds the oracle paper.md (and annotations.md when the task asks for one) of a designed survey task:
real references (metadata fetched from Crossref and arXiv, so they verify) in a skeleton that meets
every structural rule of the task's limits, with filler prose. It checks the grader, not writing quality.
Usage: python3 make_oracle_paper.py <task dir> <candidate ids file>   (one `doi:...` or `arXiv:...` per line)
"""

import json
import os
import sys

task = sys.argv[1]
sys.path.insert(0, os.path.join(task, "tests"))
import grade_paper as g  # noqa: E402

topic = json.load(open(os.path.join(task, "tests", "topic.json"), encoding="utf-8"))
limits = {"min_chars": 12000, "min_tables": 1, "annotation_chars": 0, "min_cites": 8}
limits.update(topic.get("limits", {}))
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
    year = min(meta["years"])
    venue = "arXiv preprint" if kind.lower() == "arxiv" else "Journal or proceedings"
    ident_text = f"arXiv:{ident}" if kind.lower() == "arxiv" else f"doi:{ident}"
    refs.append(f"{meta['first']} et al. {meta['title']}. {venue}, {year}. {ident_text}")
print(len(refs), "references", file=sys.stderr)
n = len(refs)
covered = "、".join(group[0] for group in topic["must_cover"])
filler = "本节按照技术路线梳理相关研究的思想、方法与局限，并分析它们之间的联系与差异。" * 4
heads = topic["oracle_sections"]
mains = len(heads)
subs_total = sum(len(s) for _, s in heads)
# paragraphs per subsection so that the body reaches the required length (about 136 characters each)
per_sub = max(12, limits["min_chars"] // (136 * subs_total) + 2)
out = [f"# {topic['title']}", "", "## 摘要", "", "本文" + "围绕题目梳理已有研究的主要方法、代表工作与开放问题。" * 10, "",
       "**关键词**：" + "；".join(topic["keywords"]), "", "## 1 引言", "", f"本文涉及{covered}等内容。", ""]
for _ in range(25):
    out += [filler + "".join(f"[{k}]" for k in range(1, n + 1, 7)), ""]
for s, (title, subs) in enumerate(heads, start=2):
    mine = [k for k in range(1, n + 1) if (k - 1) % mains == s - 2]
    out += [f"## {s} {title}", ""]
    for t, sub in enumerate(subs, start=1):
        out += [f"### {s}.{t} {sub}", ""]
        part = mine[t - 1:: len(subs)]
        for _ in range(per_sub):
            out += [filler + "".join(f"[{k}]" for k in part), ""]
    if s - 2 < limits["min_tables"]:
        out += ["| 方法 | 类别 | 说明 |", "| --- | --- | --- |"]
        out += [f"| 方法{k} | 类别 | 代表工作 [{k}] |" for k in mine[:12]] + [""]
d = len(heads) + 2
out += [f"## {d} 讨论与开放问题", "", filler * 3, "", f"## {d + 1} 结论", "", filler * 3, "", "## 参考文献", ""]
out += [f"[{k}] {e}" for k, e in enumerate(refs, start=1)]
os.makedirs(os.path.join(task, "solution"), exist_ok=True)
open(os.path.join(task, "solution", "paper.md"), "w", encoding="utf-8").write("\n".join(out) + "\n")
if limits["annotation_chars"]:
    notes = [f"[{k}] 第{k}条文献提出了与本综述相关的方法，作者在公开数据上进行了实验，结论支持其设计；本文在相应章节讨论了它的贡献、局限以及与其他工作的关系。"
             for k in range(1, n + 1)]
    while any(len(g.CJK.findall(x)) < limits["annotation_chars"] for x in notes):
        notes = [x + "该文献的实验设置、数据规模与评价指标在原文中有详细说明，可作为后续研究的对照。" for x in notes]
    open(os.path.join(task, "solution", "annotations.md"), "w", encoding="utf-8").write("\n".join(notes) + "\n")
