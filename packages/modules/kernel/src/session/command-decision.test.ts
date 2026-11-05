import { describe, expect, it } from 'vitest';
import { RunAuthorization } from './run-authorization.js';
import {
  decideUnit,
  type AuthorizationEntry,
  type Capability,
  type CapabilityCeiling,
  type CommandAnalysis,
  type CommandDemand,
  type UnitDemand,
} from './unit-decision.js';

const mainCeiling: CapabilityCeiling = {
  capabilities: new Set<Capability>([
    'repo.read',
    'workspace.write',
    'command.exec',
    'command.network',
  ]),
  writeRoots: ['.'],
  exclusions: [],
};
const noNetwork: CapabilityCeiling = {
  ...mainCeiling,
  capabilities: new Set<Capability>(['repo.read', 'command.exec']),
};

const sub = (text: string, prefix?: string) => ({
  text,
  words: text.split(' '),
  ...(prefix === undefined ? {} : { prefix }),
});
const analysis = (text: string, over: Partial<CommandAnalysis> = {}): CommandAnalysis => ({
  text,
  subcommands: text.split(' && ').map((part) => sub(part, part.split(' ').slice(0, 2).join(' '))),
  unreusable: [],
  ...over,
});
const command = (text: string, over: Partial<CommandDemand> = {}): CommandDemand => ({
  analysis: analysis(text),
  workdir: '',
  network: false,
  sandbox: 'AVAILABLE',
  unavailablePolicy: 'deny',
  ...over,
});
const demand = (cmd: CommandDemand, requestId = 'req-1'): UnitDemand => ({
  requestId,
  agentRunId: 'run-1',
  capability: 'command.exec',
  command: cmd,
});

describe('deciding a command', () => {
  it('asks when nothing covers it, and allows once the user said so', () => {
    const ask = decideUnit(demand(command('npm test')), mainCeiling, []);
    expect(ask).toMatchObject({ kind: 'ASK', capability: 'command.exec', critical: false });
    const entries: AuthorizationEntry[] = [
      { scope: 'ONCE', effect: 'ALLOW', capability: 'command.exec', requestId: 'req-1' },
    ];
    expect(decideUnit(demand(command('npm test')), mainCeiling, entries).kind).toBe('ALLOW');
    expect(decideUnit(demand(command('npm test'), 'req-2'), mainCeiling, entries).kind).toBe('ASK');
  });

  it('refuses a denied command before anything else, without asking', () => {
    const denied = command('rm -rf x', { analysis: analysis('rm -rf x', { denied: 'rm -rf' }) });
    const nothing: CapabilityCeiling = { ...mainCeiling, capabilities: new Set<Capability>() };
    expect(decideUnit(demand(denied), nothing, [])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'COMMAND_DENIED',
    });
  });

  it('refuses outside the ceiling, and network without command.network', () => {
    const readonly: CapabilityCeiling = {
      ...mainCeiling,
      capabilities: new Set<Capability>(['repo.read']),
    };
    expect(decideUnit(demand(command('ls')), readonly, [])).toMatchObject({
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
    expect(decideUnit(demand(command('curl x', { network: true })), noNetwork, [])).toMatchObject({
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
  });

  it('refuses without a sandbox unless the user is asked about the missing isolation', () => {
    const none = command('ls', { sandbox: 'UNAVAILABLE' });
    expect(decideUnit(demand(none), mainCeiling, [])).toMatchObject({
      reasonCode: 'SANDBOX_UNAVAILABLE',
    });
    const ask = decideUnit(
      demand({ ...none, unavailablePolicy: 'ask-unisolated' }),
      mainCeiling,
      [],
    );
    expect(ask).toMatchObject({ kind: 'ASK', critical: true });
  });

  it('refuses a work directory outside the repository', () => {
    expect(decideUnit(demand(command('ls', { workdir: '../x' })), mainCeiling, [])).toMatchObject({
      reasonCode: 'ADMISSION_CHECK_FAILED',
    });
    expect(decideUnit(demand(command('ls', { workdir: '/etc' })), mainCeiling, [])).toMatchObject({
      reasonCode: 'ADMISSION_CHECK_FAILED',
    });
  });

  it('asks every time for a critical command, the network and a line that cannot be reused', () => {
    const grantAll: AuthorizationEntry[] = [
      {
        scope: 'RUN',
        effect: 'ALLOW',
        capability: 'command.exec',
        command: { kind: 'PREFIX', workdir: '.', value: 'git' },
      },
      {
        scope: 'RUN',
        effect: 'ALLOW',
        capability: 'command.exec',
        command: { kind: 'COMMAND', workdir: '.', value: 'git push' },
      },
    ];
    const critical = command('git push', {
      analysis: analysis('git push', { critical: 'git push' }),
    });
    expect(decideUnit(demand(critical), mainCeiling, grantAll)).toMatchObject({
      kind: 'ASK',
      critical: true,
    });
    expect(
      decideUnit(demand(command('git push', { network: true })), mainCeiling, grantAll),
    ).toMatchObject({ kind: 'ASK', critical: true });
    const tricky = command('git push', {
      analysis: analysis('git push', { unreusable: ['COMMAND_SUBSTITUTION'] }),
    });
    expect(decideUnit(demand(tricky), mainCeiling, grantAll)).toMatchObject({
      kind: 'ASK',
      critical: true,
    });
  });
});

describe('what an entry covers', () => {
  const entry = (kind: 'COMMAND' | 'PREFIX', value: string, workdir = '.'): AuthorizationEntry => ({
    scope: 'RUN',
    effect: 'ALLOW',
    capability: 'command.exec',
    command: { kind, workdir, value },
  });

  it('allows this command and no other', () => {
    const entries = [entry('COMMAND', 'npm test')];
    expect(decideUnit(demand(command('npm test')), mainCeiling, entries).kind).toBe('ALLOW');
    expect(decideUnit(demand(command('npm install')), mainCeiling, entries).kind).toBe('ASK');
  });

  it('allows what starts with the prefix, in whole words', () => {
    const entries = [entry('PREFIX', 'npm run')];
    expect(decideUnit(demand(command('npm run build')), mainCeiling, entries).kind).toBe('ALLOW');
    expect(decideUnit(demand(command('npm runx')), mainCeiling, entries).kind).toBe('ASK');
    expect(decideUnit(demand(command('npm publish')), mainCeiling, entries).kind).toBe('ASK');
  });

  it('needs every simple command of the line to be covered', () => {
    const entries = [entry('PREFIX', 'npm run')];
    expect(
      decideUnit(demand(command('npm run build && rm -rf dist')), mainCeiling, entries).kind,
    ).toBe('ASK');
    const both = [...entries, entry('COMMAND', 'rm -rf dist')];
    expect(
      decideUnit(demand(command('npm run build && rm -rf dist')), mainCeiling, both).kind,
    ).toBe('ALLOW');
  });

  it('does not reach into another work directory', () => {
    const entries = [entry('COMMAND', 'npm test', '.')];
    expect(
      decideUnit(demand(command('npm test', { workdir: 'pkg' })), mainCeiling, entries).kind,
    ).toBe('ASK');
  });

  it('binds a refusal to the AgentRun that was refused', () => {
    const refused: AuthorizationEntry = {
      scope: 'RUN',
      effect: 'DENY',
      capability: 'command.exec',
      agentRunId: 'run-1',
    };
    expect(decideUnit(demand(command('ls')), mainCeiling, [refused])).toEqual({
      kind: 'REFUSE',
      reasonCode: 'USER_DECLINED',
    });
    expect(
      decideUnit({ ...demand(command('ls')), agentRunId: 'run-2' }, mainCeiling, [refused]).kind,
    ).toBe('ASK');
  });
});

describe('the command question', () => {
  const authorization = () =>
    new RunAuthorization({
      repositoryRoot: '/repo',
      provider: 'deepseek',
      repositoryExclusions: [],
      now: () => new Date(0),
    });
  const shown = (text: string, over: Partial<CommandAnalysis> = {}) => ({
    analysis: analysis(text, over),
    workdir: '',
    writableRoots: ['.'],
    network: false,
    unisolated: false,
    approvalDigest: 'a'.repeat(64),
  });

  it('offers all four answers for a line that can be reused, with its prefixes', () => {
    const auth = authorization();
    const { requested } = auth.askCommand(shown('npm run build && git status'), false, 'r1', 'a1');
    expect(requested).toMatchObject({
      capability: 'command.exec',
      critical: false,
      options: ['ONCE', 'COMMAND', 'PREFIX', 'DENY'],
      prefixes: ['npm run', 'git status'],
      unreusable: [],
    });
  });

  it('offers only ONCE and DENY when something makes the line unreliable', () => {
    const { requested } = authorization().askCommand(
      shown('echo $(date)', { unreusable: ['COMMAND_SUBSTITUTION'] }),
      false,
      'r1',
      'a1',
    );
    expect(requested).toMatchObject({
      options: ['ONCE', 'DENY'],
      unreusable: ['COMMAND_SUBSTITUTION'],
    });
  });

  it('shows why a critical command and a network command are asked every time', () => {
    const { requested } = authorization().askCommand(
      { ...shown('git push', { critical: 'git push' }), network: true },
      true,
      'r1',
      'a1',
    );
    expect(requested).toMatchObject({
      critical: true,
      matched: 'git push',
      network: true,
      options: ['ONCE', 'DENY'],
      unreusable: ['CRITICAL_COMMAND', 'NETWORK'],
    });
  });

  it('merges the same line and work directory into one question', () => {
    const auth = authorization();
    const first = auth.askCommand(shown('npm test'), false, 'r1', 'a1');
    const second = auth.askCommand(shown('npm test'), false, 'r2', 'a2');
    expect(second.requested).toBeUndefined();
    expect(second.decision).toEqual(first.decision);
  });

  it('never merges a line that is asked every time', () => {
    const auth = authorization();
    auth.askCommand(shown('git push', { critical: 'git push' }), true, 'r1', 'a1');
    expect(
      auth.askCommand(shown('git push', { critical: 'git push' }), true, 'r2', 'a1').requested,
    ).toBeDefined();
  });

  it('turns COMMAND into one entry per simple command, and PREFIX into their prefixes', () => {
    const auth = authorization();
    const ceiling = mainCeiling;
    const ask = auth.askCommand(shown('npm run build && git status'), false, 'r1', 'run-1');
    if (ask.decision.kind !== 'PENDING') throw new Error('expected a question');
    expect(auth.offers(ask.decision.questionId, 'PREFIX')).toBe(true);
    auth.answer(ask.decision.questionId, 'PREFIX');
    const covered = (text: string) =>
      auth.decide(demand(command(text, { analysis: analysis(text) })), ceiling).kind;
    expect(covered('npm run build && git status')).toBe('ALLOW');
    expect(covered('npm run lint')).toBe('ALLOW');
    expect(covered('npm publish')).toBe('ASK');
  });

  it('does not accept an answer the question did not offer', () => {
    const auth = authorization();
    const ask = auth.askCommand(
      shown('echo $(date)', { unreusable: ['COMMAND_SUBSTITUTION'] }),
      false,
      'r1',
      'a1',
    );
    if (ask.decision.kind !== 'PENDING') throw new Error('expected a question');
    expect(auth.offers(ask.decision.questionId, 'COMMAND')).toBe(false);
    expect(auth.offers(ask.decision.questionId, 'PREFIX')).toBe(false);
    expect(auth.offers(ask.decision.questionId, 'ONCE')).toBe(true);
  });

  it('lets ONCE cover only the first who waited on a merged question', () => {
    const auth = authorization();
    const first = auth.askCommand(shown('npm test'), false, 'r1', 'a1');
    auth.askCommand(shown('npm test'), false, 'r2', 'a2');
    if (first.decision.kind !== 'PENDING') throw new Error('expected a question');
    const settled = auth.answer(first.decision.questionId, 'ONCE');
    expect(settled?.waiters).toEqual(['r1', 'r2']);
    const run = (requestId: string) =>
      auth.decide({ ...demand(command('npm test')), requestId }, mainCeiling).kind;
    expect(run('r1')).toBe('ALLOW');
    expect(run('r2')).toBe('ASK');
  });

  it('binds a refusal to everyone who waited', () => {
    const auth = authorization();
    const first = auth.askCommand(shown('npm test'), false, 'r1', 'a1');
    auth.askCommand(shown('npm test'), false, 'r2', 'a2');
    if (first.decision.kind !== 'PENDING') throw new Error('expected a question');
    auth.answer(first.decision.questionId, 'DENY');
    for (const agentRunId of ['a1', 'a2'])
      expect(auth.decide({ ...demand(command('npm test')), agentRunId }, mainCeiling)).toEqual({
        kind: 'REFUSE',
        reasonCode: 'USER_DECLINED',
      });
  });

  it('refuses the command that was refused and asks again for any other', () => {
    const auth = authorization();
    const ask = auth.askCommand(shown('make clean'), false, 'r1', 'run-1');
    if (ask.decision.kind !== 'PENDING') throw new Error('expected a question');
    auth.answer(ask.decision.questionId, 'DENY');
    const run = (line: string, workdir = '') =>
      auth.decide({ ...demand(command(line, { workdir })), requestId: `r-${line}` }, mainCeiling)
        .kind;
    expect(run('make clean')).toBe('REFUSE');
    expect(run('ls')).toBe('ASK');
    expect(run('npm test')).toBe('ASK');
    expect(run('make clean', 'pkg')).toBe('ASK');
  });
});

describe('a line of the read-only list', () => {
  const reading = (text: string, over: Partial<CommandDemand> = {}) =>
    command(text, { analysis: analysis(text, { readOnly: true }), ...over });
  const denyRepoRead: AuthorizationEntry = {
    scope: 'RUN',
    effect: 'DENY',
    capability: 'repo.read',
    agentRunId: 'run-1',
  };

  it('asks for repo.read first, as read_file does, and not for the command', () => {
    expect(decideUnit(demand(reading('ls -la')), mainCeiling, [])).toEqual({
      kind: 'ASK',
      capability: 'repo.read',
      resourceKey: '.',
      critical: false,
    });
  });

  it('needs no repo.read for a line that opens no file of the repository', () => {
    const echo = command('echo hi', {
      analysis: analysis('echo hi', { readOnly: true, readsRepository: false }),
    });
    expect(decideUnit(demand(echo), mainCeiling, [])).toMatchObject({
      kind: 'ALLOW',
      readOnly: true,
    });
  });

  it('runs without a question once repo.read is allowed, and says it is read-only', () => {
    expect(
      decideUnit(demand(reading('ls -la', { repoReadGranted: true })), mainCeiling, []),
    ).toEqual({ kind: 'ALLOW', capability: 'command.exec', resourceKey: '.', readOnly: true });
  });

  it('is not allowed without the capability to run commands at all', () => {
    const ceiling: CapabilityCeiling = {
      ...mainCeiling,
      capabilities: new Set<Capability>(['repo.read']),
    };
    expect(decideUnit(demand(reading('ls', { repoReadGranted: true })), ceiling, [])).toMatchObject(
      { kind: 'REFUSE', reasonCode: 'CAPABILITY_NOT_GRANTED' },
    );
  });

  it('stays a question like any command where the sandbox is missing, or the network is wanted', () => {
    const open = { repoReadGranted: true };
    expect(
      decideUnit(
        demand(
          reading('ls', { ...open, sandbox: 'UNAVAILABLE', unavailablePolicy: 'ask-unisolated' }),
        ),
        mainCeiling,
        [],
      ),
    ).toMatchObject({ kind: 'ASK', capability: 'command.exec', critical: true });
    expect(
      decideUnit(demand(reading('ls', { ...open, network: true })), mainCeiling, []),
    ).toMatchObject({ kind: 'ASK', capability: 'command.exec', critical: true });
  });

  it('is not read-only when a list says the line is critical or forbidden', () => {
    const open = { repoReadGranted: true };
    const critical = command('git status', {
      ...open,
      analysis: analysis('git status', { readOnly: true, critical: 'git' }),
    });
    expect(decideUnit(demand(critical), mainCeiling, [])).toMatchObject({
      kind: 'ASK',
      capability: 'command.exec',
      critical: true,
    });
    const denied = command('ls', {
      ...open,
      analysis: analysis('ls', { readOnly: true, denied: 'ls' }),
    });
    expect(decideUnit(demand(denied), mainCeiling, [])).toMatchObject({
      reasonCode: 'COMMAND_DENIED',
    });
  });

  it('is asked as an ordinary command by an AgentRun that refused repo.read', () => {
    expect(
      decideUnit(demand(reading('ls', { repoReadGranted: true })), mainCeiling, [denyRepoRead]),
    ).toMatchObject({ kind: 'ASK', capability: 'command.exec' });
  });

  it('is refused when the user refused exactly this command', () => {
    const refused: AuthorizationEntry = {
      scope: 'RUN',
      effect: 'DENY',
      capability: 'command.exec',
      agentRunId: 'run-1',
      commandKey: ' ls',
    };
    expect(
      decideUnit(demand(reading('ls', { repoReadGranted: true })), mainCeiling, [refused]),
    ).toMatchObject({ kind: 'REFUSE', reasonCode: 'USER_DECLINED' });
  });

  it('is not read-only when the analysis does not say so', () => {
    expect(
      decideUnit(demand(command('ls', { repoReadGranted: true })), mainCeiling, []),
    ).toMatchObject({
      kind: 'ASK',
      capability: 'command.exec',
    });
  });
});
