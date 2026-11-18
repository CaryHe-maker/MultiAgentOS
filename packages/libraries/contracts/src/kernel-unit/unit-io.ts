import { Type, type Static } from 'typebox';
import {
  ContextAssembleInputSchema,
  ContextAssembleOutputSchema,
} from '../context/history-entry.js';
import {
  RepositorySearchInputSchema,
  RepositorySearchOutputSchema,
} from '../context/repository.js';
import { FileReadInputSchema, FileReadOutputSchema } from '../executor/file-read.js';
import {
  CommandInputSchema,
  CommandOutputSchema,
  GitInspectInputSchema,
  GitInspectOutputSchema,
} from '../executor/command.js';
import {
  FileEditInputSchema,
  FileWriteInputSchema,
  FileWriteOutputSchema,
} from '../executor/file-write.js';
import { ModelCallInputSchema, ModelCallOutputSchema } from '../executor/model-call.js';
import { OutputReadInputSchema, OutputReadOutputSchema } from '../executor/output-read.js';
import {
  RepositoryListInputSchema,
  RepositoryListOutputSchema,
} from '../executor/repository-list.js';
import {
  WebFetchInputSchema,
  WebFetchOutputSchema,
  WebSearchInputSchema,
  WebSearchOutputSchema,
} from '../executor/web.js';
import { MessagePublishInputSchema, MessagePublishOutputSchema } from './message-publish.js';

export const UnitInputSchema = Type.Union(
  [
    RepositorySearchInputSchema,
    FileReadInputSchema,
    ContextAssembleInputSchema,
    ModelCallInputSchema,
    RepositoryListInputSchema,
    MessagePublishInputSchema,
    FileWriteInputSchema,
    FileEditInputSchema,
    OutputReadInputSchema,
    CommandInputSchema,
    GitInspectInputSchema,
    WebSearchInputSchema,
    WebFetchInputSchema,
  ],
  { $id: 'kernel.unit.UnitInput.v1' },
);
export type UnitInput = Static<typeof UnitInputSchema>;

export const UnitOutputSchema = Type.Union(
  [
    RepositorySearchOutputSchema,
    FileReadOutputSchema,
    RepositoryListOutputSchema,
    MessagePublishOutputSchema,
    ContextAssembleOutputSchema,
    ModelCallOutputSchema,
    FileWriteOutputSchema,
    OutputReadOutputSchema,
    CommandOutputSchema,
    GitInspectOutputSchema,
    WebSearchOutputSchema,
    WebFetchOutputSchema,
  ],
  { $id: 'kernel.unit.UnitOutput.v1' },
);
export type UnitOutput = Static<typeof UnitOutputSchema>;
