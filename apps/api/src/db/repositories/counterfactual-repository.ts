import {
  CounterfactualScenarioSchema,
  IsoTimestampSchema,
  ReviewStateSchema,
  type CounterfactualScenario,
} from '@caseguard/schemas';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationFailedError } from '../../errors';
import { canonicalJson } from '../hash';
import { COUNTERFACTUAL_SCENARIOS, COUNTERFACTUAL_STEPS } from './table-specs';
import {
  QueryBuilder,
  assertTenant,
  assertVersion,
  insertRows,
  loadVersioned,
  lockCase,
  nowIso,
  parseStored,
  unique,
  updateRow,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import type { CounterfactualRepository } from './types';

/** At most this many scenarios are returned for one case (3 strategies per fork, bounded forks). */
const MAX_SCENARIOS_PER_CASE = 1_500;

const ReviewSchema = z.object({
  reviewState: ReviewStateSchema,
  reason: z.string().trim().min(1).max(1000),
  reviewedBy: z.string().min(1).max(120),
  reviewedAt: IsoTimestampSchema,
  expectedVersion: z.number().int().min(1),
});

/** Everything a reviewer judged: the scenario without review decisions and record bookkeeping. */
function reviewedContent(scenario: CounterfactualScenario): string {
  return canonicalJson({
    ...scenario,
    reviewState: undefined,
    reviewReason: undefined,
    reviewedBy: undefined,
    reviewedAt: undefined,
    version: undefined,
    createdAt: undefined,
    createdBy: undefined,
    updatedAt: undefined,
  });
}

export class CounterfactualRepositoryImpl implements CounterfactualRepository {
  constructor(private readonly ctx: RepoContext) {}

  /**
   * Upserts scenarios and their steps. A scenario that already exists with identical content is left
   * untouched, so a reviewer's decision survives a re-run that reproduces the same simulation; changed
   * content replaces the row (and resets review to whatever the new scenario carries).
   */
  async saveScenarios(scenarios: CounterfactualScenario[]): Promise<void> {
    if (scenarios.length === 0) return;
    const items = validateInput(
      z.array(CounterfactualScenarioSchema),
      scenarios,
      'counterfactual scenarios',
    );
    const keys = new Set<string>();
    for (const scenario of items) {
      assertTenant(this.ctx, scenario.tenantId);
      const key = `${scenario.caseId}\u0000${scenario.id}`;
      if (keys.has(key)) {
        throw new ValidationFailedError('Invalid counterfactual scenarios', [
          { path: 'id', message: `Duplicate scenario ${scenario.id}` },
        ]);
      }
      keys.add(key);
      scenario.steps.forEach((step, index) => {
        if (step.scenarioId !== scenario.id) {
          throw new ValidationFailedError('Invalid counterfactual scenarios', [
            { path: `steps.${index}.scenarioId`, message: 'A step must belong to its scenario' },
          ]);
        }
      });
    }

    await this.ctx.run(async (tx) => {
      const { tenantId } = this.ctx.scope;
      for (const caseId of unique(items.map((scenario) => scenario.caseId))) {
        if (!(await lockCase(tx, tenantId, caseId))) throw new NotFoundError('Case', caseId);
      }
      const existingRows = await tx.query<
        DataRow & { case_id: string; id: string; version: number }
      >(
        `SELECT data, case_id, id, version FROM counterfactual_scenarios
          WHERE tenant_id = $1 AND id = ANY($2::text[])`,
        [tenantId, unique(items.map((scenario) => scenario.id))],
      );
      const existing = new Map<string, { scenario: CounterfactualScenario; version: number }>();
      for (const row of existingRows.rows) {
        existing.set(`${row.case_id}\u0000${row.id}`, {
          scenario: parseStored(CounterfactualScenarioSchema, row.data, 'counterfactual scenario'),
          version: row.version,
        });
      }

      const toWrite: CounterfactualScenario[] = [];
      for (const scenario of items) {
        const before = existing.get(`${scenario.caseId}\u0000${scenario.id}`);
        if (!before) {
          toWrite.push(scenario);
        } else if (reviewedContent(before.scenario) !== reviewedContent(scenario)) {
          toWrite.push({
            ...scenario,
            createdAt: before.scenario.createdAt,
            version: before.version + 1,
          });
        }
      }
      if (toWrite.length === 0) return;

      for (const scenario of toWrite) {
        await tx.query(
          'DELETE FROM counterfactual_steps WHERE tenant_id = $1 AND case_id = $2 AND scenario_id = $3',
          [tenantId, scenario.caseId, scenario.id],
        );
      }
      await insertRows(tx, COUNTERFACTUAL_SCENARIOS, toWrite, 'upsert');
      await insertRows(
        tx,
        COUNTERFACTUAL_STEPS,
        toWrite.flatMap((scenario) =>
          scenario.steps.map((step) => ({ tenantId, caseId: scenario.caseId, step })),
        ),
      );
    });
  }

  async list(
    caseId: string,
    filter: { forkId?: string | undefined } = {},
  ): Promise<CounterfactualScenario[]> {
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    q.where(`case_id = ${q.bind(caseId)}`);
    if (filter.forkId) q.where(`fork_id = ${q.bind(filter.forkId)}`);
    return this.ctx.run(async (tx) => {
      // Scenarios of one analysis share `created_at`: order them by the decision they start from and
      // their strategy (content), so the order is the same in every database. `id` only separates
      // scenarios that are identical in all three.
      const result = await tx.query<DataRow>(
        `SELECT data FROM counterfactual_scenarios WHERE ${q.clause}
          ORDER BY created_at, as_of, strategy, id LIMIT ${MAX_SCENARIOS_PER_CASE}`,
        q.params,
      );
      return result.rows.map((row) =>
        parseStored(CounterfactualScenarioSchema, row.data, 'counterfactual scenario'),
      );
    });
  }

  async get(caseId: string, scenarioId: string): Promise<CounterfactualScenario | null> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow>(
        `SELECT data FROM counterfactual_scenarios
          WHERE tenant_id = $1 AND case_id = $2 AND id = $3`,
        [this.ctx.scope.tenantId, caseId, scenarioId],
      );
      const row = result.rows[0];
      return row
        ? parseStored(CounterfactualScenarioSchema, row.data, 'counterfactual scenario')
        : null;
    });
  }

  async review(
    caseId: string,
    scenarioId: string,
    review: {
      reviewState: z.infer<typeof ReviewStateSchema>;
      reason: string;
      reviewedBy: string;
      reviewedAt: string;
      expectedVersion: number;
    },
  ): Promise<CounterfactualScenario> {
    const input = validateInput(ReviewSchema, review, 'counterfactual review');
    return this.ctx.run(async (tx) => {
      const { entity, version } = await loadVersioned(tx, {
        table: 'counterfactual_scenarios',
        key: { tenant_id: this.ctx.scope.tenantId, case_id: caseId, id: scenarioId },
        schema: CounterfactualScenarioSchema,
        what: 'Counterfactual scenario',
        id: scenarioId,
      });
      assertVersion('Counterfactual scenario', input.expectedVersion, version);
      const next = validateInput(
        CounterfactualScenarioSchema,
        {
          ...entity,
          reviewState: input.reviewState,
          reviewReason: input.reason,
          reviewedBy: input.reviewedBy,
          reviewedAt: input.reviewedAt,
          updatedAt: nowIso(this.ctx),
          version: version + 1,
        },
        'counterfactual scenario',
      );
      const changed = await updateRow(tx, COUNTERFACTUAL_SCENARIOS, next, {
        expectedVersion: version,
      });
      if (changed !== 1)
        throw new ConflictError('The scenario was modified concurrently; reload and retry');
      return next;
    });
  }
}
