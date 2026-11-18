export function requireSender(sender: unknown, allowed: unknown): void {
  if (allowed === undefined || allowed === null || sender !== allowed) throw new Error('Not allowed');
}
