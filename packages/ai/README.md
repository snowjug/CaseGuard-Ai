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

## Model-assisted review (optional, evidence-grounded)

`src/reasoning/` adds an **optional** second opinion on top of the deterministic engine. A model reads the
redacted record (never the engine's conclusions), proposes findings, and deterministic code checks every
proposal against the record before a person sees it. The layer never changes a case, a score or a piece of
evidence, never decides anything, and is off unless a real model provider is configured. Nothing here has
been run against a real model: see "Not run" below.

```ts
const { findings, engineNotes, assistance, executions } = await runModelAssistedReview(
  { orchestrator, clock, logger, metrics, maxRunTokens },
  { ...taskBase, facts }, // the same input as any task; `facts` optional (derived from `analysis`, scoped to the view)
  signal,
);
```

1. **Reasoner** (`case_reasoner`) proposes signals, contradictions, missing evidence, missed steps,
   counterfactuals, recommendations and one synthesis. Each proposal quotes the record verbatim.
2. **Grounding rules** check each proposal on its own. A proposal that fails any rule is dropped and
   counted by code; the rest of the reply survives. A reply that is unusable as a whole (not JSON, too
   large, a key the schema does not have, a field only the server may set at the top level) gets one repair
   attempt, then no findings.
3. **Critic** (`case_critic`) gives a second look, only if something survived. It may critique only the
   numbered conclusions it was given (the engine's headline conclusions and the reasoner's survivors) and
   cannot approve, accept, reject or add a conclusion. Critiques of engine conclusions come back as
   `engineNotes`; the engine's items are never altered.
4. **Hybrid policy** (`combine`, pure) says how each survivor stands next to what the engine found on its own.

Limits, all enforced: at most two model tasks and four provider calls per run (one repair per task); a token
ceiling for the whole run (`maxRunTokens`, default what the two tasks' budgets allow once) checked before
every call, repairs included; the per-request, per-case and per-day budgets, timeout, retry limit, bulkhead and
circuit breaker of the orchestrator; a review started from inside a review (for example by a provider) is
refused (`reentrant_call`). An aborted signal returns no findings (a partial result is never presented as
complete). The cache is tenant-scoped. `mode` is `off` (deterministic provider, no deployment, no events),
`ran` (a model reply was used; `ran_without_second_look` when the critic could not be had) or `fallback`
(the reason says why: budget, timeout, circuit, provider error, content filter, rejected by validation, input
too large, cancelled).

### Grounding rules (`PROPOSAL_CODES`)

| Code                    | What it refuses                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                | Anything the strict schema of the proposal does not allow (type, missing or extra key, value).                                                                                                                                                                                           |
| `prohibited_field`      | A field only the server may set (`approved`, `accepted`, `status`, `hybridStatus`, `reviewState`, `validationStatus`, `modelOnly`, `deterministicCorroboration`), at any depth, in any spelling.                                                                                         |
| `unknown_event`         | An event the model was not shown.                                                                                                                                                                                                                                                        |
| `unknown_vocabulary_id` | A signal, requirement, action or skill that is not in the allow-list of the prompt.                                                                                                                                                                                                      |
| `excerpt_not_found`     | A quotation that is not verbatim in the cited event as the model saw it.                                                                                                                                                                                                                 |
| `excerpt_wrong_event`   | A real quotation cited for another event.                                                                                                                                                                                                                                                |
| `missing_evidence`      | A proposal (or key point) with no citation.                                                                                                                                                                                                                                              |
| `future_information`    | An event after the boundary, or after the decision a finding is about; an identifier or phrase that exists only later.                                                                                                                                                                   |
| `unsupported_certainty` | High confidence, or absolute wording, on an inference or general knowledge.                                                                                                                                                                                                              |
| `numeric_time_claim`    | Saved, reduced or shortened time stated as a number (only the engine may estimate that).                                                                                                                                                                                                 |
| `model_basis_overclaim` | A counterfactual claiming a `measured` or engine-estimated basis.                                                                                                                                                                                                                        |
| `instruction_like_text` | The existing injection scanner on what the model wrote or quoted; markup, links, addresses and tool calls not in the record; the delimiter or nonce echoed; the internal instructions repeated; signs of obeying the record.                                                             |
| `secret_like_text`      | A secret-like value in any text.                                                                                                                                                                                                                                                         |
| `duplicate`             | A repeat of an earlier proposal of the reply (same id, subject or statement).                                                                                                                                                                                                            |
| `excessive_output`      | A reply, list or text over its cap.                                                                                                                                                                                                                                                      |
| `critic_unknown_target` | A critique of a conclusion that was not under review.                                                                                                                                                                                                                                    |
| `critic_new_story`      | A critique with no target, no citation, or an alternative that is not a pack hypothesis.                                                                                                                                                                                                 |
| `policy_violation`      | The existing safety policy per proposal: advice to delete, reset everyone's credentials, weaken a security control, share a secret, close the case or skip approval; a destructive, approval-required or too risky action named; any wording that judges, ranks or disciplines a person. |

`policy_violation` is the one code the brief did not list: without it the safety rules that every other agent
gets would not apply to the new ones. A proposal that fails several rules counts under each code, so the codes
of `assistance.counts.rejectedByCode` need not add up to `proposed - kept`.

### Quotations

The model supplies text only: no offsets, hashes or flags. The server compares NFC-normalised, whitespace-
collapsed text on both sides (case-sensitive, nothing else), requires the quotation to be in what the model
was shown, locates it in the **stored** title or body, records `field`, `start` and `end`, and has
`verifyExcerpt` from `@caseguard/domain` confirm it. At most 280 characters of a quotation are recorded. Text
that redaction replaced is not in the stored text: if the quotation is in the redacted text the model saw, it
is recorded with `verifiedIn: 'redacted_view'` (no field, no offsets, the finding says `passed_with_notes`);
otherwise it is `excerpt_not_found`.

### Statuses (`hybridStatus`)

In this order, for a proposal that passed the rules: the engine's own evidence cuts against it (the signal
observed negated or as a guess, or its counterpart holds; the action recognised as done by the decision; the
requirement met before it) → `CONFLICTING`, both sides kept; a counterfactual or recommendation the engine
does not support, and anything the critic questions (`unsupported_claim`, `circular_reasoning`,
`premature_closure`, `counterfactual_overclaim`, `uncertainty_hidden_as_fact`, `contradiction`) →
`NEEDS_HUMAN_REVIEW` with the critique attached; the engine supports it independently (same type, subject and
an overlapping event) → `MODEL_CORROBORATED`; otherwise `MODEL_PROPOSED`, `modelOnly`. `DETERMINISTIC` is the
status of the engine's own item (a screen lists it next to a model finding) and `REJECTED` is what a reviewer's
rejection gives: the policy produces neither. Every finding leaves here `reviewState: 'pending'`; no export of
this package accepts, approves or stores anything (a test scans the exports and the sources, and runs the
whole pipeline against a model that approves itself). The critic can only escalate: it never lowers a finding
and never lifts a conflict. Order of inputs, repeated runs and the facts do not change the result (properties).

The engine's side is a plain `DeterministicFacts` (`deterministicFactsOf(analysis, extras, { view })`): signals
observed per event, actions recognised, forks, requirements unmet at each moment, ranked hypotheses,
recommendations, and an optional `conflicts` list (the policy works without it). With a `view` the facts are
those of the boundary: later events, and what only they show, are left out, so a critic never sees a hypothesis
or fork the engine reached after the moment under review.

### The scripted test provider

`createScriptedTestProvider({ script, allowScripted: true })` replays a script keyed by agent (a value, a list
played in order, or a function of the request and the call number) with failure injection: malformed JSON, a
truncated reply (finish reason `length`), JSON of the wrong shape, timeout, 429, 5xx (with `times` to test
retries), content filter, and a delay that honours abort and the deadline. Usage is exact when stated. It is
`kind: 'scripted'`, `simulated: true`, `model: 'scripted-test-model'`, and **every reply comes from the stated
script: nothing it returns says anything about the quality of a real model.** It cannot serve a deployed
runtime: the constructor refuses without `allowScripted`, and `AI_PROVIDER=scripted` is refused by
`@caseguard/config` unless `APP_ENV` is `local` or `test`. (`test/fakes.ts` has a different, older fake that
plays an `azure-openai` provider; the two are not related.)

### Measurement, and what is not run

- `pnpm --filter @caseguard/ai run eval:planted` prints, as Markdown and without writing anything, the catch
  rate of the grounding rules over the planted-error corpus (`test/reasoning/planted-errors.ts`: a grounded
  reply over Case One and 100+ mutations, one per error). Mechanical categories are caught 100%, and a test
  asserts it. The corpus also lists **semantic errors** (well-formed, grounded, wrong: a quotation cut before
  the words that change its meaning, a statement that contradicts its own quotation, a flipped negation); they
  pass every rule by design, and the report says that mechanical validation cannot catch them.
- `test/reasoning/injection-corpus.ts` holds 55+ prompt-injection payloads (titles, bodies, metadata, quoted
  e-mails and logs, the exact delimiters of the renderer, base64, zero-width characters, look-alike letters,
  other languages, instructions aimed at the critic). Tests show that the renderer fences and escapes every
  one of them, that the prompts say the record is data, and that a scripted model that **obeys** them leaves
  the case unchanged and produces no accepted status, no tool or action output, no finding with evidence
  outside the record, and no case text in logs or metrics. The input scanner is a heuristic: the corpus marks
  which payloads it is expected to flag and which it is not (other languages, encodings), because the
  structural defences, not the scanner, are what hold.
- **NOT RUN**: any real model (Azure OpenAI or other); the quality of any real model's proposals; how often a
  real model makes the planted errors; the critic against a real model (the scripted critic replays a script
  and measures nothing about a model); a deployed environment. Every number in the tests is a measurement of
  deterministic code.

`assistance` states what the review did, with every number measured or `null`: `mode`, `reasonCode`, `provider`,
`model`, `simulated`, `counts` (proposed, kept, `rejectedByCode`, `criticNotes`), `schemaFailures`,
`fallbackCount`, `safetyBlocks`, `modelCalls`, `requests` (transport retries included), `tokens` (measured or
estimated), `estimatedCostUsd` (`null` without configured unit prices), `latencyMs`, `cancelled`, `cacheHits`.
The execution rows carry the deployment, attempts and retries, token usage and cost, latency, repair attempts,
the validation outcome (what was dropped, by code) and the fallback reason.

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
changing a prompt requires a version bump and a new pin. The model-assisted review is tested in
`test/reasoning/` (one file per grounding rule under `rules/`, the policy with fast-check properties, the
scripted provider, cost, latency and cancellation, the two corpora); `pnpm run eval:planted` prints the
planted-error table.
