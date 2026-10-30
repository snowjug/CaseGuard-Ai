# @caseguard/ai

Model-provider abstraction, prompt registry, validators, orchestrator, token governor, semantic cache
and resilience for CaseGuard AI. Design rule: **the LLM proposes, code disposes** (ADR 0005). Case text
is untrusted data, never instructions. No model output is returned without schema, citation, temporal,
policy, groundedness and injection validation, and every outcome yields a persistable execution record.

Depends only on `@caseguard/schemas`, `@caseguard/domain` and Node built-ins. Logging, metrics, clock,
credentials, redaction and the injection scanner are small injected interfaces (`src/types.ts`) that the
API layer wires to `@caseguard/observability`, `@caseguard/security` and `@azure/identity`.

## Pipeline (`AiOrchestrator.runAgentTask`)

1. **Context** – minimised and redacted from a temporal view only (no future events, no resolution for
   pre-resolution agents), bounded by the per-request token budget (trim levels 0–4).
2. **Route** – the token governor picks deterministic code, the cheap model or the stronger model.
3. **Cache** – tenant-scoped, TTL-bound. The bucket key holds everything that is not the prose of the
   record (agent, prompt version, knowledge pack, boundary, focus such as strategy, allowed actions,
   scenario and claim subset); only event, evidence and claim text may differ in a near-match. Hits are
   re-validated against the current request before use.
4. **Budget and resilience** – per-request/day/case budgets (re-checked before a repair call, with the
   first call's usage already booked), circuit breaker (also opens after three consecutive
   configuration faults: 401, 403, 404, unusable settings), bulkhead.
5. **Provider call** – `DeterministicProvider` (default, offline, `simulated: true`) or
   `AzureOpenAiProvider` (strict JSON-schema output, managed identity, bounded retries).
6. **Validate** – size, schema, citations, temporal boundary, safety policy, groundedness, injection.
7. **Repair once** (schema, citation, grounding, size issues only), otherwise **fall back** to the
   deterministic result with a typed rejection. Temporal, policy and injection violations are never retried.

Prompts and raw model output are not stored unless the caller passes `retainContent: true`; records carry
hashes, counts and metadata only. Cost is `null` unless the operator supplied unit prices.

## Usage

```ts
import { AiOrchestrator, AzureOpenAiProvider } from '@caseguard/ai';

const orchestrator = new AiOrchestrator({
  config: modelConfig, // ModelConfig (governance)
  provider: new AzureOpenAiProvider({
    endpoint,
    deployment,
    apiVersion,
    auth: { kind: 'managed-identity', credential: new DefaultAzureCredential() },
  }), // omit to stay fully deterministic
  logger,
  metrics,
});

const { result, modelExecution, source, rejection, notices } = await orchestrator.runAgentTask({
  task: { agent: 'hypothesis_generator', input: taskBase },
  signal,
});
const health = orchestrator.getHealth();
```

`source` is `deterministic | model | cache | deterministic_fallback`; `modelExecution` matches the
`ModelExecutionWithUsage` contract. Use `counterfactualTask(...)` to build counterfactual tasks.
`getHealth()` is `unknown` until a remote call has been made, `degraded` while the last call failed (with
its code, HTTP status and a sanitised cause code, never a message, URL or header) or the breaker is held
back, and flags `misconfigured` after repeated configuration faults.

## Evaluation

`runEvaluation({ provider, cases })` scores any provider against golden cases (schema validity, citation
validity, groundedness, temporal leakage, unsafe recommendations, agreement with the deterministic
reference) plus a set of adversarial fixtures that every validator layer must reject, and a set of
legitimate negated wordings ("Do not delete the user profiles.") that the validators must accept.
`evalReportToJson` and `evalReportToMarkdown` render the report. Leakage and unsafe-recommendation gates
are always zero.

## Validation status (be honest in UI and docs)

- `AzureOpenAiProvider` is implemented and validated **only against a local `node:http` mock**. It has not
  been exercised against a real Azure OpenAI deployment.
- Deterministic quality, coaching and SkillDNA outputs are narrative proposals derived from the engine's
  artefacts (forks, claim flags, requirements, counterfactual scenarios); numeric scores come from the
  domain quality engine. Replace them per agent with `handlerOverrides` if a richer engine is preferred.
- The injection scanner is heuristic and can be evaded; inject a stronger scanner via `injectionScanner`.
- Budgets, cache and breaker state are in memory and per process.

## Tests

`pnpm exec vitest run` in this package. Integration tests (`*.int.test.ts`) use a local mock server and the
two synthetic cases in `synthetic-data/cases`. Prompt template hashes are pinned in `test/prompts.test.ts`:
changing a prompt requires a version bump and a new pin.
