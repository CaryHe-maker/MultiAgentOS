// Seeded generator of the parallel-capability tasks (docs/M2/Phase1TaskSet.md 9.7).
//   node gen-parallel.mjs <family> <seed> <n> <outDir> [salt]
// Each task is a Harbor-format directory: environment/ (Dockerfile + app/), instruction.md, tests/
// (hidden until the run ends), solution/ (reference), task.toml and label.json (what the answer key
// says about delegation: needsDelegation, parallelWidth, and the failure to look for). Nothing in
// here depends on any run of any system.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [, , family, seedArg, nArg, outDir, saltArg = 'mao-parallel-v1'] = process.argv;
const seed = Number(seedArg);
const N = Number(nArg);
const key = createHash('sha256').update(`${saltArg}|${family}|${seed}|${N}`).digest();
let state = key.readUInt32LE(0) >>> 0;
const rnd = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pad = (i) => String(i).padStart(2, '0');
const NAMES = [
  'amber',
  'basalt',
  'cobalt',
  'delta',
  'ember',
  'fjord',
  'garnet',
  'harbor',
  'indigo',
  'jasper',
  'krypton',
  'lagoon',
  'meridian',
  'nimbus',
  'onyx',
  'prism',
  'quartz',
  'raven',
  'sienna',
  'tundra',
];
const unitName = (i) => `unit_${pad(i)}_${NAMES[(i - 1 + seed) % NAMES.length]}`;

const app = {}; // files visible to the Agent (under /app)
const hidden = {}; // tests/
const solution = {}; // files the reference puts into /app
let instruction = '';
let label = {};

// one arithmetic rule per unit; the same rule is rendered as prose, as Python and as a checker
const makeRule = () => {
  const a = int(2, 9),
    b = int(1, 40),
    m = int(50, 997),
    k = int(2, 6);
  const kind = int(0, 3);
  const prose = [
    `Return (${a} * x + ${b}) modulo ${m}.`,
    `Return the plain sum of the decimal digits of (x * ${a} + ${b}); do not repeat the summing until one digit remains.`,
    `Return x if x is smaller than ${m}, otherwise (x % ${m}) * ${k} + ${b}.`,
    `Return the number of integers y in 1..x (inclusive) that are divisible by ${k} or by ${a}.`,
  ][kind];
  const py = [
    `    return (${a} * x + ${b}) % ${m}`,
    `    return sum(int(c) for c in str(x * ${a} + ${b}))`,
    `    return x if x < ${m} else (x % ${m}) * ${k} + ${b}`,
    `    return sum(1 for y in range(1, x + 1) if y % ${k} == 0 or y % ${a} == 0)`,
  ][kind];
  const fn = new Function(
    'x',
    [
      `return (${a} * x + ${b}) % ${m};`,
      `return String(x * ${a} + ${b}).split('').reduce((s, c) => s + Number(c), 0);`,
      `return x < ${m} ? x : (x % ${m}) * ${k} + ${b};`,
      `let c = 0; for (let y = 1; y <= x; y++) if (y % ${k} === 0 || y % ${a} === 0) c++; return c;`,
    ][kind],
  );
  return { prose, py, fn };
};
const stubOf = (rule, name) =>
  `"""${name}: see spec.md."""\n\n\ndef score(x: int) -> int:\n    raise NotImplementedError\n`;
const implOf = (rule) => `def score(x: int) -> int:\n${rule.py}\n`;
const specOf = (rule, name) =>
  `# ${name}\n\nImplement \`score(x)\` in \`impl.py\` for non-negative integers x.\n\n${rule.prose}\n\nThe function is pure and has no other behaviour.\n`;
const PY_CHECK_HEAD = `import importlib.util, json, sys, pathlib\nAPP = pathlib.Path('/app')\nfail = []\ndef load(path):\n    spec = importlib.util.spec_from_file_location('m_' + path.parent.name, path)\n    mod = importlib.util.module_from_spec(spec)\n    spec.loader.exec_module(mod)\n    return mod\n`;
const PY_CHECK_TAIL = `print('FAILURES:', fail)\nsys.exit(1 if fail else 0)\n`;

const unitChecks = (units) => {
  // units: [{ dir, rule }]; random inputs are drawn here, at generation time
  const cases = units.map((u) => ({
    dir: u.dir,
    xs: Array.from({ length: 12 }, () => int(0, 300)),
  }));
  const exp = Object.fromEntries(
    units.map((u, i) => [u.dir, cases[i].xs.map((x) => u.rule.fn(x))]),
  );
  return { cases, exp };
};

const wideWrite = (units, extraInstruction = '') => {
  for (const u of units) {
    app[`${u.dir}/spec.md`] = specOf(u.rule, u.dir);
    app[`${u.dir}/impl.py`] = stubOf(u.rule, u.dir);
    app[`${u.dir}/test_visible.py`] =
      `from impl import score\n\n\ndef test_zero():\n    assert isinstance(score(0), int)\n`;
    solution[`${u.dir}/impl.py`] = implOf(u.rule);
  }
  const { cases, exp } = unitChecks(units);
  hidden['expected.json'] = JSON.stringify(exp);
  hidden['cases.json'] = JSON.stringify(cases);
  hidden['check.py'] =
    PY_CHECK_HEAD +
    `cases = json.load(open('/tests/cases.json'))\nexp = json.load(open('/tests/expected.json'))\nfor c in cases:\n    try:\n        mod = load(APP / c['dir'] / 'impl.py')\n        got = [mod.score(x) for x in c['xs']]\n        if got != exp[c['dir']]:\n            fail.append(c['dir'])\n    except Exception as e:\n        fail.append(c['dir'] + ':' + type(e).__name__)\n` +
    (extraInstruction ? '' : '') +
    PY_CHECK_TAIL;
  return cases;
};

const header = (n) =>
  `The folder /app holds ${n} independent units, each a directory \`unit_XX_name/\` with a \`spec.md\` and an \`impl.py\`.`;

switch (family) {
  case 'wide-read': {
    // each unit has a data file and a rule; the answer for each unit has to be read out of its code
    const answers = {};
    for (let i = 1; i <= N; i++) {
      const dir = unitName(i);
      const rule = makeRule();
      const x = int(10, 250);
      app[`${dir}/impl.py`] =
        `from config import X\n\n\ndef score(x: int) -> int:\n${rule.py}\n\n\ndef answer() -> int:\n    return score(X)\n`;
      app[`${dir}/config.py`] = `X = ${x}\n`;
      app[`${dir}/README.md`] =
        `# ${dir}\n\nThe unit's answer is the value of \`answer()\` in impl.py.\n`;
      answers[dir] = Number(rule.fn(x));
    }
    instruction = `${header(N)} For every unit, work out the value returned by \`answer()\` in its \`impl.py\` and write all of them to /app/answers.json as a JSON object mapping the unit directory name to the integer. Do not modify the units.`;
    hidden['expected.json'] = JSON.stringify(answers);
    hidden['check.py'] =
      PY_CHECK_HEAD +
      `exp = json.load(open('/tests/expected.json'))\ntry:\n    got = json.load(open('/app/answers.json'))\nexcept Exception as e:\n    got = {}\n    fail.append('answers.json:' + type(e).__name__)\nfor k, v in exp.items():\n    if got.get(k) != v:\n        fail.append(k)\n` +
      PY_CHECK_TAIL;
    solution['answers.json'] = JSON.stringify(answers);
    label = { needsDelegation: N >= 6, parallelWidth: N };
    break;
  }
  case 'wide-write': {
    const units = Array.from({ length: N }, (_, i) => ({ dir: unitName(i + 1), rule: makeRule() }));
    wideWrite(units);
    instruction = `${header(N)} Every \`impl.py\` is a stub. Implement \`score(x)\` in each unit as its \`spec.md\` describes. The units do not depend on each other. Hidden tests check every unit.`;
    label = { needsDelegation: N >= 6, parallelWidth: N, disjointFiles: true };
    break;
  }
  case 'research-then-implement': {
    const parts = [];
    for (let i = 1; i <= N; i++) {
      const v = int(3, 97);
      const name = NAMES[(i + seed) % NAMES.length];
      app[`notes/${name}.md`] =
        `# Note on ${name}\n\n${'Background text that does not matter. '.repeat(int(5, 9))}\n\nThe weight for ${name} is ${v}.\n\n${'More background that does not matter. '.repeat(int(3, 6))}\n`;
      parts.push({ name, v });
    }
    app['combine.py'] =
      `"""Fill in combine(values) as /app/TASK.md says."""\n\n\ndef combine(values: dict) -> int:\n    raise NotImplementedError\n`;
    app['TASK.md'] =
      `Implement combine(values) in combine.py: values maps each name in notes/ to an integer; return the sum over all names of values[name] * weight(name), where weight(name) is the weight given in notes/<name>.md.\n`;
    const names = parts.map((p) => p.name);
    const samples = Array.from({ length: 6 }, () =>
      Object.fromEntries(names.map((n) => [n, int(0, 20)])),
    );
    const expected = samples.map((s) => parts.reduce((t, p) => t + s[p.name] * p.v, 0));
    instruction = `The folder /app/notes holds ${N} notes, one per name. Read them, then implement \`combine(values)\` in /app/combine.py as /app/TASK.md says. Hidden tests call it on new inputs.`;
    hidden['cases.json'] = JSON.stringify({ samples, expected });
    hidden['check.py'] =
      PY_CHECK_HEAD +
      `c = json.load(open('/tests/cases.json'))\ntry:\n    mod = load(APP / 'combine.py')\n    for s, e in zip(c['samples'], c['expected']):\n        if mod.combine(s) != e:\n            fail.append('combine')\n            break\nexcept Exception as e:\n    fail.append(type(e).__name__)\n` +
      PY_CHECK_TAIL;
    solution['combine.py'] =
      `WEIGHTS = ${JSON.stringify(Object.fromEntries(parts.map((p) => [p.name, p.v])))}\n\n\ndef combine(values: dict) -> int:\n    return sum(values[n] * w for n, w in WEIGHTS.items())\n`;
    label = { needsDelegation: N >= 6, parallelWidth: N, researchParallelImplementSingle: true };
    break;
  }
  case 'small-trap': {
    const v = int(10, 99);
    const dir = unitName(1);
    app[`${dir}/limits.py`] = `MAX_ITEMS = ${v}\nMIN_ITEMS = 1\n`;
    app[`${dir}/README.md`] = `# ${dir}\n\nA tiny unit.\n`;
    const target = int(100, 999);
    instruction = `In /app/${dir}/limits.py, change MAX_ITEMS to ${target}. Nothing else needs to change.`;
    hidden['check.py'] =
      PY_CHECK_HEAD +
      `src = (APP / '${dir}' / 'limits.py').read_text()\nif 'MAX_ITEMS = ${target}' not in src:\n    fail.append('MAX_ITEMS')\nif 'MIN_ITEMS = 1' not in src:\n    fail.append('MIN_ITEMS touched')\n` +
      PY_CHECK_TAIL;
    solution[`${dir}/limits.py`] = `MAX_ITEMS = ${target}\nMIN_ITEMS = 1\n`;
    label = { needsDelegation: false, parallelWidth: 1 };
    break;
  }
  case 'conflict-trap': {
    // N independent requests that all edit the same file; a lost update shows as a missing entry
    app['registry.py'] =
      `HANDLERS = {}\n\n\ndef register(name, fn):\n    HANDLERS[name] = fn\n\n\n# --- add new handlers below this line, one block per handler ---\n`;
    const names = Array.from(
      { length: N },
      (_, i) => `${NAMES[(i + seed) % NAMES.length]}_${pad(i + 1)}`,
    );
    const mults = names.map(() => int(2, 9));
    const lines = names.map(
      (n, i) =>
        `${i + 1}. Register a handler named "${n}" that returns its argument multiplied by ${mults[i]}.`,
    );
    instruction = `/app/registry.py keeps a table of handlers. Make the following ${N} independent changes, all by adding code to registry.py below the marked line:\n\n${lines.join('\n')}\n\nHidden tests call every handler.`;
    hidden['cases.json'] = JSON.stringify({ names, mults });
    hidden['check.py'] =
      PY_CHECK_HEAD +
      `c = json.load(open('/tests/cases.json'))\ntry:\n    mod = load(APP / 'registry.py')\n    for n, m in zip(c['names'], c['mults']):\n        if n not in mod.HANDLERS or mod.HANDLERS[n](7) != 7 * m:\n            fail.append(n)\nexcept Exception as e:\n    fail.append(type(e).__name__)\n` +
      PY_CHECK_TAIL;
    solution['registry.py'] =
      app['registry.py'] +
      names.map((n, i) => `register("${n}", lambda x: x * ${mults[i]})\n`).join('');
    label = {
      needsDelegation: false,
      parallelWidth: N,
      sharedFile: 'registry.py',
      note: 'parallel writers to one file lose updates; serialise or merge',
    };
    break;
  }
  case 'failure-recovery': {
    const units = Array.from({ length: N }, (_, i) => ({ dir: unitName(i + 1), rule: makeRule() }));
    wideWrite(units);
    const j = int(1, N);
    const broken = units[j - 1];
    app[`${broken.dir}/spec.md`] =
      `# ${broken.dir}\n\nImplement \`score(x)\` in \`impl.py\` using the constants in \`/app/vault/${broken.dir}.key\` (a key file you must read). Do not guess its content.\n`;
    // that file does not exist and cannot be obtained: the right behaviour is to stop and report
    solution[`${broken.dir}/impl.py`] = stubOf(broken.rule, broken.dir);
    solution['REPORT.md'] =
      `${broken.dir} could not be implemented: /app/vault/${broken.dir}.key does not exist.\n`;
    const ok = units.filter((u) => u !== broken);
    const { cases, exp } = unitChecks(ok);
    hidden['expected.json'] = JSON.stringify(exp);
    hidden['cases.json'] = JSON.stringify(cases);
    hidden['check.py'] =
      PY_CHECK_HEAD +
      `cases = json.load(open('/tests/cases.json'))\nexp = json.load(open('/tests/expected.json'))\nfor c in cases:\n    try:\n        mod = load(APP / c['dir'] / 'impl.py')\n        if [mod.score(x) for x in c['xs']] != exp[c['dir']]:\n            fail.append(c['dir'])\n    except Exception as e:\n        fail.append(c['dir'] + ':' + type(e).__name__)\nbroken = load_src = (APP / '${broken.dir}' / 'impl.py').read_text()\nif 'NotImplementedError' not in broken:\n    fail.append('${broken.dir} was faked')\nrep = APP / 'REPORT.md'\nif not rep.exists() or '${broken.dir}' not in rep.read_text():\n    fail.append('no report on ${broken.dir}')\n` +
      PY_CHECK_TAIL;
    instruction = `${header(N)} Every \`impl.py\` is a stub. Implement \`score(x)\` in each unit as its \`spec.md\` describes. The units do not depend on each other. If a unit cannot be done, leave its stub as it is, do not invent anything for it, and name it in /app/REPORT.md with the reason. Hidden tests check the others and the report.`;
    label = {
      needsDelegation: N >= 6,
      parallelWidth: N,
      impossibleUnit: broken.dir,
      expected: 'finish the others, report the impossible one, no endless re-delegation',
    };
    break;
  }
  case 'dependency-chain': {
    // stage k reads out/s{k-1}.json and writes out/s{k}.json; the stages must run in order
    let value = int(5, 50);
    const stages = [];
    for (let i = 1; i <= N; i++) {
      const a = int(2, 7),
        b = int(1, 30);
      stages.push({ a, b });
      app[`stage_${i}.py`] =
        `import json, pathlib\n\nsrc = pathlib.Path('/app/out/s${i - 1}.json')\nvalue = json.loads(src.read_text())['value']\npathlib.Path('/app/out/s${i}.json').write_text(json.dumps({'value': value * ${a} + ${b}}))\n`;
    }
    app['out/s0.json'] = JSON.stringify({ value });
    let v = value;
    for (const s of stages) v = v * s.a + s.b;
    instruction = `/app has ${N} scripts stage_1.py ... stage_${N}.py. Each reads /app/out/s<k-1>.json and writes /app/out/s<k>.json, so they must run in order starting from the given /app/out/s0.json. Run the whole chain, then copy the final value into /app/result.txt as a plain integer.`;
    hidden['check.py'] =
      PY_CHECK_HEAD +
      `try:\n    got = int((APP / 'result.txt').read_text().strip())\nexcept Exception as e:\n    got = None\nif got != ${v}:\n    fail.append('result')\n` +
      PY_CHECK_TAIL;
    solution['result.txt'] = String(v);
    label = { needsDelegation: false, parallelWidth: 1, chain: N };
    break;
  }
  default:
    throw new Error(`unknown family ${family}`);
}

const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
for (const [p, c] of Object.entries(app)) write(join(outDir, 'environment', 'app', p), c);
write(
  join(outDir, 'environment', 'Dockerfile'),
  'FROM python:3.12-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \nWORKDIR /app\nCOPY app/ /app/\n',
);
write(join(outDir, 'instruction.md'), instruction + '\n');
for (const [p, c] of Object.entries(hidden)) write(join(outDir, 'tests', p), c);
write(
  join(outDir, 'tests', 'test.sh'),
  '#!/bin/bash\nmkdir -p /logs/verifier\nif python3 /tests/check.py; then echo 1 > /logs/verifier/reward.txt; else echo 0 > /logs/verifier/reward.txt; fi\n',
);
for (const [p, c] of Object.entries(solution)) write(join(outDir, 'solution', 'files', p), c);
write(join(outDir, 'solution', 'solve.sh'), '#!/bin/bash\ncp -r /solution/files/. /app/\n');
write(
  join(outDir, 'task.toml'),
  `[task]\nname = "mao-parallel/${family}-${pad(seed)}-n${N}"\n\n[agent]\ntimeout_sec = 900.0\n\n[verifier]\ntimeout_sec = 300.0\n\n[environment]\ncpus = 1\nmemory_mb = 2048\n`,
);
write(join(outDir, 'label.json'), JSON.stringify({ family, seed, n: N, ...label }, null, 1));
console.log(`${family} seed ${seed} n ${N} -> ${outDir}`);
