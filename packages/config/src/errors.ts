/** One problem with the environment. It names the variable and never contains a value. */
export interface ConfigIssue {
  readonly variable: string;
  readonly message: string;
}

export function formatIssues(issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);
  const noun = issues.length === 1 ? 'problem' : 'problems';
  return `Invalid configuration (${issues.length} ${noun}):\n${lines.join('\n')}`;
}

/** Thrown at start-up when the environment is invalid or unsafe. The message lists every problem. */
export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(formatIssues(issues));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
