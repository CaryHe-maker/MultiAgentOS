"""Hidden tests of the pygit task. Every scenario runs twice, with pygit in one directory and with the
real git in another, under the same environment, and the results are compared. pygit runs with a PATH
whose `git` is a decoy that leaves a marker, so calling git fails the test.
"""

import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

PROJECT = os.environ.get("PROJECT", os.getcwd())
GIT = shutil.which("git") or "/usr/bin/git"


class Pair:
    def __init__(self):
        self.root = tempfile.mkdtemp()
        self.p = os.path.join(self.root, "p")
        self.g = os.path.join(self.root, "g")
        os.makedirs(self.p)
        os.makedirs(self.g)
        self.home = os.path.join(self.root, "home")
        os.makedirs(self.home)
        cfg = os.path.join(self.home, "gitconfig")
        with open(cfg, "w") as f:
            f.write("[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\tfilemode = true\n"
                    "[advice]\n\tdetachedHead = false\n[gc]\n\tauto = 0\n[merge]\n\tconflictstyle = merge\n")
        self.decoy = os.path.join(self.root, "bin")
        os.makedirs(self.decoy)
        self.marker = os.path.join(self.root, "git-was-called")
        with open(os.path.join(self.decoy, "git"), "w") as f:
            f.write(f"#!/bin/sh\ntouch {self.marker}\nexit 99\n")
        os.chmod(os.path.join(self.decoy, "git"), 0o755)
        self.t = 1700000000
        self.env = {"HOME": self.home, "GIT_CONFIG_GLOBAL": cfg, "GIT_CONFIG_NOSYSTEM": "1", "LANG": "C.UTF-8",
                    "TZ": "UTC", "PYTHONPATH": PROJECT}
        self.tick()

    def tick(self, minutes=1):
        self.t += 60 * minutes
        for who in ("AUTHOR", "COMMITTER"):
            self.env[f"GIT_{who}_NAME"] = "Ada Lovelace" if who == "AUTHOR" else "Grace Hopper"
            self.env[f"GIT_{who}_EMAIL"] = "ada@example.com" if who == "AUTHOR" else "grace@example.com"
            self.env[f"GIT_{who}_DATE"] = f"{self.t} +0800"

    def run_p(self, args, sub="", stdin=None):
        env = dict(self.env, PATH=f"{self.decoy}:/usr/local/bin")
        r = subprocess.run([sys.executable, "-m", "pygit"] + args, cwd=os.path.join(self.p, sub), env=env,
                           capture_output=True, text=True, input=stdin, timeout=120)
        if os.path.exists(self.marker):
            raise AssertionError("pygit called an external git")
        return r

    def run_g(self, args, sub="", repo=None):
        env = dict(self.env, PATH="/usr/local/bin:/usr/bin:/bin")
        return subprocess.run([GIT] + args, cwd=os.path.join(repo or self.g, sub), env=env, capture_output=True,
                              text=True, timeout=120)

    def both(self, args, sub=""):
        return self.run_p(args, sub), self.run_g(args, sub)

    def write(self, path, content, mode=None):
        for base in (self.p, self.g):
            full = os.path.join(base, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                f.write(content.encode() if isinstance(content, str) else content)
            if mode:
                os.chmod(full, mode)

    def remove(self, path):
        for base in (self.p, self.g):
            full = os.path.join(base, path)
            shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)

    def files(self, base):
        out = {}
        for root, dirs, names in os.walk(base):
            dirs[:] = [d for d in dirs if d != ".git"]
            for n in names:
                full = os.path.join(root, n)
                with open(full, "rb") as f:
                    out[os.path.relpath(full, base)] = (f.read(), os.stat(full).st_mode & stat.S_IXUSR)
        return out

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


class Base(unittest.TestCase):
    def setUp(self):
        self.x = Pair()

    def tearDown(self):
        self.x.cleanup()

    def same(self, args, sub="", out=True, code=True, first_line=False):
        p, g = self.x.both(args, sub)
        if code:
            self.assertEqual(p.returncode, g.returncode, f"{args}: pygit {p.returncode} {p.stderr[-500:]}")
        if out:
            po, go = p.stdout, g.stdout
            if first_line:
                po, go = po.splitlines()[:1], go.splitlines()[:1]
            self.assertEqual(po, go, f"{args}")
        return p, g

    def init(self):
        self.same(["init"], out=False)

    def commit(self, msg="change"):
        self.x.tick()
        self.same(["commit", "-m", msg], first_line=True)

    def head(self):
        return self.same(["rev-parse", "HEAD"])[0].stdout.strip()

    def state(self):
        """Working tree files, git's own view of each index and HEAD."""
        x = self.x
        self.assertEqual(x.files(x.p), x.files(x.g))
        for args in (["status", "--porcelain"], ["ls-files", "-s"], ["rev-parse", "HEAD"]):
            self.assertEqual(x.run_g(args, repo=x.p).stdout, x.run_g(args).stdout, args)
        with open(os.path.join(x.p, ".git", "HEAD")) as a, open(os.path.join(x.g, ".git", "HEAD")) as b:
            self.assertEqual(a.read().strip(), b.read().strip())


class Objects(Base):
    def test_init(self):
        p, g = self.x.both(["init"])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stdout.replace(self.x.p, "<dir>"), g.stdout.replace(self.x.g, "<dir>"))
        self.assertEqual(self.x.run_g(["fsck", "--strict"], repo=self.x.p).returncode, 0)
        with open(os.path.join(self.x.p, ".git", "HEAD")) as f:
            self.assertEqual(f.read(), "ref: refs/heads/main\n")
        p, g = self.x.both(["init"])
        self.assertEqual(p.stdout.replace(self.x.p, "<dir>"), g.stdout.replace(self.x.g, "<dir>"))

    def test_hash_object(self):
        self.init()
        for name, data in (("a.txt", "hello\n"), ("empty", ""), ("uni.txt", "héllo wörld ✓\n"),
                           ("bin.dat", bytes(range(256)) * 3), ("nonl", "no newline")):
            self.x.write(name, data)
            self.same(["hash-object", name])

    def test_hash_object_write_is_readable_by_git(self):
        self.init()
        self.x.write("f.txt", "some content\n" * 50)
        p = self.x.run_p(["hash-object", "-w", "f.txt"])
        sha = p.stdout.strip()
        g = self.x.run_g(["cat-file", "-p", sha], repo=self.x.p)
        self.assertEqual(g.stdout, "some content\n" * 50)

    def test_cat_file_on_git_objects(self):
        self.init()
        self.x.write("d/a.txt", "a\n")
        self.x.write("run.sh", "#!/bin/sh\n", 0o755)
        self.x.run_g(["add", "."])
        self.x.run_g(["commit", "-m", "one"])
        shutil.rmtree(self.x.p)
        shutil.copytree(self.x.g, self.x.p)
        tree = self.x.run_g(["rev-parse", "HEAD^{tree}"]).stdout.strip()
        blob = self.x.run_g(["rev-parse", "HEAD:d/a.txt"]).stdout.strip()
        for obj in ("HEAD", tree, blob):
            for opt in ("-t", "-s", "-p"):
                self.same(["cat-file", opt, obj])

    def test_write_tree_and_commit_hashes_match(self):
        self.init()
        self.x.write("README.md", "# title\n")
        self.x.write("src/main.py", "print('hi')\n")
        self.x.write("src/util/helpers.py", "X = 1\n")
        self.x.write("bin/tool", "#!/bin/sh\necho\n", 0o755)
        self.x.write("empty.txt", "")
        self.same(["add", "."], out=False)
        self.same(["write-tree"])
        self.commit("first commit")
        self.assertEqual(self.x.run_g(["fsck", "--strict"], repo=self.x.p).returncode, 0)
        self.x.write("src/main.py", "print('bye')\n")
        self.same(["add", "src/main.py"], out=False)
        self.commit("second\n\nwith a body")
        self.state()

    def test_commit_output_and_nothing_to_commit(self):
        self.init()
        self.x.write("a", "1\n")
        self.same(["add", "a"], out=False)
        self.commit("root")
        self.x.tick()
        p, g = self.same(["commit", "-m", "again"], out=False)
        self.assertEqual(p.returncode, 1)
        self.x.write("a", "2\n")
        self.same(["add", "a"], out=False)
        self.commit("next")
        self.same(["log", "--oneline"])


class Index(Base):
    def test_status_porcelain_cases(self):
        self.init()
        for f in ("keep", "mod", "del", "staged", "both", "dir/x"):
            self.x.write(f, f + "\n")
        self.same(["add", "."], out=False)
        self.commit("base")
        self.x.write("mod", "changed\n")
        self.x.remove("del")
        self.x.write("staged", "staged change\n")
        self.same(["add", "staged"], out=False)
        self.x.write("both", "stage me\n")
        self.same(["add", "both"], out=False)
        self.x.write("both", "and again\n")
        self.x.write("new.txt", "n\n")
        self.x.write("newdir/a", "a\n")
        self.x.write("newdir/sub/b", "b\n")
        self.x.write("dir/y", "y\n")
        self.x.write("added", "added\n")
        self.same(["add", "added"], out=False)
        self.x.write("added", "added then modified\n")
        self.same(["status", "--porcelain"])
        self.state()

    def test_status_reads_git_index(self):
        self.init()
        self.x.write("a.txt", "a\n")
        self.x.write("d/b.txt", "b\n")
        self.x.run_g(["add", "."])
        self.x.run_g(["commit", "-m", "c"])
        self.x.write("a.txt", "changed\n")
        self.x.write("u.txt", "u\n")
        self.x.run_g(["add", "u.txt"])
        shutil.rmtree(self.x.p)
        shutil.copytree(self.x.g, self.x.p)
        self.same(["status", "--porcelain"])
        self.same(["ls-files", "-s"])
        self.same(["diff", "--name-status"])
        self.same(["diff", "--name-status", "--cached"])

    def test_gitignore(self):
        self.init()
        self.x.write(".gitignore", "*.log\nbuild/\n/root-only.txt\n!keep.log\n# comment\n\ntmp?.txt\n[ab].dat\n**/cache\n")
        self.x.write("sub/.gitignore", "*.bak\n")
        for f in ("a.log", "keep.log", "build/out.o", "src/build/x", "root-only.txt", "src/root-only.txt",
                  "tmp1.txt", "tmp10.txt", "a.dat", "c.dat", "x/y/cache/z", "sub/f.bak", "f.bak", "main.c"):
            self.x.write(f, f + "\n")
        self.same(["status", "--porcelain"])
        self.same(["add", "."], out=False)
        self.same(["ls-files"])
        self.commit("ignored stuff")
        self.state()

    def test_add_stages_deletions_and_errors(self):
        self.init()
        self.x.write("d/a", "a\n")
        self.x.write("d/b", "b\n")
        self.same(["add", "."], out=False)
        self.commit("c")
        self.x.remove("d/a")
        self.same(["add", "d"], out=False)
        self.same(["status", "--porcelain"])
        p, g = self.same(["add", "nope.txt"], out=False)
        self.assertEqual(p.returncode, 128)
        self.assertEqual(p.stderr.strip().splitlines()[0], g.stderr.strip().splitlines()[0])

    def test_rm(self):
        self.init()
        for f in ("a", "b", "c/d"):
            self.x.write(f, f + "\n")
        self.same(["add", "."], out=False)
        self.commit("c")
        self.same(["rm", "a"], out=False)
        self.same(["rm", "--cached", "b"], out=False)
        self.same(["rm", "c/d"], out=False)
        self.same(["status", "--porcelain"])
        self.state()

    def test_ls_files_and_ls_tree(self):
        self.init()
        for f in ("z.txt", "a/b/c.txt", "a/x.txt", "m.sh"):
            self.x.write(f, f, 0o755 if f.endswith(".sh") else None)
        self.same(["add", "."], out=False)
        self.commit("c")
        self.same(["ls-files"])
        self.same(["ls-files", "-s"])
        self.same(["ls-tree", "HEAD"])
        self.same(["ls-tree", "-r", "HEAD"])
        tree = self.x.run_g(["rev-parse", "HEAD:a"]).stdout.strip()
        self.same(["ls-tree", tree])

    def test_works_from_subdirectory(self):
        self.init()
        self.x.write("top.txt", "t\n")
        self.x.write("sub/dir/f.txt", "f\n")
        self.same(["add", "."], out=False)
        self.commit("c")
        self.x.write("sub/dir/f.txt", "changed\n")
        self.x.write("sub/new.txt", "n\n")
        self.same(["status", "--porcelain"], sub="sub/dir")
        self.same(["add", "f.txt"], sub="sub/dir", out=False)
        self.same(["status", "--porcelain"], sub="sub")
        self.same(["log", "--oneline"], sub="sub/dir")


class History(Base):
    def build(self, n=4):
        self.init()
        for i in range(n):
            self.x.write("f.txt", "".join(f"line {j}\n" for j in range(i + 3)))
            self.x.write(f"file{i}.txt", f"{i}\n")
            self.same(["add", "."], out=False)
            self.commit(f"commit number {i}")

    def test_log(self):
        self.build()
        self.same(["log"])
        self.same(["log", "--oneline"])
        self.same(["log", "-n", "2"])
        self.same(["log", "--oneline", "-n", "3", "HEAD~1"])

    def test_log_timezones(self):
        self.init()
        for tz in ("+0000", "-0530", "+1345"):
            self.x.tick(600)
            for who in ("AUTHOR", "COMMITTER"):
                self.x.env[f"GIT_{who}_DATE"] = f"{self.x.t} {tz}"
            self.x.write("f", tz)
            self.same(["add", "f"], out=False)
            self.same(["commit", "-m", f"tz {tz}"], first_line=True)
        self.same(["log"])

    def test_rev_parse(self):
        self.build(5)
        self.same(["branch", "side", "HEAD~2"], out=False)
        self.same(["tag", "v1", "HEAD~3"], out=False)
        self.x.tick()
        self.same(["tag", "-a", "v2", "-m", "release two"], out=False)
        head = self.head()
        for rev in ("HEAD", "main", "side", "v1", "v2", "HEAD~1", "HEAD^", "HEAD~2^", "HEAD^^", "side~1", head,
                    head[:7], head[:4], "v1~1"):
            self.same(["rev-parse", rev])

    def test_branches(self):
        self.build(2)
        self.same(["branch", "feature"], out=False)
        self.same(["branch", "old", "HEAD~1"], out=False)
        self.same(["branch"])
        p, _ = self.same(["branch", "-d", "old"], out=False)
        self.assertEqual(p.returncode, 0)
        self.same(["branch"])
        self.same(["checkout", "-b", "work"], out=False)
        self.x.write("w.txt", "w\n")
        self.same(["add", "w.txt"], out=False)
        self.commit("on work")
        self.same(["checkout", "main"], out=False)
        p, _ = self.same(["branch", "-d", "work"], out=False)
        self.assertEqual(p.returncode, 1)
        self.same(["branch"])

    def test_tags(self):
        self.build(3)
        self.same(["tag", "light"], out=False)
        self.x.tick()
        self.same(["tag", "-a", "ann", "-m", "annotated tag", "HEAD~1"], out=False)
        self.same(["tag"])
        obj = self.x.run_g(["rev-parse", "ann"]).stdout.strip()
        self.same(["cat-file", "-p", obj])
        self.same(["cat-file", "-t", "ann"])
        self.assertEqual(self.x.run_g(["fsck", "--strict"], repo=self.x.p).returncode, 0)


class Checkout(Base):
    def setup_branches(self):
        self.init()
        self.x.write("common.txt", "base\n")
        self.x.write("only_main.txt", "main\n")
        self.x.write("dir/shared.txt", "shared\n")
        self.same(["add", "."], out=False)
        self.commit("base")
        self.same(["checkout", "-b", "feature"], out=False)
        self.x.remove("only_main.txt")
        self.x.write("feat/new.txt", "feature file\n")
        self.x.write("common.txt", "feature version\n")
        self.x.write("tool.sh", "#!/bin/sh\n", 0o755)
        self.same(["add", "."], out=False)
        self.commit("feature work")
        self.state()

    def test_switch_updates_tree_and_index(self):
        self.setup_branches()
        self.same(["checkout", "main"], out=False)
        self.state()
        self.same(["checkout", "feature"], out=False)
        self.state()

    def test_detached_and_new_branch_from_start_point(self):
        self.setup_branches()
        base = self.x.run_g(["rev-parse", "HEAD~1"]).stdout.strip()
        self.same(["checkout", base], out=False)
        self.state()
        self.same(["checkout", "-b", "fix", "feature"], out=False)
        self.state()

    def test_refuses_to_overwrite_local_changes(self):
        self.setup_branches()
        self.x.write("common.txt", "uncommitted edit\n")
        p, g = self.same(["checkout", "main"], out=False)
        self.assertEqual(p.returncode, 1)
        self.state()

    def test_untouched_local_changes_are_kept(self):
        self.setup_branches()
        self.x.write("dir/shared.txt", "edited but same in both branches\n")
        self.same(["checkout", "main"], out=False)
        self.state()


class Merge(Base):
    def setup(self):
        self.init()
        lines = "".join(f"line {i}\n" for i in range(1, 21))
        self.x.write("text.txt", lines)
        self.x.write("a.txt", "a\n")
        self.same(["add", "."], out=False)
        self.commit("base")

    def test_fast_forward_and_up_to_date(self):
        self.setup()
        self.same(["checkout", "-b", "ff"], out=False)
        self.x.write("b.txt", "b\n")
        self.same(["add", "b.txt"], out=False)
        self.commit("on ff")
        self.same(["checkout", "main"], out=False)
        self.x.tick()
        self.same(["merge", "ff"], out=False)
        self.state()
        self.x.tick()
        p, _ = self.same(["merge", "ff"], out=False)
        self.assertEqual(p.returncode, 0)
        self.state()

    def test_clean_merge_of_different_files(self):
        self.setup()
        self.same(["checkout", "-b", "topic"], out=False)
        self.x.write("topic.txt", "t\n")
        self.same(["add", "topic.txt"], out=False)
        self.commit("topic change")
        self.same(["checkout", "main"], out=False)
        self.x.write("main.txt", "m\n")
        self.same(["add", "main.txt"], out=False)
        self.commit("main change")
        self.x.tick()
        p, _ = self.same(["merge", "topic"], out=False)
        self.assertEqual(p.returncode, 0)
        self.state()
        self.same(["log"])
        self.same(["rev-parse", "HEAD^2"])

    def test_clean_line_merge_in_one_file(self):
        self.setup()
        self.same(["checkout", "-b", "topic"], out=False)
        self.x.write("text.txt", "".join("LINE 2 (topic)\n" if i == 2 else f"line {i}\n" for i in range(1, 21)))
        self.same(["add", "."], out=False)
        self.commit("topic edits top")
        self.same(["checkout", "main"], out=False)
        self.x.write("text.txt", "".join("LINE 18 (main)\n" if i == 18 else f"line {i}\n" for i in range(1, 21)))
        self.same(["add", "."], out=False)
        self.commit("main edits bottom")
        self.x.tick()
        self.same(["merge", "topic"], out=False)
        self.state()

    def test_conflict_then_resolution(self):
        self.setup()
        self.same(["checkout", "-b", "topic"], out=False)
        self.x.write("text.txt", "".join("topic says 10\n" if i == 10 else f"line {i}\n" for i in range(1, 21)))
        self.same(["add", "."], out=False)
        self.commit("topic")
        self.same(["checkout", "main"], out=False)
        self.x.write("text.txt", "".join("main says 10\n" if i == 10 else f"line {i}\n" for i in range(1, 21)))
        self.same(["add", "."], out=False)
        self.commit("main")
        self.x.tick()
        p, _ = self.same(["merge", "topic"], out=False)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(self.x.files(self.x.p), self.x.files(self.x.g))
        self.assertTrue(os.path.exists(os.path.join(self.x.p, ".git", "MERGE_HEAD")))
        self.x.write("text.txt", "resolved\n")
        self.same(["add", "text.txt"], out=False)
        self.x.tick()
        self.same(["commit", "-m", "resolve"], first_line=True)
        self.assertFalse(os.path.exists(os.path.join(self.x.p, ".git", "MERGE_HEAD")))
        self.state()
        self.same(["log", "-n", "1"])

    def test_merge_message_into_other_branch(self):
        self.setup()
        self.same(["branch", "other"], out=False)
        self.same(["checkout", "-b", "dev"], out=False)
        self.x.write("d.txt", "d\n")
        self.same(["add", "."], out=False)
        self.commit("dev")
        self.same(["checkout", "other"], out=False)
        self.x.write("o.txt", "o\n")
        self.same(["add", "."], out=False)
        self.commit("other")
        self.x.tick()
        self.same(["merge", "dev"], out=False)
        self.state()
        self.same(["log", "-n", "1"])


class ResetAndDiff(Base):
    def setup(self):
        self.init()
        for i in range(3):
            self.x.write("f.txt", f"version {i}\n")
            self.x.write(f"g{i}.txt", "g\n")
            self.same(["add", "."], out=False)
            self.commit(f"c{i}")

    def test_reset_modes(self):
        for mode in ("--soft", "--mixed", "--hard"):
            self.x.cleanup()
            self.x = Pair()
            self.setup()
            self.x.write("f.txt", "dirty\n")
            self.same(["reset", mode, "HEAD~1"], out=False)
            self.same(["status", "--porcelain"])
            self.state()

    def test_reset_default_unstages(self):
        self.setup()
        self.x.write("g0.txt", "staged\n")
        self.same(["add", "g0.txt"], out=False)
        self.same(["reset"], out=False)
        self.same(["status", "--porcelain"])

    def test_diff_name_status(self):
        self.setup()
        self.x.write("f.txt", "worktree\n")
        self.x.remove("g1.txt")
        self.x.write("g2.txt", "staged\n")
        self.x.write("new.txt", "new\n")
        self.same(["add", "g2.txt", "new.txt"], out=False)
        self.same(["diff", "--name-status"])
        self.same(["diff", "--name-status", "--cached"])
        self.same(["diff", "--name-status", "HEAD~2"])


class Interop(Base):
    def test_git_reads_pygit_history(self):
        self.init()
        for i in range(3):
            self.x.write(f"d{i}/file.txt", f"{i}\n" * (i + 1))
            self.same(["add", "."], out=False)
            self.commit(f"step {i}")
        self.same(["checkout", "-b", "side", "HEAD~1"], out=False)
        self.x.write("side.txt", "s\n")
        self.same(["add", "."], out=False)
        self.commit("side")
        self.same(["checkout", "main"], out=False)
        self.x.tick()
        self.same(["merge", "side"], out=False)
        self.x.tick()
        self.same(["tag", "-a", "v1", "-m", "v1"], out=False)
        self.assertEqual(self.x.run_g(["fsck", "--strict", "--no-dangling"], repo=self.x.p).stderr, "")
        for args in (["log", "--all", "--oneline", "--graph"], ["show-ref"], ["cat-file", "-p", "v1"]):
            self.assertEqual(self.x.run_g(args, repo=self.x.p).stdout, self.x.run_g(args).stdout)

    def test_pygit_reads_packed_repository(self):
        self.init()
        big = [f"line {i} " + "x" * 40 + "\n" for i in range(300)]
        for i in range(6):
            big[i * 40] = f"changed in commit {i}\n"
            self.x.write("big.txt", "".join(big))
            self.x.write(f"f{i}.txt", f"{i}\n")
            self.x.run_g(["add", "."])
            self.x.tick()
            self.x.run_g(["commit", "-m", f"c{i}"])
        self.x.run_g(["tag", "v0", "HEAD~5"])
        self.x.run_g(["branch", "old", "HEAD~3"])
        self.x.run_g(["gc", "--aggressive", "--prune=now", "-q"])
        self.assertFalse(any(os.path.isdir(os.path.join(self.x.g, ".git", "objects", d)) and len(d) == 2
                             for d in os.listdir(os.path.join(self.x.g, ".git", "objects"))))
        shutil.rmtree(self.x.p)
        shutil.copytree(self.x.g, self.x.p)
        self.same(["log", "--oneline"])
        self.same(["rev-parse", "v0"])
        self.same(["rev-parse", "old"])
        self.same(["branch"])
        blob = self.x.run_g(["rev-parse", "HEAD~4:big.txt"]).stdout.strip()
        self.same(["cat-file", "-p", blob])
        self.same(["ls-tree", "-r", "HEAD~2"])
        self.same(["status", "--porcelain"])
        self.same(["checkout", "old"], out=False)
        self.state()
        self.x.write("after.txt", "a\n")
        self.same(["add", "."], out=False)
        self.commit("after gc")
        self.assertEqual(self.x.run_g(["fsck", "--strict"], repo=self.x.p).returncode, 0)


class Performance(Base):
    def test_two_thousand_files(self):
        self.init()
        for i in range(2000):
            self.x.write(f"d{i % 20}/s{i % 7}/file{i}.txt", f"content {i}\n" * (1 + i % 5))
        start = time.time()
        p = self.x.run_p(["add", "."])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.x.tick()
        p = self.x.run_p(["commit", "-m", "many"])
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertLess(time.time() - start, 15)
        self.x.run_g(["add", "."])
        self.x.run_g(["commit", "-m", "many"])
        self.assertEqual(self.x.run_p(["rev-parse", "HEAD"]).stdout, self.x.run_g(["rev-parse", "HEAD"]).stdout)
        self.x.write("d3/s3/file3.txt", "edited\n")
        start = time.time()
        p = self.x.run_p(["status", "--porcelain"])
        self.assertLess(time.time() - start, 3)
        self.assertEqual(p.stdout, " M d3/s3/file3.txt\n")


class Delivery(unittest.TestCase):
    def sources(self):
        out = []
        for root, _, files in os.walk(os.path.join(PROJECT, "pygit")):
            out += [os.path.join(root, f) for f in files if f.endswith(".py")]
        return out

    def test_package_exists(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "pygit", "__main__.py")))

    def test_no_external_programs_and_stdlib_only(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*)\b")
        files = self.sources()
        self.assertTrue(files)
        stdlib = set(sys.stdlib_module_names) | {"pygit"}
        for path in files:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
            self.assertIsNone(banned.search(text), path)
            for m in re.finditer(r"^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+))", text, re.M):
                if m.group(1):
                    continue
                name = (m.group(2) or m.group(3)).split(".")[0]
                self.assertIn(name, stdlib, f"{path}: {name}")

    def test_own_tests(self):
        p = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."], cwd=PROJECT,
                           capture_output=True, text=True, timeout=900)
        m = re.search(r"Ran (\d+) tests?", p.stderr)
        self.assertEqual(p.returncode, 0, p.stderr[-2000:])
        self.assertTrue(m and int(m.group(1)) >= 40, p.stderr[-500:])

    def test_docs(self):
        for name in ("README.md", os.path.join("docs", "design.md")):
            path = os.path.join(PROJECT, name)
            self.assertTrue(os.path.isfile(path), name)
            with open(path, encoding="utf-8", errors="replace") as fh:
                self.assertGreater(len(fh.read().strip()), 300, name)


if __name__ == "__main__":
    unittest.main()
