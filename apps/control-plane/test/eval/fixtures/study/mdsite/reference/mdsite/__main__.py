"""python3 -m mdsite build SRC OUT"""
import datetime
import email.utils
import os
import shutil
import sys
import tomllib
from xml.sax.saxutils import escape

from .markdown import to_html

DEFAULT = "<html><head><title>{{ title }} - {{ site_title }}</title></head><body>{{ content }}</body></html>"


class Bad(Exception):
    pass


def read_post(path):
    with open(path, encoding="utf8") as handle:
        text = handle.read()
    meta, body = {}, text
    if text.startswith("---\n"):
        head, _, body = text[4:].partition("\n---\n")
        for line in head.split("\n"):
            if ":" in line:
                key, _, value = line.partition(":")
                meta[key.strip()] = value.strip()
    if not meta.get("title") or not meta.get("date"):
        raise Bad(path)
    try:
        datetime.date.fromisoformat(meta["date"])
    except ValueError:
        raise Bad(path) from None
    tags = [tag.strip().lower() for tag in meta.get("tags", "").split(",") if tag.strip()]
    return {
        "slug": os.path.basename(path)[:-3],
        "title": meta["title"],
        "date": meta["date"],
        "tags": tags,
        "draft": meta.get("draft", "").lower() == "true",
        "body": body,
    }


def listing(posts, prefix):
    rows = "".join(
        f'<li><a href="{prefix}posts/{p["slug"]}.html">{escape(p["title"])}</a> <time>{p["date"]}</time></li>'
        for p in posts
    )
    return f"<ul>{rows}</ul>"


def page(template, site_title, title, content):
    return template.replace("{{ site_title }}", site_title).replace("{{ title }}", title).replace("{{ content }}", content)


def build(src, out):
    with open(os.path.join(src, "site.toml"), "rb") as handle:
        site = tomllib.load(handle)
    posts_dir = os.path.join(src, "posts")
    posts = [read_post(os.path.join(posts_dir, name)) for name in sorted(os.listdir(posts_dir)) if name.endswith(".md")]
    posts = [p for p in posts if not p["draft"]]
    posts.sort(key=lambda p: p["slug"])
    posts.sort(key=lambda p: p["date"], reverse=True)
    template_path = os.path.join(src, "templates", "page.html")
    template = DEFAULT
    if os.path.exists(template_path):
        with open(template_path, encoding="utf8") as handle:
            template = handle.read()
    if os.path.exists(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, "posts"))
    os.makedirs(os.path.join(out, "tags"))

    def write(rel, text):
        with open(os.path.join(out, rel), "w", encoding="utf8") as handle:
            handle.write(text)

    for p in posts:
        write(f"posts/{p['slug']}.html", page(template, site["title"], p["title"], to_html(p["body"])))
    write("index.html", page(template, site["title"], site["title"], listing(posts, "")))
    for tag in sorted({t for p in posts for t in p["tags"]}):
        write(f"tags/{tag}.html", page(template, site["title"], tag, listing([p for p in posts if tag in p["tags"]], "../")))
    items = []
    for p in posts[:20]:
        day = datetime.datetime.fromisoformat(p["date"]).replace(tzinfo=datetime.timezone.utc)
        items.append(
            f"<item><title>{escape(p['title'])}</title><link>{site['base_url']}/posts/{p['slug']}.html</link>"
            f"<pubDate>{email.utils.format_datetime(day).replace('-0000', '+0000')}</pubDate></item>"
        )
    write(
        "feed.xml",
        f'<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>{escape(site["title"])}</title>'
        f"<link>{site['base_url']}</link>{''.join(items)}</channel></rss>",
    )


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 3 or argv[0] != "build":
        print("usage: python3 -m mdsite build SRC OUT", file=sys.stderr)
        return 2
    try:
        build(argv[1], argv[2])
    except Bad as error:
        print(f"bad front matter: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
