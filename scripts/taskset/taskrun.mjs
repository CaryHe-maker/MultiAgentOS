// A minimal runner for Harbor-format tasks (Terminal-Bench 2.0, SWE-bench Pro v2): image + instruction
// + tests/test.sh -> reward. `oracle` runs the reference solution, `empty` runs nothing; both are
// checked before a task may enter any tier (oracle must pass, empty must fail).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , mode, taskDir, outDir = '/tmp/taskrun-out'] = process.argv;
const toml = readFileSync(join(taskDir, 'task.toml'), 'utf8');
const get = (re, d) => toml.match(re)?.[1] ?? d;
const image = get(/docker_image = "([^"]+)"/, undefined);
const name = taskDir.split('/').filter(Boolean).pop();
const cpus = get(/cpus = (\d+)/, '1');
const mem = get(/memory_mb = (\d+)/, '2048');
const agentTimeout = Number(get(/\[agent\]\s*timeout_sec = ([\d.]+)/, '900'));
const verifierTimeout = Number(get(/\[verifier\]\s*timeout_sec = ([\d.]+)/, '900'));
const cname = `tr-${name.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 40)}-${Date.now() % 100000}`;
const docker = (args, opts = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
const result = { task: name, mode, image };
mkdirSync(outDir, { recursive: true });

let img = image;
if (!img) {
  // tasks without a prebuilt image are built from their Dockerfile
  img = `tr-build-${name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .slice(0, 50)}`;
  const b = docker(['build', '-t', img, join(taskDir, 'environment')]);
  if (b.status !== 0) {
    result.error = 'build failed: ' + (b.stderr || '').slice(-400);
    console.log(JSON.stringify(result));
    process.exit(0);
  }
}
const started = Date.now();
const run = docker([
  'run',
  '-d',
  '--name',
  cname,
  `--cpus=${cpus}`,
  `--memory=${mem}m`,
  img,
  'sleep',
  'infinity',
]);
if (run.status !== 0) {
  result.error = 'start failed: ' + run.stderr.slice(-400);
  console.log(JSON.stringify(result));
  process.exit(0);
}
try {
  docker(['exec', cname, 'mkdir', '-p', '/logs/verifier', '/logs/agent']);
  if (mode === 'oracle') {
    docker(['cp', join(taskDir, 'solution'), `${cname}:/solution`]);
    const s = docker(['exec', cname, 'bash', '/solution/solve.sh'], {
      timeout: agentTimeout * 1000,
    });
    result.solveExit = s.status;
    writeFileSync(join(outDir, `${name}.solve.log`), (s.stdout ?? '') + (s.stderr ?? ''));
  }
  docker(['cp', join(taskDir, 'tests'), `${cname}:/tests`]);
  const t = docker(['exec', cname, 'bash', '/tests/test.sh'], { timeout: verifierTimeout * 1000 });
  writeFileSync(join(outDir, `${name}.test.log`), (t.stdout ?? '') + (t.stderr ?? ''));
  const r = docker(['exec', cname, 'cat', '/logs/verifier/reward.txt']);
  result.reward = r.status === 0 ? Number(r.stdout.trim()) : null;
  result.testExit = t.status;
} finally {
  docker(['rm', '-f', cname]);
}
result.seconds = Math.round((Date.now() - started) / 1000);
console.log(JSON.stringify(result));
