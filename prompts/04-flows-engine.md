# Prompt 4 / 8 — Chatbot flows (scenarios)

Context: `MASTER_PROMPT.md`, prompts 1–3.

## `src/scenario.ts`

### Pure engine

- Types: `StepType`, `StepConfig {next_step_id, options[{label, value?, next_step_id?}], variable, validation, error_message, fallback}`,
  `FlowStep`, `FlowState {scenarioId, waitingStepId, vars, done}`, `FlowResult {messages[{content, buttons}], state, action: wait|ai|handoff, passthrough}`.
- `runFlow(steps, startStepId, state, scenarioId, input?)`.

**When `state` is null:** start from `startStepId`.

**When a step is waiting:**
- *buttons:* match by label or value, ignoring case, or by 1-based number.
  - With no match, `fallback: "repeat"` re-asks with the buttons. Otherwise finish the flow with `action: "ai"`
    and `passthrough: true`.
  - With a match, store the variable and go to the option's next step, else the step's next step.
- *question / collect_email:* validate the input (collect_email always checks for an email).
  - If it is invalid, re-ask with the error message.
  - If it is valid, store it (default variable `email` or `answer_<id>`) and continue.

**Then walk up to 25 steps:**
- `message` emits and continues.
- `question`, `collect_email` and `buttons` emit and wait.
- `ai` emits optional text, then finishes with action `ai`.
- `handoff` emits text, then finishes with action `handoff`.
- Falling off the end finishes with action `ai`.
- `{{var}}` templating is applied to every message.

### Persistence

- `getScenario` (with ordered steps), `listScenarios` (with step_count), `getActiveScenario`.
- `createScenario`, `renameScenario`, `deleteScenario`.
- `addStep`:
  - Validate the type and sanitise the config.
  - Options can be strings or objects, up to 10, with labels of at most 80 characters.
  - The first step becomes the start step automatically.
  - `previous_step_id` links the previous step to the new one.
- `updateStep`: merge the config.
- `deleteStep`: relink anything that pointed at the deleted step to its successor, and repair `start_step_id`.
- `setStartStep`.
- `validateFlow(steps, start)`: list human-readable problems.
- `activateScenario`: validate first, then make it the only active flow. `deactivateScenario`.
- `importFlow(env, wsId, {name, start, activate?, steps[{key, type, content, next, variable, validation, fallback, options[{label, value, next}]}]})`:
  map keys to ids, batch-insert, and optionally activate.

## Acceptance

Unit tests cover:
- running to the first wait
- a button leading to email validation (bad, then good), then handoff with templating
- numeric choice
- unmatched input passing through to AI
- `validateFlow` errors
