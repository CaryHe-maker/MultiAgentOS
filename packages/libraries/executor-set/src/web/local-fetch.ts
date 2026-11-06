import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  allowedAddresses,
  checkUrlLiteral,
  type AddressPolicy,
  type Resolve,
} from './address-policy.js';
import { htmlToMarkdown } from './html-to-markdown.js';
import { WebFailure, type FetchProvider } from './providers.js';

/**
 * This program's own fetch (ExecutorSet 5d): the checks on the address, the redirects and the
 * size are all here, whichever provider comes first. A connection goes to an address that was
 * checked a moment ago, never to a name that is resolved again, so a name cannot answer with a
 * public address to the check and a private one to the connection. No cookie, no credential, no
 * `Referer`.
 */
export interface LocalFetchOptions {
  readonly resolve: Resolve;
  readonly policy: AddressPolicy;
  readonly maxContentBytes: number;
  readonly userAgent: string;
}

const MAX_REDIRECTS = 5;
const TEXT_TYPES =
  /^(text\/html|application\/xhtml\+xml|text\/plain|text\/markdown|application\/json)\b/iu;

interface Answer {
  readonly status: number;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
  readonly truncated: boolean;
}

function get(
  url: URL,
  address: string,
  options: LocalFetchOptions,
  signal: AbortSignal,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const request = (secure ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          host: url.host,
          'user-agent': options.userAgent,
          accept:
            'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
        // The certificate is checked against the name, though the connection goes to the address.
        ...(secure ? { servername: url.hostname } : {}),
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        response.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = options.maxContentBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, Math.max(room, 0)));
            size = options.maxContentBytes;
            truncated = true;
            response.destroy();
          } else {
            chunks.push(chunk);
            size += chunk.length;
          }
        });
        const done = () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
            truncated,
          });
        };
        response.on('end', done);
        response.on('close', done);
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

const unavailable = (retryable = false, status?: number): WebFailure =>
  new WebFailure({ kind: 'FAILED', code: 'PAGE_UNAVAILABLE', retryable }, status);

function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/iu.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

export function createLocalFetch(options: LocalFetchOptions): FetchProvider {
  return {
    name: 'local',
    fetch: async ({ url: start }, signal) => {
      let current = new URL(start);
      const host = current.host.toLowerCase();
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const literal = checkUrlLiteral(current.href);
        if (!literal.ok) throw new WebFailure({ kind: 'REJECTED', code: 'ADDRESS_FORBIDDEN' });
        const addresses = await allowedAddresses(current.hostname, options.resolve, options.policy);
        const [address] = addresses ?? [];
        if (address === undefined)
          throw new WebFailure({ kind: 'REJECTED', code: 'ADDRESS_FORBIDDEN' });
        let answer: Answer;
        try {
          answer = await get(current, address, options, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          throw unavailable(true);
        }
        const location = answer.headers.location;
        if ([301, 302, 303, 307, 308].includes(answer.status) && location !== undefined) {
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            throw unavailable();
          }
          // Another host (or a step down from https) is not followed: asking for it is the model's
          // call, and the user is asked for the new host then.
          if (
            next.host.toLowerCase() !== host ||
            (current.protocol === 'https:' && next.protocol !== 'https:')
          )
            return { title: '', markdown: '', via: 'local', redirectTo: next.href };
          current = next;
          continue;
        }
        if (answer.status < 200 || answer.status >= 300)
          throw unavailable(answer.status === 429 || answer.status >= 500, answer.status);
        const type = String(answer.headers['content-type'] ?? '');
        if (!TEXT_TYPES.test(type))
          throw new WebFailure({ kind: 'REJECTED', code: 'UNSUPPORTED_CONTENT' });
        const body = decodeBody(answer.body, type);
        const page = /html/iu.test(type)
          ? htmlToMarkdown(body, current)
          : { title: '', markdown: body };
        return {
          title: page.title,
          markdown: page.markdown,
          via: 'local',
          finalUrl: current.href,
          truncated: answer.truncated,
        };
      }
      throw unavailable();
    },
  };
}
