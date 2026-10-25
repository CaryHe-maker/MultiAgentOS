import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { closed, count, text } from '../platform-common/schema-helpers.js';
import { createM1ProtocolRegistry, ProtocolRegistry } from '../protocol-registry.js';
import {
  compatibilityIssues,
  currentSchemas,
  readSchemaSnapshot,
  snapshotIssues,
  type SchemaSnapshot,
} from './schema-snapshot.js';

const ID = 'platform.config.Example.v0';
const registryWith = (schema: ReturnType<typeof closed>) => {
  const registry = new ProtocolRegistry();
  registry.register(schema);
  return registry;
};
const frozenFrom = (registry: ProtocolRegistry): SchemaSnapshot => ({
  frozen: true,
  schemas: currentSchemas(registry),
});
const base = { name: text(16), limit: count(1) };
const frozen = frozenFrom(registryWith(closed(base, ID)));

describe('protocol freeze guard (M1TechStack 11)', () => {
  it('keeps the registered Schemas equal to the snapshot', async () => {
    expect(snapshotIssues(await readSchemaSnapshot(), createM1ProtocolRegistry())).toEqual([]);
  });

  it('accepts an added optional property after the freeze', () => {
    const extended = closed({ ...base, note: Type.Optional(text(8)) }, ID);
    expect(snapshotIssues(frozen, registryWith(extended))).toEqual([]);
  });

  it.each([
    ['an added required property', closed({ ...base, note: text(8) }, ID), 'added as required'],
    ['a removed property', closed({ name: text(16) }, ID), 'removed'],
    [
      'a property made optional',
      closed({ ...base, limit: Type.Optional(count(1)) }, ID),
      'required changed',
    ],
    [
      'a narrowed bound',
      closed({ ...base, name: text(8) }, ID),
      '/properties/name/maxLength: changed',
    ],
    ['a changed type', closed({ ...base, limit: text(4) }, ID), '/properties/limit/type: changed'],
  ])('rejects %s after the freeze', (_label, changed, issue) => {
    const issues = snapshotIssues(frozen, registryWith(changed));
    expect(issues.join('\n')).toContain(issue);
  });

  it('rejects a frozen Schema that is no longer registered', () => {
    expect(snapshotIssues(frozen, new ProtocolRegistry())).toEqual([
      `${ID}: frozen but no longer registered`,
    ]);
  });

  it('allows a new Schema or a new major after the freeze', () => {
    const registry = registryWith(closed(base, ID));
    registry.register(closed(base, 'platform.config.Example.v1'));
    expect(snapshotIssues(frozen, registry)).toEqual([]);
  });

  it('requires every change to be written to the snapshot before the freeze', () => {
    const draft = { ...frozen, frozen: false };
    const extended = registryWith(closed({ ...base, note: Type.Optional(text(8)) }, ID));
    expect(snapshotIssues(draft, extended)).toEqual([
      `${ID}: differs from the snapshot; run pnpm run contracts:snapshot`,
    ]);
    const added = registryWith(closed(base, ID));
    added.register(closed(base, 'platform.config.Other.v0'));
    expect(snapshotIssues(draft, added)).toEqual(['platform.config.Other.v0: not in the snapshot']);
  });

  it('rejects a changed union variant, which is not an added optional field', () => {
    const before = { anyOf: [{ const: 'A' }, { const: 'B' }] };
    expect(compatibilityIssues(before, { anyOf: [{ const: 'A' }] })).toEqual([
      '/anyOf: length changed',
    ]);
  });
});
