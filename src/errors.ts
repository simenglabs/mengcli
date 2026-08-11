/** Exit codes, PRD Sec 12.2. */
export const EXIT = {
  OK: 0,
  GENERAL: 1,
  BAD_CONFIG: 2,
  BUDGET: 3,
  CIRCUIT_BREAKER: 4,
  PREREQ: 5,
  NOT_FOUND: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class MengError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode = EXIT.GENERAL,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "MengError";
  }
}

export const badConfig = (m: string, hint?: string) => new MengError(m, EXIT.BAD_CONFIG, hint);
export const notFound = (m: string, hint?: string) => new MengError(m, EXIT.NOT_FOUND, hint);
export const prereq = (m: string, hint?: string) => new MengError(m, EXIT.PREREQ, hint);
export const budgetExceeded = (m: string) => new MengError(m, EXIT.BUDGET);
export const circuitBreaker = (m: string) => new MengError(m, EXIT.CIRCUIT_BREAKER);
