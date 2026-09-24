/** An error the user should see as a clean message, not a stack trace. */
export class OrchError extends Error {
  constructor(message, code = 'orch-error') {
    super(message);
    this.name = 'OrchError';
    this.code = code;
  }
}
