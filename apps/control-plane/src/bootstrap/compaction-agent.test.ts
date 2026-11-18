/**
 * The Agent of the Turn-chat as the catalog has it, for a compaction with no AgentRun of it, is
 * that Agent as a start registers it, as far as the request goes: the summary request begins as its requests do
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
      it(`is the Agent of the Turn-chat as registered (${preset}, commands ${String(commands)})`, async () => {
        const catalog = await DefinitionCatalog.load(
          new FileDefinitionSource(DEFAULT_DEFINITIONS_DIRECTORY),
        );
        const compaction = compactionAgentFrom(catalog, registry, {
          preset,
          commands,
          agentId: 'chat',
        });
        const pin = pinAgentFrom(catalog, registry);
        const chat = catalog.list().find((each) => each.kind === 'AGENT' && each.id === 'chat');
        if (chat === undefined) throw new Error('no chat');
        const pinned = catalog.pinAgent({ id: chat.id, version: chat.version }, context);
        if (!pinned.ok) throw new Error('cannot pin chat');
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
          display: { label: 'chat' },
          requestedCapabilities: [...binding.requestedCapabilities],
          writeRoots: [...binding.writeRoots],
        } as unknown as Parameters<typeof pin>[0]);
        if (!registered.ok) throw new Error('cannot register chat');
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
        expect(derived.id).toBe('chat');
      });
});
