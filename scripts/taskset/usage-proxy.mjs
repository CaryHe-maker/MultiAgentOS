// A recording reverse proxy for the model API: forwards every request unchanged and records the
// token usage of each answer (JSON or event stream), so that two harnesses are counted the same way.
// A run puts its id in front of the path (`/r/<id>/v1/messages`); the usage goes to `<dir>/<id>.jsonl`.
//   node usage-proxy.mjs [port] [dir] [target]
import http from 'node:http';
import https from 'node:https';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';

const [, , port = '8099', dir = '/usage', target = 'https://api.deepseek.com/anthropic'] = process.argv;
const upstream = new URL(target);
mkdirSync(dir, { recursive: true });
const dumped = new Set();

const record = (id, entry) =>
  appendFileSync(`${dir}/${id}.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

http
  .createServer((req, res) => {
    const started = Date.now();
    const match = /^\/r\/([A-Za-z0-9_.-]+)(\/.*)$/.exec(req.url ?? '');
    const id = match?.[1] ?? 'unlabelled';
    const path = match?.[2] ?? req.url;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: upstream.host };
      headers['accept-encoding'] = 'identity';
      headers['content-length'] = String(body.length);
      const up = https.request(
        { hostname: upstream.hostname, port: 443, path: upstream.pathname.replace(/\/$/, '') + path, method: req.method, headers },
        (ures) => {
          res.writeHead(ures.statusCode ?? 502, ures.headers);
          const out = [];
          ures.on('data', (c) => {
            out.push(c);
            res.write(c);
          });
          ures.on('end', () => {
            res.end();
            const text = Buffer.concat(out).toString('utf8');
            let usage;
            if (text.includes('data:')) {
              for (const line of text.split('\n')) {
                if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
                try {
                  const j = JSON.parse(line.slice(5));
                  for (const u of [j.usage, j.message && j.message.usage]) if (u) usage = { ...(usage || {}), ...u };
                } catch {}
              }
            } else {
              try {
                usage = JSON.parse(text).usage;
              } catch {}
            }
            let model;
            let params;
            try {
              const { model: m, messages, system, tools, dsh_session_log, ...rest } = JSON.parse(body.toString('utf8'));
              model = m;
              params = rest;
              // Where the characters of the prompt are (sizes only, never the content).
              const by = {};
              const add = (key, value) => (by[key] = (by[key] ?? 0) + (typeof value === 'string' ? value.length : JSON.stringify(value ?? '').length));
              for (const message of messages ?? []) {
                if (typeof message.content === 'string') add(message.role + ':text', message.content);
                else for (const block of message.content ?? []) add(message.role + ':' + block.type, block.thinking ?? block.text ?? block.content ?? block.input);
              }
              // The first main request of a run keeps its system prompt and tool definitions, so the
              // prompt of the harness under test can be read and compared.
              if (!dumped.has(id) && rest.thinking?.type === 'enabled') {
                dumped.add(id);
                writeFileSync(`${dir}/${id}.system.json`, JSON.stringify({ system, tools }, null, 1));
              }
              params.profile ={ messages: (messages ?? []).length, system: JSON.stringify(system ?? '').length, tools: JSON.stringify(tools ?? '').length, by };
            } catch {}
            record(id, { path, status: ures.statusCode, ms: Date.now() - started, model, params, usage });
          });
        },
      );
      up.on('error', (e) => {
        record(id, { path, error: String(e) });
        res.writeHead(502);
        res.end();
      });
      up.end(body);
    });
  })
  .listen(Number(port), '0.0.0.0', () => console.log('proxy on', port));
