import { Type, type Static } from 'typebox';
import {
  ContextAssembleInputSchema,
  ContextAssembleOutputSchema,
} from '../context/history-entry.js';
import {
  RepositoryOrientInputSchema,
  RepositoryOrientOutputSchema,
  RepositorySearchInputSchema,
  RepositorySearchOutputSchema,
} from '../context/repository.js';
import { FileReadInputSchema, FileReadOutputSchema } from '../executor/file-read.js';
import { ModelCallInputSchema, ModelCallOutputSchema } from '../executor/model-call.js';
import {
  RepositoryListInputSchema,
  RepositoryListOutputSchema,
} from '../executor/repository-list.js';
import { MessagePublishInputSchema, MessagePublishOutputSchema } from './message-publish.js';
import { ReportPublishInputSchema, ReportPublishOutputSchema } from './report-publish.js';

export const UnitInputSchema = Type.Union(
  [
    RepositoryOrientInputSchema,
    RepositorySearchInputSchema,
    FileReadInputSchema,
    ContextAssembleInputSchema,
    ModelCallInputSchema,
    ReportPublishInputSchema,
    RepositoryListInputSchema,
    MessagePublishInputSchema,
  ],
  { $id: 'kernel.unit.UnitInput.v1' },
);
export type UnitInput = Static<typeof UnitInputSchema>;

export const UnitOutputSchema = Type.Union(
  [
    RepositoryOrientOutputSchema,
    RepositorySearchOutputSchema,
    FileReadOutputSchema,
    ReportPublishOutputSchema,
    RepositoryListOutputSchema,
    MessagePublishOutputSchema,
    ContextAssembleOutputSchema,
    ModelCallOutputSchema,
  ],
  { $id: 'kernel.unit.UnitOutput.v1' },
);
export type UnitOutput = Static<typeof UnitOutputSchema>;
