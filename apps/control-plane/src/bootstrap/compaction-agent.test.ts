/**
 * The Agent a compaction is made as is the Agent an AgentRun of it was registered as, as far as the
 * request goes: the summary request begins as that AgentRun's requests do (same instructions, same
 * tools, same model), which is what lets it hit the prompt cache of the requests before it. The
 * compaction finds its Agent in the catalog; the registration got it by the same catalog and the
 * same rules (M2Design 9.6).
 */
import {
  DEFAULT_DEFINITIONS_DIRECTORY,
  DefinitionCatalog,
  FileDefinitionSource,
} from '@multiagentos/agent-tool-pool';
import { createProtocolRegistry, newId } from '@multiagentos/contracts';
import { compactionAgentFrom, pinAgentFrom } from '@multiagentos/kernel';
import { agentBindingOf } from '@multiagentos/workflow';
import { describe, expect, it } from 'vitest';

const registry = createProtocolRegistry();
const context = { correlationId: newId('cor'), tenantId: 'local', projectId: 'local' };

describe('the Agent a compaction is made as', () => {
  for (const preset of ['standard', 'readonly'] as const)
    for (const commands of [true, false])
      it(`is the Agent as registered, for every Agent of the catalog (${preset}, commands ${String(commands)})`, async () => {
        const catalog = await DefinitionCatalog.load(
          new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
        );
        const compaction = compactionAgentFrom(catalog, registry, { preset, commands });
        const pin = pinAgentFrom(catalog, registry);
        const agents = catalog.list().filter((each) => each.kind === 'AGENT');
        expect(agents.map((each) => each.id)).toContain('main');
        for (const each of agents) {
          const pinned = catalog.pinAgent({ id: each.id, version: each.version }, context);
          if (!pinned.ok) throw new Error(`cannot pin ${each.id}`);
          const binding = agentBindingOf(pinned.value, registry, preset, { commands });
          const registered = await pin({
            requestId: newId('req'),
            sessionId: newId('ses'),
            workflowRunId: newId('wfr'),
            agentRunId: newId('agr'),
            nodeId: `nod_${'a'.repeat(32)}`,
            agentRef: binding.ref,
            effort: binding.effort,
            workspaceViewId: 'main',
            display: { label: each.id },
            requestedCapabilities: [...binding.requestedCapabilities],
            writeRoots: [...binding.writeRoots],
          } as unknown as Parameters<typeof pin>[0]);
          if (!registered.ok) throw new Error(`cannot register ${each.id}`);
          const derived = compaction({ id: each.id, version: each.version });
          expect(derived, each.id).toBeDefined();
          if (derived === undefined) continue;
          // What the request is made of, word for word.
          expect(derived.instructions, each.id).toBe(registered.agent.instructions);
          expect(derived.toolSpecs(false), each.id).toEqual(registered.agent.toolSpecs(false));
          expect(derived.toolSpecs(true), each.id).toEqual(registered.agent.toolSpecs(true));
          expect(derived.modelScope, each.id).toEqual(registered.agent.modelScope);
          expect(derived.budget, each.id).toEqual(registered.agent.budget);
          expect(derived.contextWindowTokens, each.id).toBe(registered.agent.contextWindowTokens);
          expect(derived.cacheHitWeight, each.id).toBe(registered.agent.cacheHitWeight);
        }
      });

  it("shows a task its caller's prompt and tools, byte for byte, and keeps the rest its own (D99)", async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    const pin = pinAgentFrom(catalog, registry);
    const bindingOf = (id: string) => {
      const pinned = catalog.pinAgent({ id, version: 'v0.1.0' }, context);
      if (!pinned.ok) throw new Error(`cannot pin ${id}`);
      return agentBindingOf(pinned.value, registry, 'standard', { commands: true });
    };
    const main = bindingOf('main');
    const worker = bindingOf('worker');
    const listed = [{ id: 'finish-subagent', version: 'v0.1.0' }];
    const request = (binding: typeof main, presentation?: object, inputLimit?: number) =>
      ({
        requestId: newId('req'),
        sessionId: newId('ses'),
        workflowRunId: newId('wfr'),
        agentRunId: newId('agr'),
        nodeId: `nod_${'a'.repeat(32)}`,
        agentRef: binding.ref,
        effort: 'high',
        workspaceViewId: 'main',
        display: { label: binding.ref.id },
        requestedCapabilities: [...binding.requestedCapabilities],
        writeRoots: [...binding.writeRoots],
        ...(presentation === undefined ? {} : { presentation }),
        ...(inputLimit === undefined ? {} : { inputLimit }),
      }) as unknown as Parameters<typeof pin>[0];
    const shownAsRoot = {
      agentRef: main.ref,
      offeredCapabilities: [...main.requestedCapabilities],
      listedTools: listed,
    };
    // Mission's root: its own tools, finish_subagent listed after them, and a smaller limit.
    const root = await pin(request(main, shownAsRoot, 555_000));
    const task = await pin(request(worker, shownAsRoot));
    const alone = await pin(request(worker));
    if (!root.ok || !task.ok || !alone.ok) throw new Error('cannot register');
    expect(root.agent.toolSpecs(false).at(-1)?.name).toBe('finish_subagent');
    expect(root.agent.instructions).toContain('finish_subagent is listed for the subtasks');
    expect(root.agent.ownToolNames).not.toContain('finish_subagent');
    expect(root.agent.budget.perCallInputLimit).toBe(555_000);
    // The task sends what the root sends.
    expect(task.agent.instructions).toBe(root.agent.instructions);
    expect(task.agent.toolSpecs(false)).toEqual(root.agent.toolSpecs(false));
    // Everything else is the worker's own.
    expect(task.agent.id).toBe('worker');
    expect(task.agent.capabilities).toEqual(alone.agent.capabilities);
    expect(task.agent.budget).toEqual(alone.agent.budget);
    // A final call lists the same tools; the end tools it may call then are its own (D102).
    expect(task.agent.toolSpecs(true)).toEqual(root.agent.toolSpecs(false));
    expect(task.agent.finalToolNames).toEqual(alone.agent.finalToolNames);
    expect(task.agent.ownToolNames).toEqual(alone.agent.ownToolNames);
    expect(task.agent.ownToolNames).not.toContain('run_subagents');
  });

  it('is main when no Agent is named, and nothing when the catalog does not know the Agent', async () => {
    const catalog = await DefinitionCatalog.load(
      new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
    );
    const compaction = compactionAgentFrom(catalog, registry, {
      preset: 'standard',
      commands: true,
    });
    expect(compaction()?.id).toBe('main');
    expect(compaction({ id: 'no-such-agent', version: 'v9.9.9' })).toBeUndefined();
  });
});
