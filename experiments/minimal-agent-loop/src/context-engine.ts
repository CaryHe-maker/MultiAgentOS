import type {
  ContextPack,
  ContextReader,
  ContextRequest,
  PromptTemplateReader,
  Result,
} from './contracts.js';
import { NotImplementedError } from './contracts.js';

export class MinimalContextEngine implements ContextReader {
  public constructor(private readonly prompts: PromptTemplateReader) {}

  public build(_request: ContextRequest): Promise<Result<ContextPack>> {
    void this.prompts;
    void _request;
    return Promise.reject(new NotImplementedError('MinimalContextEngine', 'build'));
  }
}
