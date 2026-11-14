"""Segments, the manifest and the lock (spec section 4)."""
import contextlib
import fcntl
import json
import os

from .analysis import analyze


class FindexError(Exception):
    pass


def _write_atomic(path, data):
    tmp = f'{path}.tmp.{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as handle:
        json.dump(data, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


class Index:
    def __init__(self, root):
        self.root = root
        os.makedirs(root, exist_ok=True)

    @contextlib.contextmanager
    def locked(self):
        with open(os.path.join(self.root, '.lock'), 'a', encoding='utf-8') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def manifest(self):
        path = os.path.join(self.root, 'manifest.json')
        if not os.path.exists(path):
            return {'next': 1, 'segments': [], 'deleted': {}}
        with open(path, encoding='utf-8') as handle:
            return json.load(handle)

    def _save(self, manifest):
        _write_atomic(os.path.join(self.root, 'manifest.json'), manifest)

    def _segment(self, name):
        with open(os.path.join(self.root, name), encoding='utf-8') as handle:
            return json.load(handle)

    def live(self, manifest=None):
        """The documents that count, by id: the newest version, unless deleted after it."""
        manifest = manifest or self.manifest()
        docs = {}
        for entry in sorted(manifest['segments'], key=lambda each: each['seq']):
            for doc in self._segment(entry['name'])['docs']:
                docs[doc['id']] = (entry['seq'], doc)
        deleted = manifest['deleted']
        return {
            key: doc for key, (seq, doc) in docs.items() if deleted.get(key, -1) < seq
        }

    def add(self, docs):
        prepared = [
            {
                'id': doc['id'],
                'title': doc['title'],
                'body': doc['body'],
                'tags': [tag.lower() for tag in doc.get('tags', [])],
                'title_terms': analyze(doc['title']),
                'body_terms': analyze(doc['body']),
            }
            for doc in docs
        ]
        with self.locked():
            manifest = self.manifest()
            seq = manifest['next']
            name = f'seg-{seq:06d}.json'
            _write_atomic(os.path.join(self.root, name), {'seq': seq, 'docs': prepared})
            manifest['segments'].append({'name': name, 'seq': seq})
            manifest['next'] = seq + 1
            self._save(manifest)

    def delete(self, ids):
        with self.locked():
            manifest = self.manifest()
            live = self.live(manifest)
            gone = [key for key in dict.fromkeys(ids) if key in live]
            for key in gone:
                manifest['deleted'][key] = manifest['next']
            manifest['next'] += 1
            self._save(manifest)
            return len(gone)

    def compact(self):
        with self.locked():
            manifest = self.manifest()
            live = self.live(manifest)
            seq = manifest['next']
            name = f'seg-{seq:06d}.json'
            docs = [live[key] for key in sorted(live)]
            _write_atomic(os.path.join(self.root, name), {'seq': seq, 'docs': docs})
            old = [entry['name'] for entry in manifest['segments']]
            self._save({'next': seq + 1, 'segments': [{'name': name, 'seq': seq}], 'deleted': {}})
            for each in old:
                with contextlib.suppress(OSError):
                    os.remove(os.path.join(self.root, each))
