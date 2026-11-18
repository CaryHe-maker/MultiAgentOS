"""The query language, BM25 and snippets (spec section 3)."""
import math

from .analysis import analyze
from .store import FindexError

K1 = 1.2
B = 0.75


def _split(text):
    """Raw clauses: ('phrase', words) or ('word', text); quotes keep their spaces."""
    clauses, at = [], 0
    while at < len(text):
        if text[at].isspace():
            at += 1
        elif text[at] == '"':
            end = text.find('"', at + 1)
            if end < 0:
                raise FindexError('unbalanced quote')
            clauses.append(('phrase', text[at + 1:end]))
            at = end + 1
        else:
            end = at
            while end < len(text) and not text[end].isspace():
                if text[end] == '"':
                    raise FindexError('unbalanced quote')
                end += 1
            clauses.append(('word', text[at:end]))
            at = end
    return clauses


def parse(text):
    """Groups of clauses: (kind, value), kinds term, phrase, title, tag, prefix, not."""
    groups, group = [], []
    for kind, raw in _split(text):
        if kind == 'word' and raw == 'OR':
            groups.append(group)
            group = []
            continue
        if kind == 'phrase':
            terms = analyze(raw)
            if terms:
                group.append(('phrase', terms))
        elif raw.startswith('-') and len(raw) > 1:
            terms = analyze(raw[1:])
            if terms:
                group.append(('not', terms))
        elif raw.startswith('title:'):
            terms = analyze(raw[6:])
            if terms:
                group.append(('title', terms))
        elif raw.startswith('tag:'):
            if raw[4:]:
                group.append(('tag', raw[4:].lower()))
        elif raw.endswith('*') and len(raw) > 1:
            group.append(('prefix', raw[:-1].lower()))
        else:
            terms = analyze(raw)
            if terms:
                group.append(('term', terms))
    groups.append(group)
    if not any(groups) or any(
        not [clause for clause in each if clause[0] != 'not'] for each in groups
    ):
        raise FindexError('invalid query')
    return groups


def _has_run(terms, run):
    width = len(run)
    return any(terms[at:at + width] == run for at in range(len(terms) - width + 1))


def _matches(doc, clause):
    kind, value = clause
    title, body = doc['title_terms'], doc['body_terms']
    if kind == 'term':
        return all(term in title or term in body for term in value)
    if kind == 'phrase':
        return _has_run(title, value) or _has_run(body, value)
    if kind == 'title':
        return all(term in title for term in value)
    if kind == 'tag':
        return value in doc['tags']
    if kind == 'prefix':
        return any(term.startswith(value) for term in title + body)
    return not any(term in title or term in body for term in value)


def search(live, text, limit):
    groups = parse(text)
    fixed = []
    prefixes = []
    for group in groups:
        for kind, value in group:
            if kind in ('term', 'phrase', 'title'):
                fixed.extend(value)
            elif kind == 'prefix':
                prefixes.append(value)
    fixed = list(dict.fromkeys(fixed))
    docs = list(live.values())
    n = len(docs)
    if n == 0:
        return 0, []
    length = {doc['id']: len(doc['body_terms']) + 2 * len(doc['title_terms']) for doc in docs}
    avgdl = sum(length.values()) / n or 1.0
    df = {}
    for doc in docs:
        for term in set(doc['title_terms']) | set(doc['body_terms']):
            df[term] = df.get(term, 0) + 1
    hits = []
    for doc in docs:
        if not any(all(_matches(doc, clause) for clause in group) for group in groups):
            continue
        present = set(doc['title_terms']) | set(doc['body_terms'])
        scored = [term for term in fixed if term in present]
        for prefix in prefixes:
            scored.extend(sorted(t for t in present if t.startswith(prefix) and t not in scored))
        score = 0.0
        dl = length[doc['id']]
        for term in dict.fromkeys(scored):
            tf = doc['body_terms'].count(term) + 2 * doc['title_terms'].count(term)
            idf = math.log(1 + (n - df[term] + 0.5) / (df[term] + 0.5))
            score += idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * dl / avgdl))
        hits.append((score, doc))
    hits.sort(key=lambda hit: (-hit[0], hit[1]['id']))
    return len(hits), [
        (score, doc, snippet(doc, set(fixed), prefixes)) for score, doc in hits[:limit]
    ]


def snippet(doc, terms, prefixes):
    words = doc['body'].split()

    def hit(word):
        return any(
            term in terms or any(term.startswith(prefix) for prefix in prefixes)
            for term in analyze(word)
        )

    marks = [hit(word) for word in words]
    if True not in marks:
        return ' '.join(words[:11])
    first = marks.index(True)
    start, end = max(0, first - 5), min(len(words) - 1, first + 5)
    shown = ' '.join(
        f'[{words[at]}]' if marks[at] else words[at] for at in range(start, end + 1)
    )
    return ('…' if start > 0 else '') + shown + ('…' if end < len(words) - 1 else '')
