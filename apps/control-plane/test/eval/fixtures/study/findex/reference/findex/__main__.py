"""python3 -m findex --index <dir> <command> (spec section 2)."""
import argparse
import json
import sys

from .query import search
from .store import FindexError, Index


def _read(path):
    docs = []
    with open(path, encoding='utf-8') as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                doc = json.loads(line)
            except json.JSONDecodeError as error:
                raise FindexError(f'line {number}: not JSON ({error})') from error
            if not isinstance(doc, dict) or not all(
                isinstance(doc.get(key), str) for key in ('id', 'title', 'body')
            ):
                raise FindexError(f'line {number}: id, title and body must be strings')
            tags = doc.get('tags', [])
            if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
                raise FindexError(f'line {number}: tags must be a list of strings')
            docs.append(doc)
    return docs


def main(argv=None):
    parser = argparse.ArgumentParser(prog='findex')
    parser.add_argument('--index', required=True)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('add').add_argument('file')
    commands.add_parser('delete').add_argument('ids', nargs='+')
    found = commands.add_parser('search')
    found.add_argument('query')
    found.add_argument('--limit', type=int, default=10)
    found.add_argument('--json', action='store_true')
    commands.add_parser('stats')
    commands.add_parser('compact')
    args = parser.parse_args(argv)
    index = Index(args.index)
    try:
        if args.command == 'add':
            docs = _read(args.file)
            index.add(docs)
            print(f'added {len(docs)}')
        elif args.command == 'delete':
            print(f'deleted {index.delete(args.ids)}')
        elif args.command == 'search':
            total, hits = search(index.live(), args.query, args.limit)
            if args.json:
                print(json.dumps({
                    'total': total,
                    'hits': [
                        {'id': doc['id'], 'score': round(score, 4), 'title': doc['title'],
                         'snippet': text}
                        for score, doc, text in hits
                    ],
                }, ensure_ascii=False))
            else:
                for score, doc, _ in hits:
                    print(f"{doc['id']}\t{score:.4f}\t{doc['title']}")
        elif args.command == 'stats':
            manifest = index.manifest()
            live = index.live(manifest)
            terms = set()
            for doc in live.values():
                terms.update(doc['title_terms'], doc['body_terms'])
            print(json.dumps({
                'docs': len(live), 'terms': len(terms), 'segments': len(manifest['segments'])
            }))
        else:
            index.compact()
            print('segments 1')
    except (FindexError, OSError) as error:
        print(f'findex: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
