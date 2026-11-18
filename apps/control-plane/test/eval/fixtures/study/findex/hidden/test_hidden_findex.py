"""Hidden acceptance tests of findex (docs/spec.md), run through its command line."""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.abspath(__file__))


def run(index, *args, timeout=60):
    return subprocess.run(
        [sys.executable, '-m', 'findex', '--index', index, *args],
        cwd=ROOT, capture_output=True, text=True, timeout=timeout,
    )


DOCS = [
    {'id': 'd1', 'title': 'Jumping cats', 'body': 'The cats jumped over the fence and ran into the garden.', 'tags': ['Pets']},
    {'id': 'd2', 'title': 'Garden stories', 'body': 'Stories of a quiet garden where nothing happens at all.', 'tags': ['books']},
    {'id': 'd3', 'title': 'Fence repair', 'body': 'How to repair a garden fence with classes of tools and nails.', 'tags': ['diy', 'garden']},
    {'id': 'd4', 'title': 'Quantum computing', 'body': 'Qubits and quantum gates; computing beyond classical machines.', 'tags': []},
    {'id': 'd5', 'title': 'Cat care', 'body': 'Feeding a cat twice a day keeps the cat healthy and calm.'},
]


class FindexTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='findex-hidden-')
        self.index = os.path.join(self.dir, 'idx')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, docs, name='docs.jsonl'):
        path = os.path.join(self.dir, name)
        with open(path, 'w', encoding='utf-8') as handle:
            for doc in docs:
                handle.write((doc if isinstance(doc, str) else json.dumps(doc)) + '\n')
        return path

    def add(self, docs, name='docs.jsonl'):
        done = run(self.index, 'add', self.write(docs, name))
        self.assertEqual(done.returncode, 0, done.stderr)
        return done

    def ids(self, query, *extra):
        done = run(self.index, 'search', query, *extra)
        self.assertEqual(done.returncode, 0, done.stderr)
        return [line.split('\t')[0] for line in done.stdout.splitlines() if line]

    def found(self, query):
        done = run(self.index, 'search', query, '--json', '--limit', '100')
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_01_add_prints_count_and_stats(self):
        self.assertEqual(self.add(DOCS).stdout.strip(), 'added 5')
        stats = json.loads(run(self.index, 'stats').stdout)
        self.assertEqual(stats['docs'], 5)
        self.assertEqual(stats['segments'], 1)

    def test_02_stemming_and_stopwords(self):
        self.add(DOCS)
        # jumping -> jump, jumped -> jump; stories -> story; the stopword is ignored.
        self.assertEqual(sorted(self.ids('the jumping cat')), ['d1'])
        self.assertEqual(self.ids('story'), ['d2'])
        self.assertEqual(self.ids('class'), ['d3'])

    def test_03_bm25_score_exact(self):
        self.add(DOCS)
        out = run(self.index, 'search', 'garden').stdout.splitlines()
        # Compute BM25 independently for the term 'garden'.
        stop = set('a an and are as at be by for from in is it of on or the to with'.split())
        import re

        def stem(w):
            if w.endswith('sses'):
                return w[:-2]
            if w.endswith('ies') and len(w) > 4:
                return w[:-3] + 'y'
            if w.endswith('s') and not w.endswith('ss') and len(w) > 3:
                return w[:-1]
            if w.endswith('ing') and len(w) > 5:
                return w[:-3]
            if w.endswith('ed') and len(w) > 4:
                return w[:-2]
            return w

        def terms(t):
            return [stem(w) for w in re.findall(r'[a-z0-9]+', t.lower()) if w not in stop]

        n = len(DOCS)
        dl = {d['id']: len(terms(d['body'])) + 2 * len(terms(d['title'])) for d in DOCS}
        avg = sum(dl.values()) / n
        tf = {d['id']: terms(d['body']).count('garden') + 2 * terms(d['title']).count('garden') for d in DOCS}
        df = sum(1 for v in tf.values() if v > 0)
        idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
        expected = {
            key: idf * v * 2.2 / (v + 1.2 * (0.25 + 0.75 * dl[key] / avg))
            for key, v in tf.items() if v > 0
        }
        order = sorted(expected, key=lambda key: (-expected[key], key))
        self.assertEqual([line.split('\t')[0] for line in out], order)
        for line in out:
            key, score, title = line.split('\t')
            self.assertEqual(score, f'{expected[key]:.4f}')
            self.assertEqual(title, next(d['title'] for d in DOCS if d['id'] == key))

    def test_04_phrase_title_tag_prefix_not(self):
        self.add(DOCS)
        self.assertEqual(self.ids('"garden fence"'), ['d3'])
        self.assertEqual(self.ids('"fence garden"'), [])
        self.assertEqual(self.ids('title:garden'), ['d2'])
        self.assertEqual(sorted(self.ids('tag:GARDEN')), ['d3'])
        self.assertEqual(sorted(self.ids('tag:pets')), ['d1'])
        self.assertEqual(sorted(self.ids('quant*')), ['d4'])
        self.assertEqual(sorted(self.ids('garden -fence')), ['d2'])

    def test_05_or_groups(self):
        self.add(DOCS)
        self.assertEqual(sorted(self.ids('qubit OR feeding cat')), ['d4', 'd5'])
        self.assertEqual(sorted(self.ids('garden fence OR quantum')), ['d1', 'd3', 'd4'])

    def test_06_invalid_queries(self):
        self.add(DOCS)
        for query in ['', 'the', '-garden', '"garden fence', 'cat OR', 'OR cat']:
            done = run(self.index, 'search', query)
            self.assertEqual(done.returncode, 2, f'{query!r}: {done.stdout}')

    def test_07_limit_and_ties(self):
        docs = [{'id': f'x{i}', 'title': 'same', 'body': 'alpha beta'} for i in (3, 1, 2)]
        self.add(docs)
        self.assertEqual(self.ids('alpha'), ['x1', 'x2', 'x3'])
        self.assertEqual(self.ids('alpha', '--limit', '2'), ['x1', 'x2'])

    def test_08_json_and_snippet(self):
        body = ' '.join(f'w{i}' for i in range(20)) + ' Gardens grow ' + ' '.join(f'z{i}' for i in range(20))
        self.add([{'id': 's1', 'title': 'Plain', 'body': body}, {'id': 's2', 'title': 'Other', 'body': 'nothing here to see'}])
        result = self.found('garden')
        self.assertEqual(result['total'], 1)
        hit = result['hits'][0]
        self.assertEqual(hit['id'], 's1')
        self.assertIsInstance(hit['score'], float)
        self.assertEqual(hit['snippet'], '…w15 w16 w17 w18 w19 [Gardens] grow z0 z1 z2 z3…')
        title_only = self.found('other')['hits'][0]
        self.assertEqual(title_only['snippet'], 'nothing here to see')

    def test_09_replace_delete_and_add_again(self):
        self.add(DOCS)
        self.add([{'id': 'd4', 'title': 'Gardening', 'body': 'Roses and tulips.'}], 'more.jsonl')
        self.assertEqual(self.ids('quantum'), [])
        self.assertEqual(self.ids('tulip'), ['d4'])
        done = run(self.index, 'delete', 'd4', 'd5', 'nope')
        self.assertEqual(done.stdout.strip(), 'deleted 2')
        self.assertEqual(self.ids('tulip'), [])
        self.assertEqual(json.loads(run(self.index, 'stats').stdout)['docs'], 3)
        self.add([{'id': 'd5', 'title': 'Cat again', 'body': 'back'}], 'again.jsonl')
        self.assertEqual(self.ids('back'), ['d5'])

    def test_10_bad_file_adds_nothing(self):
        self.add(DOCS)
        for bad in [['{"id": "n1", "title": "t", "body": "ok"}', '{not json'],
                    ['{"id": "n2", "title": "t"}'],
                    ['{"id": 3, "title": "t", "body": "b"}'],
                    ['{"id": "n4", "title": "t", "body": "b", "tags": "x"}']]:
            done = run(self.index, 'add', self.write(bad, 'bad.jsonl'))
            self.assertEqual(done.returncode, 2)
            self.assertTrue(done.stderr.strip())
        self.assertEqual(json.loads(run(self.index, 'stats').stdout)['docs'], 5)
        self.assertEqual(self.ids('ok'), [])

    def test_11_compact_keeps_results(self):
        self.add(DOCS)
        self.add([{'id': 'd2', 'title': 'Garden stories two', 'body': 'A garden again.'}], 'b.jsonl')
        run(self.index, 'delete', 'd5')
        self.add([{'id': 'd6', 'title': 'Fence', 'body': 'garden fence garden'}], 'c.jsonl')
        queries = ['garden', 'fence OR cat', 'gard*', '"garden fence"', 'title:garden -again']
        before = {q: run(self.index, 'search', q, '--json').stdout for q in queries}
        stats = json.loads(run(self.index, 'stats').stdout)
        self.assertEqual(stats['segments'], 3)
        self.assertEqual(run(self.index, 'compact').stdout.strip(), 'segments 1')
        after = {q: run(self.index, 'search', q, '--json').stdout for q in queries}
        self.assertEqual(before, after)
        stats_after = json.loads(run(self.index, 'stats').stdout)
        self.assertEqual(stats_after, {**stats, 'segments': 1})

    def test_12_terms_count(self):
        self.add([{'id': 'a', 'title': 'Cats', 'body': 'cat cats the dog'}])
        self.assertEqual(json.loads(run(self.index, 'stats').stdout)['terms'], 2)

    def test_13_stray_files_are_ignored(self):
        self.add(DOCS)
        for name in ['manifest.json.tmp', 'seg-999999.json', 'junk.json', 'manifest.json.partial']:
            with open(os.path.join(self.index, name), 'w', encoding='utf-8') as handle:
                handle.write('{"docs": [{"id": "ghost", "title": "ghost", "body": "ghost"}]')
        self.assertEqual(self.ids('ghost'), [])
        self.assertEqual(json.loads(run(self.index, 'stats').stdout)['docs'], 5)
        self.add([{'id': 'n', 'title': 'new', 'body': 'fresh'}], 'n.jsonl')
        self.assertEqual(self.ids('fresh'), ['n'])

    def test_14_concurrent_adds(self):
        files = [self.write([{'id': f'{p}{i}', 'title': p, 'body': f'body {p} {i}'} for i in range(200)], f'{p}.jsonl')
                 for p in ('left', 'right', 'mid')]
        results = []

        def go(path):
            results.append(run(self.index, 'add', path, timeout=120))

        threads = [threading.Thread(target=go, args=(path,)) for path in files]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertTrue(all(each.returncode == 0 for each in results), [each.stderr for each in results])
        self.assertEqual(json.loads(run(self.index, 'stats').stdout)['docs'], 600)

    def test_15_scale(self):
        words = ['alpha', 'beta', 'gamma', 'delta', 'river', 'stone', 'cloud', 'forest', 'signal', 'engine']
        docs = []
        for i in range(5000):
            body = ' '.join(words[(i * 7 + k * 3) % len(words)] + str(k % 13) for k in range(100))
            docs.append({'id': f'p{i:05d}', 'title': f'paper {i} {words[i % 10]}', 'body': body})
        path = self.write(docs, 'big.jsonl')
        started = time.monotonic()
        done = run(self.index, 'add', path, timeout=120)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertLess(time.monotonic() - started, 10)
        started = time.monotonic()
        done = run(self.index, 'search', 'river3 stone4 OR title:forest', '--json')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertGreater(json.loads(done.stdout)['total'], 0)


if __name__ == '__main__':
    unittest.main()
