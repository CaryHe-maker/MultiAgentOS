import type { LoanService } from '../loans/loan-service.js';

export interface Request {
  method: string;
  path: string;
  body: Record<string, string>;
}

export interface Response {
  status: number;
  body: unknown;
}

/** Maps the JSON API onto the loan service; every timestamp comes from the server clock. */
export function route(loans: LoanService, request: Request, now: Date): Response {
  if (request.method === 'POST' && request.path === '/loans') {
    const result = loans.borrow(request.body['memberId'] ?? '', request.body['bookId'] ?? '', now);
    return result.allowed ? { status: 201, body: result.loan } : { status: 409, body: result };
  }
  const returned = /^\/loans\/([^/]+)\/return$/.exec(request.path);
  if (request.method === 'POST' && returned !== null) {
    const loan = loans.returnBook(decodeURIComponent(returned[1] ?? ''), now);
    return { status: 200, body: loan };
  }
  return { status: 404, body: { error: 'not found' } };
}
