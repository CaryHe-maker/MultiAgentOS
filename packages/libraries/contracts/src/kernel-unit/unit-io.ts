import { Type, type Static } from 'typebox';
import { ContextAssembleInputSchema, ContextAssembleOutputSchema } from '../context/assemble.js';
import {
  RepositoryOrientInputSchema,
  RepositoryOrientInputV1Schema,
  RepositoryOrientOutputSchema,
  RepositorySearchInputSchema,
  RepositorySearchOutputSchema,
} from '../context/repository.js';
import { FileReadInputSchema, FileReadOutputSchema } from '../executor/file-read.js';
import {
  ContextAssembleInputV1Schema,
  ContextAssembleOutputV1Schema,
} from '../context/history-entry.js';
import {
  ModelCallInputSchema,
  ModelCallInputV1Schema,
  ModelCallOutputSchema,
  ModelCallOutputV1Schema,
} from '../executor/model-call.js';
import {
  RepositoryListInputSchema,
  RepositoryListOutputSchema,
} from '../executor/repository-list.js';
import { MessagePublishInputSchema, MessagePublishOutputSchema } from './message-publish.js';
import {
  ReportPublishInputSchema,
  ReportPublishInputV1Schema,
  ReportPublishOutputSchema,
} from './report-publish.js';

/**
 * Union of the Unit inputs of M1Interface 6.1. Gateway validates `SubmitUnitRequest.input`
 * against it first; Core then validates against the Unit's own `inputContract`.
 */
export const UnitInputSchema = Type.Union(
  [
    RepositoryOrientInputSchema,
    RepositorySearchInputSchema,
    FileReadInputSchema,
    ContextAssembleInputSchema,
    ModelCallInputSchema,
    ReportPublishInputSchema,
  ],
  { $id: 'kernel.unit.UnitInput.v0' },
);
export type UnitInput = Static<typeof UnitInputSchema>;

export const UnitOutputSchema = Type.Union(
  [
    RepositoryOrientOutputSchema,
    RepositorySearchOutputSchema,
    FileReadOutputSchema,
    ContextAssembleOutputSchema,
    ModelCallOutputSchema,
    ReportPublishOutputSchema,
  ],
  { $id: 'kernel.unit.UnitOutput.v0' },
);
export type UnitOutput = Static<typeof UnitOutputSchema>;

/** Major 1 adds `list_files`, `message-publish` and main's context and model Units. */
export const UnitInputV1Schema = Type.Union(
  [
    RepositoryOrientInputV1Schema,
    RepositorySearchInputSchema,
    FileReadInputSchema,
    ContextAssembleInputV1Schema,
    ModelCallInputV1Schema,
    ReportPublishInputV1Schema,
    RepositoryListInputSchema,
    MessagePublishInputSchema,
  ],
  { $id: 'kernel.unit.UnitInput.v1' },
);
export type UnitInputV1 = Static<typeof UnitInputV1Schema>;

export const UnitOutputV1Schema = Type.Union(
  [
    ...UnitOutputSchema.anyOf,
    RepositoryListOutputSchema,
    MessagePublishOutputSchema,
    ContextAssembleOutputV1Schema,
    ModelCallOutputV1Schema,
  ],
  { $id: 'kernel.unit.UnitOutput.v1' },
);
export type UnitOutputV1 = Static<typeof UnitOutputV1Schema>;
