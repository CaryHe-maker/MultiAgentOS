"""Hidden tests of the pyarchive task. tar and gzip results are compared with GNU tar 1.35 and GNU gzip 1.13
of the image at test time; zip results with Info-ZIP fixtures (fixtures/, built by build_fixtures.py) and
with Python's zipfile as an independent reader."""

import gzip as pygzip
import json
import os
import random
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
import zlib

PROJECT = os.environ.get("PROJECT", os.getcwd())
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
EXPECTED = json.load(open(os.path.join(FIX, "expected.json")))
ENV = {"PATH": "/usr/local/bin", "LC_ALL": "C", "TZ": "UTC", "PYTHONPATH": PROJECT}
GNU_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C", "TZ": "UTC"}
DET = ["--mtime=@1700000000", "--owner=0", "--group=0", "--numeric-owner", "--sort=name"]


def pa(args, cwd, stdin=None, timeout=120):
    return subprocess.run([sys.executable, "-m", "pyarchive"] + args, cwd=cwd, input=stdin, capture_output=True,
                          env=ENV, timeout=timeout)


def gnu(args, cwd, stdin=None):
    return subprocess.run(args, cwd=cwd, input=stdin, capture_output=True, env=GNU_ENV, timeout=120)


def text_corpus(n_bytes, seed=1):
    rng = random.Random(seed)
    vocab = ["the", "archive", "compress", "data", "stream", "block", "huffman", "tree", "symbol", "length",
             "distance", "window", "match", "literal", "of", "and", "to", "in", "is", "a"] + [
        "".join(rng.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(rng.randint(3, 9))) for _ in range(300)]
    out, size = [], 0
    while size < n_bytes:
        line = " ".join(rng.choice(vocab) for _ in range(rng.randint(5, 14))) + (".\n" if rng.random() < .3 else "\n")
        out.append(line)
        size += len(line)
    return "".join(out)[:n_bytes].encode()


def binary_corpus(n, seed=2):
    rng = random.Random(seed)
    chunks = []
    while sum(map(len, chunks)) < n:
        kind = rng.random()
        if kind < 0.3:
            chunks.append(bytes(rng.randrange(256) for _ in range(rng.randint(10, 400))))
        elif kind < 0.6:
            chunks.append(bytes([rng.randrange(256)]) * rng.randint(5, 600))
        else:
            chunks.append(struct.pack("<" + "I" * 50, *[rng.randrange(1000) for _ in range(50)]))
    return b"".join(chunks)[:n]


def make_tree(root, long_names=False):
    rng = random.Random(3)
    entries = {
        "tree/a.txt": b"alpha\n" * 30, "tree/empty": b"", "tree/sub/b.bin": bytes(rng.randrange(256) for _ in range(3000)),
        "tree/sub/deeper/c.txt": text_corpus(20000, 5), "tree/run.sh": b"#!/bin/sh\necho hi\n",
    }
    if long_names:
        entries["tree/" + "d" * 60 + "/" + "x" * 80 + ".txt"] = b"long name\n"
        entries["tree/" + "n" * 150] = b"very long file name\n"
    for name, data in entries.items():
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
    os.chmod(os.path.join(root, "tree/run.sh"), 0o755)
    os.symlink("a.txt", os.path.join(root, "tree/link"))
    os.link(os.path.join(root, "tree/a.txt"), os.path.join(root, "tree/hard"))
    for dirpath, dirs, names in os.walk(os.path.join(root, "tree")):
        for n in names + dirs:
            p = os.path.join(dirpath, n)
            if not os.path.islink(p):
                os.utime(p, (1690000000, 1690000000))
    os.utime(os.path.join(root, "tree"), (1690000000, 1690000000))
    return entries


def snapshot(root):
    """Contents, modes, mtimes and link targets below root."""
    out = {}
    for dirpath, dirs, names in os.walk(root):
        for n in sorted(dirs + names):
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, root)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                out[rel] = ("link", os.readlink(p))
            elif stat.S_ISDIR(st.st_mode):
                out[rel] = ("dir", stat.S_IMODE(st.st_mode))
            else:
                out[rel] = ("file", open(p, "rb").read(), stat.S_IMODE(st.st_mode), int(st.st_mtime), st.st_nlink > 1)
    return out


class Base(unittest.TestCase):
    def setUp(self):
        self.assertTrue(os.path.isfile(os.path.join(PROJECT, "pyarchive", "__main__.py")))
        self.d = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)


class TarCreate(Base):
    def compare_create(self, fmt, long_names=False, mode=None):
        make_tree(self.d, long_names)
        opts = [f"--format={fmt}"] + DET + ([f"--mode={mode}"] if mode else [])
        p = pa(["tar", "-c", "-f", "ours.tar"] + opts + ["tree"], self.d)
        self.assertEqual(p.returncode, 0, p.stderr.decode()[-500:])
        g = gnu(["tar", "-c", "-f", "gnu.tar"] + opts + ["tree"], self.d)
        self.assertEqual(g.returncode, 0, g.stderr)
        self.assertEqual(open(os.path.join(self.d, "ours.tar"), "rb").read(), open(os.path.join(self.d, "gnu.tar"), "rb").read())

    def test_ustar_bytes(self):
        self.compare_create("ustar")

    def test_ustar_bytes_with_mode(self):
        self.compare_create("ustar", mode="644")

    def test_gnu_bytes_long_names(self):
        self.compare_create("gnu", long_names=True)

    def test_gnu_bytes_single_file_and_dir_args(self):
        make_tree(self.d)
        args = ["--format=gnu"] + DET + ["tree/a.txt", "tree/sub"]
        pa(["tar", "-c", "-f", "o.tar"] + args, self.d)
        gnu(["tar", "-c", "-f", "g.tar"] + args, self.d)
        self.assertEqual(open(os.path.join(self.d, "o.tar"), "rb").read(), open(os.path.join(self.d, "g.tar"), "rb").read())

    def test_C_option(self):
        make_tree(self.d)
        args = ["--format=ustar"] + DET + ["-C", "tree", "sub"]
        pa(["tar", "-c", "-f", "o.tar"] + args, self.d)
        gnu(["tar", "-c", "-f", "g.tar"] + args, self.d)
        self.assertEqual(open(os.path.join(self.d, "o.tar"), "rb").read(), open(os.path.join(self.d, "g.tar"), "rb").read())

    def test_gzipped_archive_readable_by_gnu_tar(self):
        make_tree(self.d, long_names=True)
        p = pa(["tar", "-c", "-z", "-f", "o.tgz", "--format=gnu"] + DET + ["tree"], self.d)
        self.assertEqual(p.returncode, 0, p.stderr.decode()[-500:])
        g = gnu(["tar", "-t", "-z", "-f", "o.tgz"], self.d)
        self.assertEqual(g.returncode, 0, g.stderr)
        out = os.path.join(self.d, "x")
        os.makedirs(out)
        self.assertEqual(gnu(["tar", "-x", "-z", "-f", "../o.tgz"], out).returncode, 0)
        strip = lambda snap: {k: (v[:3] if v[0] == "file" else v) for k, v in snap.items()}  # noqa: E731
        self.assertEqual(strip(snapshot(os.path.join(out, "tree"))), strip(snapshot(os.path.join(self.d, "tree"))))


class TarRead(Base):
    def gnu_archive(self, fmt, gz=False, long_names=True):
        make_tree(self.d, long_names)
        name = f"g.{fmt}.tar" + (".gz" if gz else "")
        args = ["tar", "-c"] + (["-z"] if gz else []) + ["-f", name, f"--format={fmt}", "tree"]
        self.assertEqual(gnu(args, self.d).returncode, 0)
        return name

    def extract_and_compare(self, name):
        out = os.path.join(self.d, "out")
        os.makedirs(out)
        p = pa(["tar", "-x", "-f", os.path.join(self.d, name), "-C", out], self.d)
        self.assertEqual(p.returncode, 0, p.stderr.decode()[-500:])
        self.assertEqual(snapshot(os.path.join(out, "tree")), snapshot(os.path.join(self.d, "tree")))

    def test_extract_ustar(self):
        self.extract_and_compare(self.gnu_archive("ustar", long_names=False))

    def test_extract_gnu_longlink(self):
        self.extract_and_compare(self.gnu_archive("gnu"))

    def test_extract_pax(self):
        self.extract_and_compare(self.gnu_archive("pax"))

    def test_extract_gzipped(self):
        self.extract_and_compare(self.gnu_archive("gnu", gz=True))

    def test_list_verbose_matches_gnu(self):
        for fmt in ("ustar", "gnu", "pax"):
            shutil.rmtree(self.d)
            os.makedirs(self.d)
            name = self.gnu_archive(fmt, long_names=(fmt != "ustar"))
            ours = pa(["tar", "-t", "-v", "-f", name], self.d)
            theirs = gnu(["tar", "-t", "-v", "-f", name], self.d)
            self.assertEqual(ours.stdout.decode(), theirs.stdout.decode(), fmt)
            ours = pa(["tar", "-t", "-f", name], self.d)
            theirs = gnu(["tar", "-t", "-f", name], self.d)
            self.assertEqual(ours.stdout.decode(), theirs.stdout.decode(), fmt)

    def test_list_own_archive_matches_gnu_listing(self):
        make_tree(self.d, long_names=True)
        pa(["tar", "-c", "-f", "o.tar", "--format=gnu"] + DET + ["tree"], self.d)
        self.assertEqual(pa(["tar", "-t", "-v", "-f", "o.tar"], self.d).stdout.decode(),
                         gnu(["tar", "-t", "-v", "-f", "o.tar"], self.d).stdout.decode())

    def test_refuses_dotdot_members(self):
        evil = os.path.join(self.d, "evil.tar")
        with open(evil, "wb") as f:
            data = b"pwned\n"
            hdr = bytearray(512)
            name = b"../escaped.txt"
            hdr[0:len(name)] = name
            hdr[100:108] = b"0000644\0"
            hdr[108:116] = b"0000000\0"
            hdr[116:124] = b"0000000\0"
            hdr[124:136] = b"%011o\0" % len(data)
            hdr[136:148] = b"14544643200\0"
            hdr[156:157] = b"0"
            hdr[257:263] = b"ustar\0"
            hdr[263:265] = b"00"
            hdr[148:156] = b" " * 8
            hdr[148:156] = b"%06o\0 " % sum(hdr)
            f.write(bytes(hdr) + data + bytes(512 - len(data)) + bytes(1024))
        out = os.path.join(self.d, "inside")
        os.makedirs(out)
        p = pa(["tar", "-x", "-f", evil, "-C", out], self.d)
        self.assertEqual(p.returncode, 2)
        self.assertFalse(os.path.exists(os.path.join(self.d, "escaped.txt")))


class Gzip(Base):
    def corpora(self):
        return {"text": text_corpus(300000), "binary": binary_corpus(200000), "zeros": bytes(100000),
                "empty": b"", "one": b"x", "short": b"hello hello hello\n"}

    def test_decompress_gnu_outputs(self):
        for name, data in self.corpora().items():
            for level in ("-1", "-6", "-9"):
                comp = gnu(["gzip", "-c", "-n", level], self.d, stdin=data).stdout
                p = pa(["gzip", "-d", "-c"], self.d, stdin=comp)
                self.assertEqual(p.returncode, 0, (name, level, p.stderr.decode()[-300:]))
                self.assertEqual(p.stdout, data, (name, level))

    def test_multi_member_and_header_fields(self):
        a, b = text_corpus(5000, 8), binary_corpus(5000, 9)
        member_a = gnu(["gzip", "-c", "-n"], self.d, stdin=a).stdout
        raw_b = zlib.compress(b, 9)[2:-4]
        header = bytearray(b"\x1f\x8b\x08\x1e") + struct.pack("<I", 1700000000) + b"\x00\x03"
        header += struct.pack("<H", 4) + b"AB\x00\x00" + b"name.bin\x00" + b"a comment\x00"
        header += struct.pack("<H", zlib.crc32(bytes(header)) & 0xFFFF)
        member_b = bytes(header) + raw_b + struct.pack("<II", zlib.crc32(b), len(b))
        p = pa(["gzip", "-d", "-c"], self.d, stdin=member_a + member_b)
        self.assertEqual((p.returncode, p.stdout), (0, a + b))

    def test_stored_and_fixed_blocks(self):
        data = binary_corpus(70000, 4)
        for co in (zlib.compressobj(0, zlib.DEFLATED, -15), zlib.compressobj(9, zlib.DEFLATED, -15, 9, zlib.Z_FIXED)):
            raw = co.compress(data) + co.flush()
            gz = b"\x1f\x8b\x08\x00" + bytes(6) + raw + struct.pack("<II", zlib.crc32(data), len(data))
            self.assertEqual(pa(["gzip", "-d", "-c"], self.d, stdin=gz).stdout, data)

    def test_corrupt_input_fails(self):
        comp = bytearray(gnu(["gzip", "-c", "-n"], self.d, stdin=text_corpus(20000)).stdout)
        comp[-6] ^= 0xFF
        p = pa(["gzip", "-d", "-c"], self.d, stdin=bytes(comp))
        self.assertEqual(p.returncode, 1)
        self.assertEqual(pa(["gzip", "-t"], self.d, stdin=b"not gzip at all").returncode, 1)

    def test_compress_valid_and_ratio(self):
        limits = {"-1": 1.25, "-6": 1.10, "-9": 1.10}
        for name, data in self.corpora().items():
            for level, limit in limits.items():
                ours = pa(["gzip", "-c", "-n", level], self.d, stdin=data, timeout=300)
                self.assertEqual(ours.returncode, 0, (name, level))
                self.assertEqual(pygzip.decompress(ours.stdout), data, (name, level))
                self.assertEqual(gnu(["gzip", "-d", "-c"], self.d, stdin=ours.stdout).stdout, data, (name, level))
                theirs = gnu(["gzip", "-c", "-n", level], self.d, stdin=data).stdout
                if len(data) > 1000:
                    self.assertLessEqual(len(ours.stdout), limit * len(theirs), (name, level, len(ours.stdout), len(theirs)))
                self.assertEqual(ours.stdout[3] & 0x08, 0, "-n must not store a name")

    def test_file_mode_behaviour(self):
        path = os.path.join(self.d, "f.txt")
        data = text_corpus(10000)
        with open(path, "wb") as f:
            f.write(data)
        self.assertEqual(pa(["gzip", "f.txt"], self.d).returncode, 0)
        self.assertFalse(os.path.exists(path))
        self.assertEqual(pygzip.open(path + ".gz").read(), data)
        self.assertEqual(pa(["gzip", "-d", "-k", "f.txt.gz"], self.d).returncode, 0)
        self.assertTrue(os.path.exists(path + ".gz"))
        self.assertEqual(open(path, "rb").read(), data)
        os.remove(path)
        self.assertEqual(pa(["gunzip", "f.txt.gz"], self.d).returncode, 0)
        self.assertEqual(open(path, "rb").read(), data)
        self.assertEqual(pa(["gzip", "-k", "f.txt"], self.d).returncode, 0)
        self.assertEqual(pa(["gzip", "-t", "f.txt.gz"], self.d).returncode, 0)

    def test_list_matches_gnu(self):
        for name, data in (("a.txt", text_corpus(50000)), ("b.bin", binary_corpus(30000)), ("z", bytes(5000))):
            with open(os.path.join(self.d, name), "wb") as f:
                f.write(data)
            gnu(["gzip", "-k", "-9", name], self.d)
        files = ["a.txt.gz", "b.bin.gz", "z.gz"]
        self.assertEqual(pa(["gzip", "-l"] + files, self.d).stdout.decode(), gnu(["gzip", "-l"] + files, self.d).stdout.decode())

    def test_speed(self):
        data = text_corpus(1000000, 11)
        start = time.time()
        comp = pa(["gzip", "-c", "-n", "-6"], self.d, stdin=data, timeout=300).stdout
        self.assertLess(time.time() - start, 20)
        start = time.time()
        self.assertEqual(pa(["gzip", "-d", "-c"], self.d, stdin=comp, timeout=300).stdout, data)
        self.assertLess(time.time() - start, 20)


class Zip(Base):
    def test_unzip_list_matches_info_zip(self):
        for name, expected in EXPECTED["unzip_l"].items():
            shutil.copy(os.path.join(FIX, name), self.d)
            p = pa(["unzip", "-l", name], self.d)
            self.assertEqual(p.stdout.decode(), expected, name)

    def test_unzip_extract_info_zip_archives(self):
        for name in ("deflate9.zip", "deflate1.zip", "stored.zip"):
            out = os.path.join(self.d, name + ".out")
            os.makedirs(out)
            p = pa(["unzip", "-q", "-d", out, os.path.join(FIX, name)], self.d)
            self.assertEqual(p.returncode, 0, (name, p.stderr.decode()[-300:]))
            ours = snapshot(os.path.join(out, "proj"))
            ref = snapshot(os.path.join(FIX, "proj"))
            self.assertEqual({k: v[1] for k, v in ours.items() if v[0] == "file"},
                             {k: v[1] for k, v in ref.items() if v[0] == "file"}, name)
            self.assertEqual({k: v[2] for k, v in ours.items() if v[0] == "file"}, EXPECTED["modes"], name)

    def test_unzip_streamed_data_descriptor(self):
        p = pa(["unzip", "-q", "-o", "-d", self.d, os.path.join(FIX, "stream.zip")], self.d)
        self.assertEqual(p.returncode, 0, p.stderr.decode()[-300:])
        self.assertEqual(open(os.path.join(self.d, "-"), "rb").read(),
                         open(os.path.join(FIX, "proj", "README.txt"), "rb").read())

    def test_unzip_test_and_corruption(self):
        self.assertEqual(pa(["unzip", "-t", "-q", os.path.join(FIX, "deflate9.zip")], self.d).returncode, 0)
        bad = bytearray(open(os.path.join(FIX, "deflate9.zip"), "rb").read())
        with zipfile.ZipFile(os.path.join(FIX, "deflate9.zip")) as z:
            info = z.getinfo("proj/README.txt")
        name_len, extra_len = struct.unpack("<HH", bad[info.header_offset + 26:info.header_offset + 30])
        i = info.header_offset + 30 + name_len + extra_len + info.compress_size // 2
        bad[i] ^= 0xFF
        with open(os.path.join(self.d, "bad.zip"), "wb") as f:
            f.write(bad)
        self.assertNotEqual(pa(["unzip", "-t", "-q", "bad.zip"], self.d).returncode, 0)

    def test_zip_create_readable(self):
        make_tree(self.d)
        os.remove(os.path.join(self.d, "tree/link"))
        for level, method in (("-9", zipfile.ZIP_DEFLATED), ("-0", zipfile.ZIP_STORED)):
            name = f"o{level}.zip"
            p = pa(["zip", "-q", "-r", level, name, "tree"], self.d)
            self.assertEqual(p.returncode, 0, p.stderr.decode()[-300:])
            with zipfile.ZipFile(os.path.join(self.d, name)) as z:
                self.assertIsNone(z.testzip())
                for info in z.infolist():
                    if info.is_dir():
                        continue
                    if method == zipfile.ZIP_STORED or info.filename.endswith(".txt") and info.file_size > 100:
                        self.assertEqual(info.compress_type, method, info.filename)
                    self.assertEqual(z.read(info), open(os.path.join(self.d, info.filename), "rb").read())
                    self.assertEqual(stat.S_IMODE(info.external_attr >> 16),
                                     stat.S_IMODE(os.stat(os.path.join(self.d, info.filename)).st_mode), info.filename)
                names = sorted(i.filename for i in z.infolist())
                self.assertIn("tree/sub/deeper/c.txt", names)
                self.assertIn("tree/sub/", names)

    def test_zip_deflate_ratio_and_append(self):
        data = text_corpus(200000, 12)
        with open(os.path.join(self.d, "big.txt"), "wb") as f:
            f.write(data)
        pa(["zip", "-q", "-9", "a.zip", "big.txt"], self.d)
        with zipfile.ZipFile(os.path.join(self.d, "a.zip")) as z:
            self.assertLessEqual(z.getinfo("big.txt").compress_size, 1.10 * len(zlib.compress(data, 9)))
        with open(os.path.join(self.d, "second.txt"), "w") as f:
            f.write("second\n")
        self.assertEqual(pa(["zip", "-q", "a.zip", "second.txt"], self.d).returncode, 0)
        with zipfile.ZipFile(os.path.join(self.d, "a.zip")) as z:
            self.assertEqual(sorted(z.namelist()), ["big.txt", "second.txt"])
            self.assertIsNone(z.testzip())

    def test_round_trip_own_zip(self):
        make_tree(self.d)
        os.remove(os.path.join(self.d, "tree/link"))
        pa(["zip", "-q", "-r", "rt.zip", "tree"], self.d)
        out = os.path.join(self.d, "rt")
        os.makedirs(out)
        self.assertEqual(pa(["unzip", "-q", "-d", out, "rt.zip"], self.d).returncode, 0)
        ours = snapshot(os.path.join(out, "tree"))
        ref = snapshot(os.path.join(self.d, "tree"))
        self.assertEqual({k: v[1:3] for k, v in ours.items() if v[0] == "file"},
                         {k: v[1:3] for k, v in ref.items() if v[0] == "file"})


class Delivery(unittest.TestCase):
    def test_no_forbidden_modules_or_programs(self):
        banned = re.compile(r"\b(subprocess|os\.system|os\.exec\w*|os\.spawn\w*|os\.popen|pty|os\.posix_spawn\w*"
                            r"|binascii\.crc32|make_archive|unpack_archive|__import__|importlib)\b")
        files = []
        for root, _, names in os.walk(os.path.join(PROJECT, "pyarchive")):
            files += [os.path.join(root, n) for n in names if n.endswith(".py")]
        self.assertTrue(files)
        forbidden = {"zlib", "gzip", "zipfile", "tarfile", "bz2", "lzma", "zipimport", "subprocess", "pty", "importlib"}
        allowed = (set(sys.stdlib_module_names) - forbidden) | {"pyarchive"}
        for path in files:
            text = open(path, encoding="utf-8", errors="replace").read()
            self.assertIsNone(banned.search(text), path)
            for m in re.finditer(r"^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))", text, re.M):
                if m.group(1):
                    continue
                names = [m.group(2)] if m.group(2) else [n.strip() for n in m.group(3).split(",")]
                for name in names:
                    self.assertIn(name.split(".")[0], allowed, f"{path}: {name}")

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
            self.assertGreater(len(open(path, encoding="utf-8", errors="replace").read().strip()), 300, name)


if __name__ == "__main__":
    unittest.main()
