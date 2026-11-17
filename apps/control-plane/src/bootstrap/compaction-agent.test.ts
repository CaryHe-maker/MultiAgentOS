/**
 * Main as the catalog has it, for a compaction with no AgentRun of main, is main as a start
 * registers it, as far as the request goes: the summary request begins as main's requests do
 * (same instructions, same tools, same model), which is what lets it hit the prompt cache of the
 * requests before it (M2Design 9.6). A compaction with an AgentRun is made as that AgentRun.
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
      it(`is main as registered (${preset}, commands ${String(commands)})`, async () => {
        const catalog = await DefinitionCatalog.load(
          new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
        );
        const compaction = compactionAgentFrom(catalog, registry, { preset, commands });
        const pin = pinAgentFrom(catalog, registry);
        const main = catalog.list().find((each) => each.kind === 'AGENT' && each.id === 'main');
        if (main === undefined) throw new Error('no main');
        const pinned = catalog.pinAgent({ id: main.id, version: main.version }, context);
        if (!pinned.ok) throw new Error('cannot pin main');
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
          display: { label: 'main' },
          requestedCapabilities: [...binding.requestedCapabilities],
          writeRoots: [...binding.writeRoots],
        } as unknown as Parameters<typeof pin>[0]);
        if (!registered.ok) throw new Error('cannot register main');
        const derived = compaction();
        if (derived === undefined) throw new Error('no compaction agent');
        // What the request is made of, word for word.
        expect(derived.instructions).toBe(registered.agent.instructions);
        expect(derived.toolSpecs).toEqual(registered.agent.toolSpecs);
        expect(derived.finalToolNames).toEqual(registered.agent.finalToolNames);
        expect(derived.modelScope).toEqual(registered.agent.modelScope);
        expect(derived.budget).toEqual(registered.agent.budget);
        expect(derived.contextWindowTokens).toBe(registered.agent.contextWindowTokens);
        expect(derived.cacheHitWeight).toBe(registered.agent.cacheHitWeight);
        expect(derived.id).toBe('main');
      });
});
