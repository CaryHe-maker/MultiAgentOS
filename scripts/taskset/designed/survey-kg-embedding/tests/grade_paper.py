"""Grades paper.md of a designed survey task (instruction.md sections 2-5).

reward = 0.5 x (structural checks passed / number of checks) + 0.5 x (verified references / max(min_refs, n)).
Thresholds come from the "limits" of topic.json.
A reference is verified when its DOI (Crossref) or arXiv id resolves and the fetched title, the first
author's surname and the year all appear in the entry. Writes /logs/verifier/reward.txt and summary.json.
Usage: python3 grade_paper.py <paper.md> [topic-config.json]
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

CACHE = os.environ.get("REF_CACHE", "/logs/verifier/refcache.json")
UA = "mao-phase3-grader/1.0"
CJK = re.compile(r"[\u4e00-\u9fff]")
CITE = re.compile(r"\[(\d+(?:\s*[-–]\s*\d+)?(?:\s*[,，]\s*\d+(?:\s*[-–]\s*\d+)?)*)\]")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


_last_call: dict[str, float] = {}


def fetch(url: str, accept: str) -> bytes | None:
    host = urllib.parse.urlsplit(url).hostname or ""
    # arXiv asks for at least 3 seconds between API calls; Crossref is fine with a short pause.
    gap = 3.2 if "arxiv" in host else 0.2
    for attempt in range(5):
        wait = _last_call.get(host, 0) + gap - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call[host] = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except Exception:
            pass
        time.sleep(5 * 2**attempt)
    raise ConnectionError(url)


def lookup_doi(doi: str) -> dict | None:
    raw = fetch("https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="/"), "application/json")
    if raw is None:
        return None
    m = json.loads(raw)["message"]
    years = set()
    for key in ("issued", "published-print", "published-online", "created", "published"):
        parts = (m.get(key) or {}).get("date-parts") or [[None]]
        if parts and parts[0] and parts[0][0]:
            years.add(int(parts[0][0]))
    authors = m.get("author") or []
    first = (authors[0].get("family") or authors[0].get("name") or "") if authors else ""
    return {"title": " ".join(m.get("title") or []), "first": first, "years": sorted(years)}


def lookup_arxiv(aid: str) -> dict | None:
    raw = fetch("https://export.arxiv.org/api/query?id_list=" + urllib.parse.quote(aid), "application/atom+xml")
    ns = {"a": "http://www.w3.org/2005/Atom"}
    root = ET.fromstring(raw)
    entry = root.find("a:entry", ns)
    if entry is None or entry.find("a:title", ns) is None:
        return None
    title = " ".join((entry.find("a:title", ns).text or "").split())
    if not title or title.lower() == "error":
        return None
    published = entry.find("a:published", ns).text or ""
    names = [a.find("a:name", ns).text or "" for a in entry.findall("a:author", ns)]
    first = names[0].split()[-1] if names else ""
    years = {int(published[:4])} if published[:4].isdigit() else set()
    if re.match(r"\d{4}\.", aid):
        years.add(2000 + int(aid[:2]))
    return {"title": title, "first": first, "years": sorted(years)}


def identifier(entry: str):
    m = re.search(r"\bdoi:\s*(10\.\d{4,9}/\S+)", entry, re.I) or re.search(r"doi\.org/(10\.\d{4,9}/\S+)", entry, re.I)
    if m:
        return "doi", m.group(1).rstrip(".,;)")
    m = re.search(r"arxiv:\s*(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?", entry, re.I)
    if m:
        return "arxiv", m.group(1)
    return None, None


def verify(entry: str, cache: dict) -> tuple[bool, str]:
    kind, ident = identifier(entry)
    if kind is None:
        return False, "no DOI or arXiv id"
    key = f"{kind}:{ident.lower()}"
    if key not in cache:
        try:
            cache[key] = lookup_doi(ident) if kind == "doi" else lookup_arxiv(ident)
        except ConnectionError:
            return False, "lookup failed (network)"
    meta = cache[key]
    if meta is None:
        return False, f"{kind} {ident} does not resolve"
    text = norm(re.sub(r"(doi:\s*\S+|arxiv:\s*\S+|https?://\S+)", " ", entry, flags=re.I))
    title_words = norm(meta["title"]).split()
    words = set(text.split())
    if not title_words or sum(w in words for w in title_words) / len(title_words) < 0.9:
        return False, f"title does not match: {meta['title']}"
    if meta["first"] and norm(meta["first"]) and norm(meta["first"]).split()[-1] not in words:
        return False, f"first author does not match: {meta['first']}"
    years = {int(y) for y in re.findall(r"\b(19\d\d|20\d\d)\b", text)}
    if meta["years"] and not years & set(meta["years"]):
        return False, f"year does not match: {meta['years']}"
    return True, "ok"


def expand(spec: str) -> list[int]:
    out = []
    for part in re.split(r"[,，]", spec):
        part = part.strip()
        if re.search(r"[-–]", part):
            a, b = (int(x) for x in re.split(r"\s*[-–]\s*", part))
            out += list(range(a, b + 1)) if a <= b else []
        elif part:
            out.append(int(part))
    return out


def grade(path: str, topic: dict) -> dict:
    cfg = {"min_refs": 40, "min_recent": 20, "recent_year": 2019, "min_chars": 12000, "min_mains": 3,
           "min_subs": 2, "min_cites": 8, "min_tables": 1, "annotation_chars": 0}
    cfg.update(topic.get("limits", {}))
    checks: dict[str, bool] = {}
    if not os.path.isfile(path):
        return {"reward": 0.0, "checks": {"paper.md exists": False}, "refs": []}
    text = open(path, encoding="utf-8", errors="replace").read()
    lines = text.splitlines()
    checks["paper.md exists"] = True
    headings = [(i, len(m.group(1)), m.group(2).strip()) for i, l in enumerate(lines)
                for m in [re.match(r"^(#{1,6})\s+(.*)$", l)] if m]
    checks["title is the first heading (#)"] = bool(headings) and headings[0][1] == 1

    def section(name_re):
        for k, (i, level, title) in enumerate(headings):
            if level == 2 and re.match(name_re, title):
                end = next((j for j, lv, _ in headings[k + 1:] if lv <= 2), len(lines))
                return k, i, end
        return None

    abstract = section(r"摘要$")
    kw_ok = False
    if abstract:
        body = "\n".join(lines[abstract[1] + 1: abstract[2]])
        kw = re.search(r"\*\*关键词\*\*\s*[:：]\s*(.+)", body)
        n_cjk = len(CJK.findall(body[: kw.start()] if kw else body))
        checks["abstract has 200-500 Chinese characters"] = 200 <= n_cjk <= 500
        if kw:
            items = [x for x in re.split(r"；", kw.group(1).strip()) if x.strip()]
            kw_ok = 4 <= len(items) <= 6
    else:
        checks["abstract has 200-500 Chinese characters"] = False
    checks["4-6 keywords separated by ；"] = kw_ok

    numbered = [(k, i, t) for k, (i, lv, t) in enumerate(headings) if lv == 2 and re.match(r"\d+\s", t)]
    refs_sec = section(r"参考文献$")
    checks["section 1 is 引言"] = bool(numbered) and re.match(r"1\s+引言", numbered[0][2]) is not None
    disc = next((x for x in numbered if "讨论" in x[2] and "开放问题" in x[2]), None)
    concl = next((x for x in numbered if re.match(r"\d+\s+结论", x[2])), None)
    nums = [int(t.split()[0]) for _, _, t in numbered]
    checks["sections numbered 1..n in order"] = nums == list(range(1, len(nums) + 1))
    checks["discussion then conclusion, references last"] = bool(
        disc and concl and refs_sec and disc[0] < concl[0] < refs_sec[0]
        and refs_sec[0] == max(k for k, (_, lv, _) in enumerate(headings) if lv <= 2))

    # references
    refs: dict[int, str] = {}
    if refs_sec:
        for l in lines[refs_sec[1] + 1: refs_sec[2]]:
            m = re.match(r"^\s*\[(\d+)\]\s+(.+)$", l)
            if m:
                refs[int(m.group(1))] = m.group(2)
    n = len(refs)
    checks["enough references numbered 1..n"] = n >= cfg["min_refs"] and sorted(refs) == list(range(1, n + 1))
    checks["every reference has a DOI or arXiv id"] = n > 0 and all(identifier(e)[0] for e in refs.values())
    recent = sum(1 for e in refs.values() if any(int(y) >= cfg["recent_year"] for y in re.findall(r"\b(20\d\d)\b",
                 re.sub(r"(doi:\s*\S+|arxiv:\s*\S+)", " ", e, flags=re.I))))
    checks["enough recent references"] = recent >= cfg["min_recent"]

    body_end = refs_sec[1] if refs_sec else len(lines)
    body_start = abstract[1] if abstract else 0
    body_lines = lines[body_start:body_end]
    table_rows = [l for l in body_lines if l.strip().startswith("|")]
    prose = "\n".join(l for l in body_lines if not l.strip().startswith("|"))
    checks["body long enough (Chinese characters)"] = len(CJK.findall(prose)) >= cfg["min_chars"]
    cited = set()
    for m in CITE.finditer("\n".join(body_lines)):
        cited.update(expand(m.group(1)))
    checks["every citation exists and every reference is cited"] = n > 0 and cited == set(refs)

    data_rows = [r for r in table_rows if not re.match(r"^\s*\|[\s:\-|]+\|\s*$", r)]
    tables_ok = 0
    block: list[str] = []
    for l in body_lines + [""]:
        if l.strip().startswith("|"):
            block.append(l)
            continue
        if len(block) >= 12:
            rows = [r for r in block[2:] if not re.match(r"^\s*\|[\s:\-|]+\|\s*$", r)]
            if len(rows) >= 10 and all(CITE.search(r) for r in rows):
                tables_ok += 1
        block = []
    checks["enough tables with 10+ rows, each citing"] = tables_ok >= cfg["min_tables"] and bool(data_rows)

    mains = [x for x in numbered if x[2] and not re.match(r"1\s+引言", x[2]) and x is not disc and x is not concl]
    main_ok = len(mains) >= cfg["min_mains"]
    for k, i, _ in mains:
        end = next((j for j, lv, _ in headings[k + 1:] if lv <= 2), len(lines))
        subs = [1 for kk, (j, lv, _) in enumerate(headings) if lv == 3 and i < j < end]
        cits = set()
        for m in CITE.finditer("\n".join(lines[i:end])):
            cits.update(expand(m.group(1)))
        main_ok = main_ok and len(subs) >= cfg["min_subs"] and len(cits) >= cfg["min_cites"]
    checks["enough main sections, subsections and cited works per section"] = main_ok
    low = text.lower()
    checks["covers the required topics"] = all(any(t.lower() in low for t in group) for group in topic["must_cover"])

    cache = {}
    if os.path.exists(CACHE):
        try:
            cache = json.load(open(CACHE))
        except ValueError:
            cache = {}
    verified, details = 0, []
    for num in sorted(refs):
        ok, why = verify(refs[num], cache)
        verified += ok
        details.append({"n": num, "ok": ok, "why": why})
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump(cache, open(CACHE, "w"))
    frac_checks = sum(checks.values()) / len(checks)
    if cfg["annotation_chars"]:
        notes = {}
        apath = os.path.join(os.path.dirname(path), "annotations.md")
        if os.path.isfile(apath):
            for l in open(apath, encoding="utf-8", errors="replace"):
                m = re.match(r"^\s*\[(\d+)\]\s+(.+)$", l)
                if m:
                    notes[int(m.group(1))] = m.group(2).strip()
        long_enough = all(len(CJK.findall(notes.get(k, ""))) >= cfg["annotation_chars"] for k in refs)
        checks["annotations.md annotates every reference, all distinct"] = (
            bool(refs) and long_enough and len(set(notes.get(k) for k in refs)) == len(refs))
    frac_refs = verified / max(cfg["min_refs"], n) if n else 0.0
    reward = round(0.5 * frac_checks + 0.5 * frac_refs, 4)
    return {"reward": reward, "checks": checks, "verified": verified, "references": n, "refs": details}


if __name__ == "__main__":
    topic = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else {"must_cover": []}
    result = grade(sys.argv[1], topic)
    os.makedirs("/logs/verifier", exist_ok=True)
    open("/logs/verifier/reward.txt", "w").write(f"{result['reward']}\n")
    json.dump(result, open("/logs/verifier/summary.json", "w"), ensure_ascii=False, indent=1)
    for k, v in result["checks"].items():
        print(("PASS " if v else "FAIL ") + k)
    print(f"references verified: {result.get('verified', 0)}/{result.get('references', 0)}; reward {result['reward']}")
