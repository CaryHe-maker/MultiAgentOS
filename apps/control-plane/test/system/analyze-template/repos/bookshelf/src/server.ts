import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { EventBus } from './events/event-bus.js';
import { HoldQueue } from './holds/hold-queue.js';
import { route } from './http/routes.js';
import { LoanService } from './loans/loan-service.js';
import { Store } from './storage/memory-store.js';

const config = loadConfig();
const store = new Store();
const events = new EventBus();
const loans = new LoanService(store, events, config);
new HoldQueue(events, (memberId, message) => console.log(`mail ${memberId}: ${message}`), config);

createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const response = route(
      loans,
      { method: req.method ?? 'GET', path: req.url ?? '/', body: raw === '' ? {} : JSON.parse(raw) },
      new Date(),
    );
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
}).listen(Number(process.env.PORT ?? 8080));
