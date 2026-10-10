import { Type, type Static } from 'typebox';
import { ContextAssembleInputSchema, ContextAssembleOutputSchema } from '../context/assemble.js';
import {
  RepositoryOrientInputSchema,
  RepositoryOrientOutputSchema,
  RepositorySearchInputSchema,
  RepositorySearchOutputSchema,
} from '../context/repository.js';
import { FileReadInputSchema, FileReadOutputSchema } from '../executor/file-read.js';
import { ModelCallInputSchema, ModelCallOutputSchema } from '../executor/model-call.js';
import { ReportPublishInputSchema, ReportPublishOutputSchema } from './report-publish.js';

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
