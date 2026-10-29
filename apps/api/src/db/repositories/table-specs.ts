/**
 * Table projections for every persisted entity, re-exported from the area modules so repositories
 * import from one place. The split only keeps each file focused:
 *  - specs-core: tenancy, users, governance settings, prompt versions and the case aggregate
 *  - specs-analysis: analysis artefacts and counterfactual scenarios
 *  - specs-skills: skill DNA, versions, validations, approvals and matches
 *  - specs-ops: model executions, token usage, audit events, review decisions and jobs
 */
export * from './specs-core';
export * from './specs-analysis';
export * from './specs-skills';
export * from './specs-ops';
