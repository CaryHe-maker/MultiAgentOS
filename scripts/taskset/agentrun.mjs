// Runs one Agent system (mas or dsh) on one Harbor-format task inside the task's container, then runs
// the task's hidden tests, and appends one line of results (docs/M2/Phase1TaskSet.md).
//   node agentrun.mjs <mas|dsh> <taskDir> <outDir> [--label x] [--cap 900] [--record file]
// The key comes from DEEPSEEK_API_KEY or from the file named by MAO_ENV_FILE; it is handed to the
// container through the environment and never printed or recorded.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , system, taskDirArg, outDirArg, ...rest] = process.argv;
const opt = (name, fallback) => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : fallback;
};
const label = opt('--label', 'run');
const cap = Number(opt('--cap', '900'));
const taskDir = resolve(taskDirArg);
const outDir = resolve(outDirArg);
const home = process.env.HOME;
const hereDir = dirname(fileURLToPath(import.meta.url));
const NODE_DIR = dirname(dirname(process.execPath));
const DSH_DIR = `${home}/dshlab`;
const MAO_DIR = process.env.MAO_DIR ?? `${home}/mao2`;
const USAGE_DIR = `${home}/bench/usage`;

const sh = (args, opts = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

// ---- the key, never shown ----------------------------------------------------------------------
let key = (process.env.DEEPSEEK_API_KEY ?? '').trim();
if (key === '' && process.env.MAO_ENV_FILE && existsSync(process.env.MAO_ENV_FILE)) {
  const line = readFileSync(process.env.MAO_ENV_FILE, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('DEEPSEEK_API_KEY='));
  key = (line ?? '')
    .slice('DEEPSEEK_API_KEY='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
}
if (key === '') throw new Error('no DEEPSEEK_API_KEY');
const childEnv = { ...process.env, DEEPSEEK_API_KEY: key };

// ---- the task -----------------------------------------------------------------------------------
const toml = readFileSync(join(taskDir, 'task.toml'), 'utf8');
const get = (re, d) => toml.match(re)?.[1] ?? d;
const taskName = taskDir.split('/').filter(Boolean).pop();
const cpus = get(/cpus = (\d+)/, '1');
const mem = get(/memory_mb = (\d+)/, '2048');
const verifierTimeout = Number(get(/\[verifier\][^[]*?timeout_sec = ([\d.]+)/s, '900'));
let image = get(/docker_image = "([^"]+)"/, undefined);
if (!image) {
  image = `tr-build-${taskName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .slice(0, 50)}`;
  const b = sh(['build', '-q', '-t', image, join(taskDir, 'environment')]);
  if (b.status !== 0) throw new Error('build failed: ' + (b.stderr ?? '').slice(-300));
}
const workdir =
  sh(['image', 'inspect', '-f', '{{.Config.WorkingDir}}', image]).stdout.trim() || '/app';
// Alpine images (musl) cannot run the glibc Node: they get the musl build of Node and of each
// system's dependencies, installed from the same lockfile (`npm ci --libc=musl`).
const musl =
  sh([
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    image,
    '-c',
    'ls /lib/ld-musl-* 2>/dev/null',
  ]).stdout.trim() !== '';
const nodeDir = musl ? `${NODE_DIR}-musl` : NODE_DIR;
const dshDir = musl ? `${DSH_DIR}-musl` : DSH_DIR;
const maoDir = musl ? process.env.MAO_DIR_MUSL : MAO_DIR;
if (musl && (!existsSync(nodeDir) || (system === 'dsh' ? !existsSync(dshDir) : !maoDir)))
  throw new Error(
    `musl image: ${nodeDir}, and ${system === 'dsh' ? dshDir : 'MAO_DIR_MUSL'}, are needed`,
  );
const instruction = readFileSync(join(taskDir, 'instruction.md'), 'utf8');
// `allow_internet = false` in task.toml: the container sits on an internal network where only the
// usage proxy (and through it the model API) is reachable, so no code can be downloaded.
const offline = /^\s*allow_internet\s*=\s*false/m.test(toml);

// ---- the shared proxies -------------------------------------------------------------------------
// `benchproxy` forwards dsh's Anthropic-style requests; `benchproxy-oai` forwards mas's OpenAI-style
// chat completions (offline tasks only; mas counts its own tokens). Both also join the internal network.
mkdirSync(USAGE_DIR, { recursive: true });
sh(['network', 'inspect', 'benchnet']).status === 0 || sh(['network', 'create', 'benchnet']);
sh(['network', 'inspect', 'benchint']).status === 0 ||
  sh(['network', 'create', '--internal', 'benchint']);
function proxy(name, port, target) {
  if (!sh(['ps', '-q', '-f', `name=^${name}$`]).stdout.trim()) {
    sh(['rm', '-f', name]);
    const r = sh([
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'benchnet',
      '-v',
      `${NODE_DIR}:/opt/node:ro`,
      '-v',
      `${hereDir}:/lab:ro`,
      '-v',
      `${USAGE_DIR}:/usage`,
      'python:3.12-slim',
      '/opt/node/bin/node',
      '/lab/usage-proxy.mjs',
      String(port),
      '/usage',
      ...(target ? [target] : []),
    ]);
    // Several runs may start at once; the one that lost the race finds the proxy already there.
    if (r.status !== 0 && !/already in use/.test(r.stderr))
      throw new Error('proxy failed: ' + r.stderr.slice(-300));
  }
  // an error just means it is on the internal network already
  sh(['network', 'connect', 'benchint', name]);
}
proxy('benchproxy', 8099);
if (offline && system === 'mas') proxy('benchproxy-oai', 8098, 'https://api.deepseek.com');

// ---- the run ------------------------------------------------------------------------------------
const runId = `${label}-${system}-${taskName.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40)}-${Date.now() % 1e7}`;
const cname = `ar-${runId}`.slice(0, 60);
const mounts = ['-v', `${nodeDir}:/opt/node:ro`];
if (system === 'dsh') mounts.push('-v', `${dshDir}:/opt/dsh:ro`);
// The designed tasks' hidden tests and reference solutions live in the repository that mas runs from;
// an empty tmpfs hides them from the agent.
if (system === 'mas')
  mounts.push(
    '-v',
    `${maoDir}:/mao2:ro`,
    '--mount',
    'type=tmpfs,destination=/mao2/scripts/taskset/designed',
  );
const started = sh([
  'run',
  '-d',
  '--name',
  cname,
  '--network',
  offline ? 'benchint' : 'benchnet',
  `--cpus=${cpus}`,
  `--memory=${mem}m`,
  ...mounts,
  image,
  'sleep',
  'infinity',
]);
if (started.status !== 0) throw new Error('start failed: ' + started.stderr.slice(-300));
const runDir = join(outDir, runId);
mkdirSync(runDir, { recursive: true });
const result = {
  system,
  task: taskName,
  label,
  runId,
  image,
  cap,
  musl,
  offline,
  at: new Date().toISOString(),
};
try {
  sh(['exec', cname, 'mkdir', '-p', '/logs/verifier', '/logs/agent', '/instr', '/out']);
  // mas makes a session read-only when git is missing (undo works on git), so both systems get the
  // same prepared container: git installed where the image lacks it (Debian and Ubuntu images).
  const git = sh([
    'exec',
    cname,
    'bash',
    '-c',
    'command -v git >/dev/null || { apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null 2>&1; }; command -v git >/dev/null && echo yes || echo no',
  ]);
  result.git = (git.stdout ?? '').trim();
  writeFileSync(join(runDir, 'instruction.md'), instruction);
  sh(['cp', join(runDir, 'instruction.md'), `${cname}:/instr/instruction.md`]);
  const agentStart = Date.now();
  let agent;
  if (system === 'dsh') {
    agent = sh(
      [
        'exec',
        '-w',
        workdir,
        '-e',
        'DEEPSEEK_API_KEY',
        '-e',
        'DSH_HOME=/tmp/dshhome',
        '-e',
        `DEEPSEEK_BASE_URL=http://benchproxy:8099/r/${runId}`,
        cname,
        '/opt/node/bin/node',
        '/opt/dsh/node_modules/.bin/dsh',
        '--profile',
        'headless',
        // the container is the sandbox, and mas runs unisolated in it: give dsh the same freedom
        '--permission-mode',
        'danger-full-access',
        instruction,
      ],
      { env: childEnv, timeout: cap * 1000 },
    );
  } else {
    // MAS_UI=1: the console of mas is drawn in this terminal (docker exec -it), as `mas run` draws
    // it, while bench.ts answers its questions; nothing of it is captured.
    const ui = process.env.MAS_UI === '1';
    agent = (ui ? (args, opts) => spawnSync('docker', args, { ...opts, stdio: 'inherit' }) : sh)(
      [
        'exec',
        ...(ui ? ['-it', '-e', 'TERM', '-e', 'COLORTERM'] : []),
        '-w',
        '/mao2',
        '-e',
        'DEEPSEEK_API_KEY',
        // MAS_* variables are experiment overrides read by bench.ts (and written into its record).
        ...Object.keys(process.env)
          .filter((n) => n.startsWith('MAS_'))
          .flatMap((n) => ['-e', n]),
        // The comparison switches the product reads (Orchestration D35, D81, D83), when set.
        ...['MAO_INHERIT_CONTEXT', 'MAO_SUBTASK_ACCEPTANCE', 'MAO_FEW_SHOT']
          .filter((n) => process.env[n] !== undefined)
          .flatMap((n) => ['-e', n]),
        ...(offline ? ['-e', `MAS_API_BASE=http://benchproxy-oai:8098/r/${runId}`] : []),
        cname,
        '/opt/node/bin/node',
        '/mao2/node_modules/tsx/dist/cli.mjs',
        '/mao2/apps/control-plane/test/eval/bench.ts',
        '--repo',
        workdir,
        '--instruction-file',
        '/instr/instruction.md',
        '--out',
        '/out/mas-record.jsonl',
        '--task',
        taskName,
        '--timeout-sec',
        String(cap),
        '--log-dir',
        '/out',
      ],
      { env: childEnv, timeout: (cap + 120) * 1000 },
    );
    sh(['cp', `${cname}:/out/.`, runDir]);
  }
  result.agentSeconds = Math.round((Date.now() - agentStart) / 100) / 10;
  result.agentExit = agent.status;
  result.agentTimedOut = agent.error?.code === 'ETIMEDOUT' || agent.signal === 'SIGTERM';
  writeFileSync(join(runDir, 'agent.stdout.txt'), (agent.stdout ?? '').slice(-20000));
  writeFileSync(join(runDir, 'agent.stderr.txt'), (agent.stderr ?? '').slice(-20000));
  // What the agent delivered, as it left it, before the hidden tests go in: the files (without
  // .git) and what git sees changed, so a run can be read afterwards for what was changed.
  const delivered = sh(['exec', cname, 'sh', '-c', `cd ${workdir} && tar czf - --exclude=.git .`], {
    encoding: 'buffer',
    maxBuffer: 1 << 30,
  });
  if (delivered.status === 0) writeFileSync(join(runDir, 'delivered.tgz'), delivered.stdout);
  const status = sh([
    'exec',
    cname,
    'sh',
    '-c',
    `cd ${workdir} && git status --short --untracked-files=all 2>/dev/null; git diff --stat HEAD 2>/dev/null`,
  ]);
  writeFileSync(join(runDir, 'delivered-status.txt'), status.stdout ?? '');
  // the hidden tests go in only now
  sh(['cp', join(taskDir, 'tests'), `${cname}:/tests`]);
  const verifyStart = Date.now();
  const t = sh(['exec', cname, 'bash', '/tests/test.sh'], { timeout: verifierTimeout * 1000 });
  result.verifierSeconds = Math.round((Date.now() - verifyStart) / 1000);
  writeFileSync(join(runDir, 'verifier.txt'), ((t.stdout ?? '') + (t.stderr ?? '')).slice(-20000));
  const r = sh(['exec', cname, 'cat', '/logs/verifier/reward.txt']);
  result.reward = r.status === 0 ? Number(r.stdout.trim()) : null;
} catch (error) {
  result.error = String(error?.message ?? error).slice(0, 300);
} finally {
  sh(['rm', '-f', cname]);
}

// ---- the figures --------------------------------------------------------------------------------
if (system === 'dsh') {
  const file = join(USAGE_DIR, `${runId}.jsonl`);
  const sum = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, failed: 0 };
  if (existsSync(file))
    for (const line of readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)) {
      const j = JSON.parse(line);
      if (!j.path?.includes('/messages')) continue;
      sum.requests += 1;
      if (j.error || (j.status ?? 200) >= 400) sum.failed += 1;
      sum.input += j.usage?.input_tokens ?? 0;
      sum.output += j.usage?.output_tokens ?? 0;
      sum.cacheRead += j.usage?.cache_read_input_tokens ?? 0;
      sum.cacheWrite += j.usage?.cache_creation_input_tokens ?? 0;
    }
  result.usage = sum;
  if (existsSync(file)) writeFileSync(join(runDir, 'usage.jsonl'), readFileSync(file));
} else {
  const f = join(runDir, 'mas-record.jsonl');
  if (existsSync(f)) {
    const rec = JSON.parse(readFileSync(f, 'utf8').trim().split('\n').at(-1));
    result.usage = {
      requests: rec.metrics?.modelRequests,
      input: rec.metrics?.tokens?.input,
      output: rec.metrics?.tokens?.output,
      cacheRead: rec.metrics?.tokens?.cacheHit,
      failed: rec.metrics?.failedModelRequests,
    };
    result.costUsd = rec.metrics?.costUsd;
    result.outcome = rec.outcome;
    result.version = rec.version;
    result.maxParallelUnits = rec.metrics?.maxParallelUnits;
    result.toolRequests = rec.metrics?.toolRequests;
  }
}
mkdirSync(outDir, { recursive: true });
appendFileSync(join(outDir, 'results.jsonl'), JSON.stringify(result) + '\n');
// --record <file>: the result line goes there as well (the console took this terminal's output).
const record = opt('--record', undefined);
if (record !== undefined) appendFileSync(record, JSON.stringify(result) + '\n');
console.log(JSON.stringify(result));
