import { describe, expect, it } from 'vitest';
import { RunAuthorization } from './run-authorization.js';
import {
  ANY_HOST,
  decideUnit,
  type AuthorizationEntry,
  type Capability,
  type CapabilityCeiling,
  type CommandDemand,
  type UnitDemand,
} from './unit-decision.js';

/**
 * The web is asked about on its own (docs/M2/Kernel/Core.md 5f): the search once per run, or once
 * per folder when the user says so; the fetch once per site, or once for every public site in the
 * run. None of it reaches a command: a command that uses the network is a question of its own,
 * every time.
 */

const explorer: CapabilityCeiling = {
  capabilities: new Set<Capability>(['repo.read', 'web.search', 'web.fetch']),
  writeRoots: [],
  exclusions: [],
};
const main: CapabilityCeiling = {
  capabilities: new Set<Capability>([
    'repo.read',
    'workspace.write',
    'command.exec',
    'command.network',
    'web.search',
    'web.fetch',
  ]),
  writeRoots: ['.'],
  exclusions: [],
};

const authorization = (webSearchTrusted = false) =>
  new RunAuthorization({
    repositoryRoot: '/repo',
    provider: 'deepseek',
    repositoryExclusions: [],
    webSearchTrusted,
    now: () => new Date(0),
  });

const fetchOf = (url: string, agentRunId = 'run-1', requestId = `req-${url}`): UnitDemand => ({
  requestId,
  agentRunId,
  capability: 'web.fetch',
  web: { url, deniedDomains: [] },
});
const search: UnitDemand = { requestId: 'req-s', agentRunId: 'run-1', capability: 'web.search' };

function ask(auth: RunAuthorization, host: string, waiter: string): string {
  const check = auth.askWebFetch(`https://${host}/page`, host, waiter, 'run-1');
  if (check.decision.kind !== 'PENDING') throw new Error(check.decision.kind);
  return check.decision.questionId;
}

describe('the fetch of the web', () => {
  it('is asked once for each site, and a yes covers that site only', () => {
    const auth = authorization();
    const questionId = ask(auth, 'a.example', 'w1');
    expect(auth.offers(questionId, 'ALLOW')).toBe(true);
    auth.answer(questionId, 'ALLOW');
    expect(auth.decide(fetchOf('https://a.example/x'), explorer).kind).toBe('ALLOW');
    expect(auth.decide(fetchOf('https://b.example/x'), explorer).kind).toBe('ASK');
    expect(auth.decide(fetchOf('https://sub.a.example/x'), explorer).kind).toBe('ASK');
  });

  it('is covered for every public site by one answer, and the questions open meanwhile with it', () => {
    const auth = authorization();
    const first = ask(auth, 'a.example', 'w1');
    ask(auth, 'b.example', 'w2');
    ask(auth, 'c.example', 'w3');
    expect(auth.offers(first, 'ANY_HOST')).toBe(true);
    const settled = auth.answer(first, 'ANY_HOST');
    expect(settled).toMatchObject({ resolution: 'GRANTED', waiters: ['w1'] });
    // Every public site is allowed now, in this run.
    expect(auth.decide(fetchOf('https://d.example/x'), explorer).kind).toBe('ALLOW');
    const covered = auth.settleCovered();
    expect(covered.map((each) => each.waiters)).toEqual([['w2'], ['w3']]);
    expect(covered.every((each) => each.resolution === 'GRANTED')).toBe(true);
    // Nothing is left to settle.
    expect(auth.settleCovered()).toEqual([]);
  });

  it('settles nothing on the way when the answer was for one site', () => {
    const auth = authorization();
    const first = ask(auth, 'a.example', 'w1');
    ask(auth, 'b.example', 'w2');
    auth.answer(first, 'ALLOW');
    expect(auth.settleCovered()).toEqual([]);
  });

  it('lets every public site through once covered, and still not a private address', () => {
    const entries: AuthorizationEntry[] = [
      { scope: 'RUN', effect: 'ALLOW', capability: 'web.fetch', resourceKey: ANY_HOST },
    ];
    expect(decideUnit(fetchOf('https://anywhere.example/x'), explorer, entries).kind).toBe('ALLOW');
    for (const url of [
      'http://127.0.0.1/x',
      'http://localhost/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
    ])
      expect(decideUnit(fetchOf(url), explorer, entries)).toEqual({
        kind: 'REFUSE',
        reasonCode: 'ADDRESS_FORBIDDEN',
      });
  });

  it('keeps a site the user refused refused, whatever is allowed afterwards', () => {
    const entries: AuthorizationEntry[] = [
      {
        scope: 'RUN',
        effect: 'DENY',
        capability: 'web.fetch',
        agentRunId: 'run-1',
        hostKey: 'bad.example',
      },
      { scope: 'RUN', effect: 'ALLOW', capability: 'web.fetch', resourceKey: ANY_HOST },
    ];
    expect(decideUnit(fetchOf('https://bad.example/x'), explorer, entries)).toEqual({
      kind: 'REFUSE',
      reasonCode: 'USER_DECLINED',
    });
    expect(decideUnit(fetchOf('https://good.example/x'), explorer, entries).kind).toBe('ALLOW');
  });

  it('has the sites the user forbade beforehand refused too', () => {
    const entries: AuthorizationEntry[] = [
      { scope: 'RUN', effect: 'ALLOW', capability: 'web.fetch', resourceKey: ANY_HOST },
    ];
    const demand: UnitDemand = {
      ...fetchOf('https://tracker.example/x'),
      web: { url: 'https://tracker.example/x', deniedDomains: ['tracker.example'] },
    };
    expect(decideUnit(demand, explorer, entries)).toEqual({
      kind: 'REFUSE',
      reasonCode: 'DOMAIN_DENIED',
    });
  });

  it('is offered the answer for every site only on a question about the fetch', () => {
    const auth = authorization();
    const searching = auth.askWebSearch(['q'], 'deepseek', 'ws', 'run-1');
    if (searching.decision.kind !== 'PENDING') throw new Error('not pending');
    expect(auth.offers(searching.decision.questionId, 'ANY_HOST')).toBe(false);
    const writing = auth.askWrite({ critical: false, writeRoot: '.' }, 'ww', 'run-1');
    if (writing.decision.kind !== 'PENDING') throw new Error('not pending');
    expect(auth.offers(writing.decision.questionId, 'ANY_HOST')).toBe(false);
    expect(auth.offers(writing.decision.questionId, 'FOLDER')).toBe(false);
  });
});

describe('the search of the web', () => {
  it('is asked once for the run', () => {
    const auth = authorization();
    expect(decideUnit(search, explorer, []).kind).toBe('ASK');
    const asked = auth.askWebSearch(['q'], 'deepseek', 'w1', 'run-1');
    if (asked.decision.kind !== 'PENDING') throw new Error('not pending');
    expect(auth.offers(asked.decision.questionId, 'ALLOW')).toBe(true);
    expect(auth.offers(asked.decision.questionId, 'FOLDER')).toBe(true);
    expect(auth.offers(asked.decision.questionId, 'ANY_HOST')).toBe(false);
  });

  it('is not asked in a run that begins in a folder the user allowed it for', () => {
    expect(authorization(true).decide(search, explorer).kind).toBe('ALLOW');
    expect(authorization(false).decide(search, explorer).kind).toBe('ASK');
    // The folder says nothing of the fetch, nor of a write.
    expect(authorization(true).decide(fetchOf('https://a.example/x'), explorer).kind).toBe('ASK');
  });

  it('is answered for the folder with the same entry as for the run', () => {
    const auth = authorization();
    const asked = auth.askWebSearch(['q'], 'deepseek', 'w1', 'run-1');
    if (asked.decision.kind !== 'PENDING') throw new Error('not pending');
    expect(auth.answer(asked.decision.questionId, 'FOLDER')).toMatchObject({
      resolution: 'GRANTED',
      waiters: ['w1'],
    });
    expect(auth.decide(search, explorer).kind).toBe('ALLOW');
  });
});

describe('the network of a command, which is not the web', () => {
  const command = (network: boolean, text = 'curl https://example.com'): UnitDemand => {
    const demand: CommandDemand = {
      analysis: {
        text,
        subcommands: [
          { text, words: text.split(' '), prefix: text.split(' ').slice(0, 2).join(' ') },
        ],
        unreusable: [],
      },
      workdir: '',
      network,
      sandbox: 'AVAILABLE',
      unavailablePolicy: 'deny',
    };
    return { requestId: 'req-c', agentRunId: 'run-1', capability: 'command.exec', command: demand };
  };
  const everythingOfTheWeb: AuthorizationEntry[] = [
    { scope: 'RUN', effect: 'ALLOW', capability: 'web.fetch', resourceKey: ANY_HOST },
    { scope: 'RUN', effect: 'ALLOW', capability: 'web.search', resourceKey: '.' },
  ];

  it('is asked every time, as before, however much of the web was allowed', () => {
    const decided = decideUnit(command(true), main, everythingOfTheWeb);
    expect(decided).toMatchObject({ kind: 'ASK', capability: 'command.exec', critical: true });
  });

  it('is not allowed to an Agent that has no network for commands, whatever the web allows', () => {
    const noNetwork: CapabilityCeiling = {
      ...main,
      capabilities: new Set<Capability>(['repo.read', 'command.exec', 'web.fetch', 'web.search']),
    };
    expect(decideUnit(command(true), noNetwork, everythingOfTheWeb)).toEqual({
      kind: 'REFUSE',
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
  });

  it('is not made easier by a grant for the web, and a command without network is not either', () => {
    expect(decideUnit(command(false, 'npm test'), main, everythingOfTheWeb).kind).toBe('ASK');
  });

  it('does not give the web to an Agent without it: the entries only count within the ceiling', () => {
    const none: CapabilityCeiling = {
      capabilities: new Set<Capability>(['repo.read']),
      writeRoots: [],
      exclusions: [],
    };
    expect(decideUnit(fetchOf('https://a.example/x'), none, everythingOfTheWeb)).toEqual({
      kind: 'REFUSE',
      reasonCode: 'CAPABILITY_NOT_GRANTED',
    });
  });
});
