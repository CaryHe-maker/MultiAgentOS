import { createHash } from 'node:crypto';
import {
  MEDIA_TYPES,
  canonicalJson,
  newId,
  type AppendLogPort,
  type ArtifactOwnerLine,
  type ArtifactRef,
  type ArtifactStorePort,
} from '@multiagentos/contracts';
import { describe, expect, it } from 'vitest';
import { publishMessage, publishReport } from './built-in-units.js';
import { SessionArtifacts } from './session-artifacts.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function setup() {
  const bodies = new Map<string, Uint8Array>();
  const lines: ArtifactOwnerLine[] = [];
  let now = Date.parse('2026-11-02T00:00:00.000Z');
  const store: ArtifactStorePort = {
    put: (content, mediaType) => {
      const sha256 = createHash('sha256').update(content).digest('hex');
      bodies.set(sha256, content);
      return Promise.resolve({
        artifactId: `art_${sha256}`,
        sha256,
        size: content.byteLength,
        mediaType,
      });
    },
    get: (ref) => {
      const body = bodies.get(ref.sha256);
      return body === undefined ? Promise.reject(new Error('gone')) : Promise.resolve(body);
    },
    sweep: () => Promise.resolve({ removed: 0 }),
    capabilities: () => [],
  };
  const owners: AppendLogPort<ArtifactOwnerLine> = {
    append: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    async *readAll() {
      await Promise.resolve();
      yield* lines;
    },
    repairTail: () => Promise.resolve({ truncatedBytes: 0 }),
  };
  const open = () =>
    new SessionArtifacts({
      store,
      owners,
      expiringRetentionDays: 7,
      now: () => new Date(now),
    });
  return {
    artifacts: open(),
    open,
    lines,
    bodies,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ownership', () => {
  it('refuses a reference of another Session without saying whether it exists', async () => {
    const mine = setup();
    const other = setup();
    const ref = await other.artifacts.put('secret', 'text/plain', 'SESSION');
    expect(await mine.artifacts.read(ref)).toEqual({
      ok: false,
      reasonCode: 'INVALID_ARTIFACT_REF',
    });
  });

  it('refuses a reference whose digest does not match the registration', async () => {
    const { artifacts } = setup();
    const ref = await artifacts.put('a', 'text/plain', 'SESSION');
    const forged: ArtifactRef = { ...ref, size: ref.size + 1 };
    expect(await artifacts.read(forged)).toMatchObject({ reasonCode: 'INVALID_ARTIFACT_REF' });
  });

  it('keeps references valid after the Session is opened again', async () => {
    const { artifacts, open } = setup();
    const ref = await artifacts.put('a', 'text/plain', 'SESSION');
    const reopened = open();
    await reopened.load();
    expect(await reopened.read(ref)).toEqual({ ok: true, text: 'a' });
  });

  it('expires by the registration, whether or not the body is still there', async () => {
    const { artifacts, advance } = setup();
    const ref = await artifacts.put('full', 'text/plain', 'EXPIRING', { fullOutput: true });
    advance(7 * DAY_MS - 1);
    expect(await artifacts.read(ref)).toEqual({ ok: true, text: 'full' });
    advance(1);
    expect(await artifacts.read(ref)).toEqual({ ok: false, reasonCode: 'ARTIFACT_EXPIRED' });
  });

  it('treats a missing body as expired', async () => {
    const { artifacts, bodies } = setup();
    const ref = await artifacts.put('a', 'text/plain', 'SESSION');
    bodies.clear();
    expect(await artifacts.read(ref)).toEqual({ ok: false, reasonCode: 'ARTIFACT_EXPIRED' });
  });

  it('never gives up SESSION when the same body is written again', async () => {
    const { artifacts, lines, advance } = setup();
    const ref = await artifacts.put('a', 'text/plain', 'SESSION');
    await artifacts.put('a', 'text/plain', 'EXPIRING');
    advance(30 * DAY_MS);
    expect(lines).toHaveLength(1);
    expect(artifacts.owns(ref)).toBe(true);
  });

  it('keeps what a handover carries for the whole Session, as the full output it was', async () => {
    const { artifacts, lines, advance } = setup();
    const full = await artifacts.put('full', 'text/plain', 'EXPIRING', { fullOutput: true });
    expect(await artifacts.retain([full])).toBe(true);
    advance(30 * DAY_MS);
    expect(await artifacts.read(full)).toEqual({ ok: true, text: 'full' });
    expect(artifacts.isFullOutput(full)).toBe(true);
    // Kept once: asking again changes nothing.
    const written = lines.length;
    expect(await artifacts.retain([full])).toBe(true);
    expect(lines).toHaveLength(written);
  });

  it('keeps nothing when one of them is not of this Session or has expired', async () => {
    const mine = setup();
    const other = setup();
    const ours = await mine.artifacts.put('a', 'text/plain', 'EXPIRING');
    const theirs = await other.artifacts.put('b', 'text/plain', 'SESSION');
    expect(await mine.artifacts.retain([ours, theirs])).toBe(false);
    mine.advance(8 * DAY_MS);
    expect(await mine.artifacts.retain([ours])).toBe(false);
    expect(mine.artifacts.owns(ours)).toBe(false);
  });

  it('releases what was registered ONCE: it reads as expired at once, and only that', async () => {
    const { artifacts, lines, open } = setup();
    const once = await artifacts.put('pack', 'text/plain', 'ONCE');
    const session = await artifacts.put('keep', 'text/plain', 'SESSION');
    const expiring = await artifacts.put('full', 'text/plain', 'EXPIRING', { fullOutput: true });
    expect(await artifacts.release([once, session, expiring])).toBe(once.size);
    expect(await artifacts.read(once)).toEqual({ ok: false, reasonCode: 'ARTIFACT_EXPIRED' });
    expect(await artifacts.read(session)).toEqual({ ok: true, text: 'keep' });
    expect(await artifacts.read(expiring)).toEqual({ ok: true, text: 'full' });
    // Once: releasing again writes nothing and counts nothing.
    const written = lines.length;
    expect(await artifacts.release([once])).toBe(0);
    expect(lines).toHaveLength(written);
    // A Session opened again still finds it released.
    const reopened = open();
    await reopened.load();
    expect(await reopened.read(once)).toEqual({ ok: false, reasonCode: 'ARTIFACT_EXPIRED' });
  });

  it('keeps a ONCE artifact for the Session when a handover carries it, and never releases it', async () => {
    const { artifacts } = setup();
    const once = await artifacts.put('pack', 'text/plain', 'ONCE');
    expect(await artifacts.retain([once])).toBe(true);
    expect(await artifacts.release([once])).toBe(0);
    expect(await artifacts.read(once)).toEqual({ ok: true, text: 'pack' });
  });

  it('expires a ONCE artifact that was never released, like an EXPIRING one', async () => {
    const { artifacts, advance } = setup();
    const once = await artifacts.put('pack', 'text/plain', 'ONCE');
    advance(7 * DAY_MS);
    expect(await artifacts.read(once)).toEqual({ ok: false, reasonCode: 'ARTIFACT_EXPIRED' });
  });

  it('stores a user input once per inputId', async () => {
    const { artifacts, lines } = setup();
    const input = { inputId: newId('inp'), text: 'hello' };
    expect(await artifacts.storeUserInput(input)).toEqual(await artifacts.storeUserInput(input));
    expect(lines).toHaveLength(1);
  });
});

describe('message-publish', () => {
  const toolCallId = 'call_reply';
  const modelOutput = (argumentsText: string) =>
    canonicalJson({
      provider: 'deepseek',
      apiModelId: 'deepseek-v4',
      providerFinishReason: 'tool_calls',
      toolCalls: [{ toolCallId, toolName: 'reply', argumentsText }],
      receivedAt: '2026-11-02T00:00:00.000Z',
    });
  const reply = (modelOutputRef: ArtifactRef, id = toolCallId) =>
    ({
      kind: 'REPLY',
      agentLabel: 'main',
      source: { modelOutputRef, toolCallId: id },
    }) as const;

  it('publishes the text of the reply call, and no more', async () => {
    const { artifacts } = setup();
    const ref = await artifacts.put(
      modelOutput('{"text":"# Done"}'),
      MEDIA_TYPES.modelOutput,
      'SESSION',
    );
    const result = await publishMessage(reply(ref), artifacts);
    expect(result).toMatchObject({ outcome: 'COMPLETED', output: { kind: 'REPLY' } });
    if (result.outputRef === undefined) throw new Error('no reference');
    expect(result.outputRef.mediaType).toBe(MEDIA_TYPES.markdown);
    expect(await artifacts.read(result.outputRef)).toEqual({ ok: true, text: '# Done' });
  });

  it('refuses a model output of another Session', async () => {
    const mine = setup();
    const other = setup();
    const ref = await other.artifacts.put(
      modelOutput('{"text":"x"}'),
      MEDIA_TYPES.modelOutput,
      'SESSION',
    );
    expect(await publishMessage(reply(ref), mine.artifacts)).toEqual({
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'INVALID_ARTIFACT_REF',
    });
  });

  it.each([
    ['an unknown tool call', '{"text":"x"}', 'call_other'],
    ['arguments that are not JSON', 'not json', toolCallId],
    ['arguments without text', '{}', toolCallId],
  ])('refuses %s', async (_name, argumentsText, id) => {
    const { artifacts } = setup();
    const ref = await artifacts.put(modelOutput(argumentsText), MEDIA_TYPES.modelOutput, 'SESSION');
    expect(await publishMessage(reply(ref, id), artifacts)).toEqual({
      outcome: 'NOT_DISPATCHED',
      reasonCode: 'INVALID_INPUT',
    });
  });

  it('publishes a degraded reply as its structured reason', async () => {
    const { artifacts } = setup();
    const result = await publishMessage(
      { kind: 'DEGRADED_REPLY', agentLabel: 'main', reason: 'BUDGET_EXHAUSTED' },
      artifacts,
    );
    if (result.outputRef === undefined) throw new Error('no reference');
    expect(await artifacts.read(result.outputRef)).toEqual({
      ok: true,
      text: '{"reason":"BUDGET_EXHAUSTED"}',
    });
  });
});

describe('report-publish', () => {
  it('refuses a goal it cannot resolve and a report that is not valid', async () => {
    const { artifacts } = setup();
    const other = setup();
    const foreign = await other.artifacts.put('goal', 'text/plain', 'SESSION');
    expect(await publishReport({ goalRef: foreign, report: {} }, artifacts, 1000)).toMatchObject({
      reasonCode: 'INVALID_ARTIFACT_REF',
    });
    const goalRef = await artifacts.put('goal', 'text/plain', 'SESSION');
    expect(await publishReport({ goalRef, report: {} }, artifacts, 1000)).toMatchObject({
      reasonCode: 'INVALID_INPUT',
    });
  });
});
