// Deprecated since 1.2: holds are announced by HoldQueue, which listens for BookReturned.
// Nothing imports this file any more; it is kept until the 2.0 cleanup.

/** Formerly emailed every member who had ever borrowed the book. */
export function notifyBorrowers(bookId: string, borrowers: string[]): string[] {
  return borrowers.map((memberId) => `notify ${memberId}: ${bookId} is available`);
}
