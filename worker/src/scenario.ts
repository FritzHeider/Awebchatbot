import type { Env, FlowOption } from './env';
import { HttpError, isEmail, isPhone, newId, now, parseJson } from './util';

export type StepType = 'message' | 'question' | 'buttons' | 'collect_email' | 'ai' | 'handoff';
export const STEP_TYPES: StepType[] = ['message', 'question', 'buttons', 'collect_email', 'ai', 'handoff'];

export interface StepConfig {
  next_step_id?: string;
  options?: FlowOption[];
  variable?: string;
  validation?: 'text' | 'email' | 'phone';
  error_message?: string;
  fallback?: 'ai' | 'repeat';
}

export interface FlowStep {
  id: string;
  type: StepType;
  content: string;
  config: StepConfig;
  position: number;
}

export interface FlowState {
  scenarioId: string;
  waitingStepId: string | null;
  vars: Record<string, string>;
  done: boolean;
}

export interface FlowOutputMessage {
  content: string;
  buttons: string[];
}

export interface FlowResult {
  messages: FlowOutputMessage[];
  state: FlowState;
  /** What should happen after the flow output: keep waiting, continue with AI, or hand off to a human. */
  action: 'wait' | 'ai' | 'handoff';
  /** True when the visitor's input was not consumed by the flow and should be answered by the AI. */
  passthrough: boolean;
}

const MAX_STEPS_PER_TURN = 25;

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}

function matchOption(options: FlowOption[], input: string): FlowOption | null {
  const value = input.trim().toLowerCase();
  if (!value) return null;
  const byLabel = options.find((o) => String(o.label || '').trim().toLowerCase() === value || (o.value || '').toLowerCase() === value);
  if (byLabel) return byLabel;
  const num = parseInt(value, 10);
  if (String(num) === value && num >= 1 && num <= options.length) return options[num - 1];
  return null;
}

function validate(step: FlowStep, input: string): boolean {
  const kind = step.type === 'collect_email' ? 'email' : step.config.validation || 'text';
  if (kind === 'email') return isEmail(input);
  if (kind === 'phone') return isPhone(input);
  return input.trim().length > 0;
}

/**
 * Pure flow engine. Starting (state null) runs from startStepId; otherwise the visitor input is
 * applied to the waiting step and execution continues until the flow waits again or ends.
 */
export function runFlow(
  steps: Map<string, FlowStep>,
  startStepId: string | null,
  state: FlowState | null,
  scenarioId: string,
  input?: string,
): FlowResult {
  const st: FlowState = state
    ? { ...state, vars: { ...state.vars } }
    : { scenarioId, waitingStepId: null, vars: {}, done: false };
  const messages: FlowOutputMessage[] = [];
  let nextId: string | undefined;

  if (state && st.waitingStepId) {
    const waiting = steps.get(st.waitingStepId);
    const text = (input || '').trim();
    if (!waiting) {
      st.done = true;
      st.waitingStepId = null;
      return { messages, state: st, action: 'ai', passthrough: Boolean(text) };
    }
    if (waiting.type === 'buttons') {
      const options = waiting.config.options || [];
      const picked = matchOption(options, text);
      if (!picked) {
        if (waiting.config.fallback === 'repeat') {
          messages.push({
            content: waiting.config.error_message || 'Please choose one of the options below.',
            buttons: options.map((o) => o.label),
          });
          return { messages, state: st, action: 'wait', passthrough: false };
        }
        st.done = true;
        st.waitingStepId = null;
        return { messages, state: st, action: 'ai', passthrough: true };
      }
      if (waiting.config.variable) st.vars[waiting.config.variable] = picked.value || picked.label;
      nextId = picked.next_step_id || waiting.config.next_step_id;
    } else {
      if (!validate(waiting, text)) {
        const fallbackMsg =
          waiting.config.error_message ||
          (waiting.type === 'collect_email' ? "That doesn't look like a valid email address. Could you check it?" : 'Could you try that again?');
        messages.push({ content: fallbackMsg, buttons: [] });
        return { messages, state: st, action: 'wait', passthrough: false };
      }
      const variable = waiting.config.variable || (waiting.type === 'collect_email' ? 'email' : `answer_${waiting.id}`);
      st.vars[variable] = text;
      nextId = waiting.config.next_step_id;
    }
    st.waitingStepId = null;
  } else if (!state) {
    nextId = startStepId || undefined;
  } else {
    // State exists but nothing is waiting: the flow already finished.
    return { messages, state: { ...st, done: true }, action: 'ai', passthrough: true };
  }

  for (let i = 0; i < MAX_STEPS_PER_TURN; i++) {
    if (!nextId) break;
    const step = steps.get(nextId);
    if (!step) break;
    const content = render(step.content, st.vars).trim();
    switch (step.type) {
      case 'message':
        if (content) messages.push({ content, buttons: [] });
        nextId = step.config.next_step_id;
        continue;
      case 'question':
      case 'collect_email':
        messages.push({ content: content || 'What is your email address?', buttons: [] });
        st.waitingStepId = step.id;
        return { messages, state: st, action: 'wait', passthrough: false };
      case 'buttons':
        messages.push({ content: content || 'Please choose an option:', buttons: (step.config.options || []).map((o) => o.label) });
        st.waitingStepId = step.id;
        return { messages, state: st, action: 'wait', passthrough: false };
      case 'ai':
        if (content) messages.push({ content, buttons: [] });
        st.done = true;
        return { messages, state: st, action: 'ai', passthrough: false };
      case 'handoff':
        if (content) messages.push({ content, buttons: [] });
        st.done = true;
        return { messages, state: st, action: 'handoff', passthrough: false };
    }
  }
  st.done = true;
  st.waitingStepId = null;
  return { messages, state: st, action: 'ai', passthrough: false };
}

// ----------------------------------------------------------------------------------------------
// Persistence
// ----------------------------------------------------------------------------------------------

export interface ScenarioRow {
  id: string;
  workspace_id: string;
  name: string;
  status: 'draft' | 'active' | 'inactive';
  start_step_id: string | null;
  created_at: number;
  updated_at: number;
}

interface StepRow {
  id: string;
  scenario_id: string;
  type: StepType;
  content: string;
  config: string;
  position: number;
  created_at: number;
}

function rowToStep(row: StepRow): FlowStep {
  return { id: row.id, type: row.type, content: row.content, config: parseJson<StepConfig>(row.config, {}), position: row.position };
}

export async function getScenario(env: Env, workspaceId: string, scenarioId: string) {
  const scenario = await env.DB.prepare('SELECT * FROM scenarios WHERE id = ? AND workspace_id = ?')
    .bind(scenarioId, workspaceId)
    .first<ScenarioRow>();
  if (!scenario) throw new HttpError(404, `Scenario ${scenarioId} not found`);
  const { results } = await env.DB.prepare('SELECT * FROM scenario_steps WHERE scenario_id = ? ORDER BY position ASC, created_at ASC')
    .bind(scenarioId)
    .all<StepRow>();
  return { ...scenario, steps: results.map(rowToStep) };
}

export async function listScenarios(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM scenario_steps st WHERE st.scenario_id = s.id) AS step_count
     FROM scenarios s WHERE s.workspace_id = ? ORDER BY s.updated_at DESC`,
  )
    .bind(workspaceId)
    .all<ScenarioRow & { step_count: number }>();
  return results;
}

export async function getActiveScenario(env: Env, workspaceId: string) {
  const row = await env.DB.prepare("SELECT id FROM scenarios WHERE workspace_id = ? AND status = 'active' LIMIT 1")
    .bind(workspaceId)
    .first<{ id: string }>();
  if (!row) return null;
  return getScenario(env, workspaceId, row.id);
}

export async function createScenario(env: Env, workspaceId: string, name: string): Promise<ScenarioRow> {
  const id = newId('scn');
  const ts = now();
  await env.DB.prepare('INSERT INTO scenarios (id, workspace_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, workspaceId, name.trim() || 'Untitled flow', 'draft', ts, ts)
    .run();
  return (await env.DB.prepare('SELECT * FROM scenarios WHERE id = ?').bind(id).first<ScenarioRow>())!;
}

export async function renameScenario(env: Env, workspaceId: string, scenarioId: string, name: string) {
  await getScenario(env, workspaceId, scenarioId);
  await env.DB.prepare('UPDATE scenarios SET name = ?, updated_at = ? WHERE id = ?').bind(name.trim(), now(), scenarioId).run();
  return getScenario(env, workspaceId, scenarioId);
}

export async function deleteScenario(env: Env, workspaceId: string, scenarioId: string) {
  await getScenario(env, workspaceId, scenarioId);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM scenario_steps WHERE scenario_id = ?').bind(scenarioId),
    env.DB.prepare('DELETE FROM scenarios WHERE id = ?').bind(scenarioId),
  ]);
}

function sanitizeConfig(type: StepType, config: unknown): StepConfig {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  const out: StepConfig = {};
  if (typeof c.next_step_id === 'string' && c.next_step_id) out.next_step_id = c.next_step_id;
  if (typeof c.variable === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(c.variable)) out.variable = c.variable;
  if (typeof c.error_message === 'string') out.error_message = c.error_message.slice(0, 500);
  if (c.validation === 'email' || c.validation === 'phone' || c.validation === 'text') out.validation = c.validation;
  if (c.fallback === 'ai' || c.fallback === 'repeat') out.fallback = c.fallback;
  if (type === 'buttons') {
    const options = Array.isArray(c.options) ? c.options : [];
    out.options = options
      .map((o) => {
        if (typeof o === 'string') return { label: o.slice(0, 80) };
        const obj = (o || {}) as Record<string, unknown>;
        const opt: FlowOption = { label: String(obj.label || '').slice(0, 80) };
        if (typeof obj.value === 'string') opt.value = obj.value.slice(0, 120);
        if (typeof obj.next_step_id === 'string' && obj.next_step_id) opt.next_step_id = obj.next_step_id;
        return opt;
      })
      .filter((o) => o.label)
      .slice(0, 10);
  }
  return out;
}

export async function addStep(
  env: Env,
  workspaceId: string,
  scenarioId: string,
  input: { type: string; content?: string; config?: unknown; previous_step_id?: string },
) {
  const scenario = await getScenario(env, workspaceId, scenarioId);
  if (!STEP_TYPES.includes(input.type as StepType)) {
    throw new HttpError(400, `type must be one of ${STEP_TYPES.join(', ')}`);
  }
  const type = input.type as StepType;
  const id = newId('step');
  const position = scenario.steps.length ? Math.max(...scenario.steps.map((s) => s.position)) + 1 : 0;
  const config = sanitizeConfig(type, input.config);
  const statements = [
    env.DB.prepare(
      'INSERT INTO scenario_steps (id, scenario_id, type, content, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, scenarioId, type, (input.content || '').slice(0, 4000), JSON.stringify(config), position, now()),
    env.DB.prepare('UPDATE scenarios SET updated_at = ? WHERE id = ?').bind(now(), scenarioId),
  ];
  if (!scenario.start_step_id) {
    statements.push(env.DB.prepare('UPDATE scenarios SET start_step_id = ? WHERE id = ?').bind(id, scenarioId));
  }
  if (input.previous_step_id) {
    const prev = scenario.steps.find((s) => s.id === input.previous_step_id);
    if (!prev) throw new HttpError(400, 'previous_step_id is not in this scenario');
    const prevConfig = { ...prev.config, next_step_id: id };
    statements.push(env.DB.prepare('UPDATE scenario_steps SET config = ? WHERE id = ?').bind(JSON.stringify(prevConfig), prev.id));
  }
  await env.DB.batch(statements);
  return getScenario(env, workspaceId, scenarioId);
}

export async function updateStep(
  env: Env,
  workspaceId: string,
  scenarioId: string,
  stepId: string,
  input: { type?: string; content?: string; config?: unknown },
) {
  const scenario = await getScenario(env, workspaceId, scenarioId);
  const step = scenario.steps.find((s) => s.id === stepId);
  if (!step) throw new HttpError(404, 'Step not found');
  const type = (input.type && STEP_TYPES.includes(input.type as StepType) ? input.type : step.type) as StepType;
  const config = input.config !== undefined ? sanitizeConfig(type, { ...step.config, ...(input.config as object) }) : step.config;
  const content = input.content !== undefined ? input.content.slice(0, 4000) : step.content;
  await env.DB.batch([
    env.DB.prepare('UPDATE scenario_steps SET type = ?, content = ?, config = ? WHERE id = ?').bind(type, content, JSON.stringify(config), stepId),
    env.DB.prepare('UPDATE scenarios SET updated_at = ? WHERE id = ?').bind(now(), scenarioId),
  ]);
  return getScenario(env, workspaceId, scenarioId);
}

export async function deleteStep(env: Env, workspaceId: string, scenarioId: string, stepId: string) {
  const scenario = await getScenario(env, workspaceId, scenarioId);
  const step = scenario.steps.find((s) => s.id === stepId);
  if (!step) throw new HttpError(404, 'Step not found');
  const statements = [env.DB.prepare('DELETE FROM scenario_steps WHERE id = ?').bind(stepId)];
  // Re-link anything pointing at the deleted step to the deleted step's successor.
  for (const other of scenario.steps) {
    if (other.id === stepId) continue;
    let changed = false;
    const cfg: StepConfig = { ...other.config };
    if (cfg.next_step_id === stepId) {
      cfg.next_step_id = step.config.next_step_id;
      if (!cfg.next_step_id) delete cfg.next_step_id;
      changed = true;
    }
    if (cfg.options) {
      cfg.options = cfg.options.map((o) => {
        if (o.next_step_id !== stepId) return o;
        changed = true;
        const copy = { ...o };
        if (step.config.next_step_id) copy.next_step_id = step.config.next_step_id;
        else delete copy.next_step_id;
        return copy;
      });
    }
    if (changed) statements.push(env.DB.prepare('UPDATE scenario_steps SET config = ? WHERE id = ?').bind(JSON.stringify(cfg), other.id));
  }
  if (scenario.start_step_id === stepId) {
    const fallback = step.config.next_step_id || scenario.steps.find((s) => s.id !== stepId)?.id || null;
    statements.push(env.DB.prepare('UPDATE scenarios SET start_step_id = ? WHERE id = ?').bind(fallback, scenarioId));
  }
  statements.push(env.DB.prepare('UPDATE scenarios SET updated_at = ? WHERE id = ?').bind(now(), scenarioId));
  await env.DB.batch(statements);
  return getScenario(env, workspaceId, scenarioId);
}

export async function setStartStep(env: Env, workspaceId: string, scenarioId: string, stepId: string) {
  const scenario = await getScenario(env, workspaceId, scenarioId);
  if (!scenario.steps.some((s) => s.id === stepId)) throw new HttpError(400, 'Step is not in this scenario');
  await env.DB.prepare('UPDATE scenarios SET start_step_id = ?, updated_at = ? WHERE id = ?').bind(stepId, now(), scenarioId).run();
  return getScenario(env, workspaceId, scenarioId);
}

/** Validate a flow graph; returns a list of human-readable problems (empty = valid). */
export function validateFlow(steps: FlowStep[], startStepId: string | null): string[] {
  const problems: string[] = [];
  const ids = new Set(steps.map((s) => s.id));
  if (!steps.length) problems.push('The flow has no steps.');
  if (!startStepId || !ids.has(startStepId)) problems.push('The flow has no valid start step.');
  for (const s of steps) {
    if (s.config.next_step_id && !ids.has(s.config.next_step_id)) problems.push(`Step ${s.id} points to a missing next step.`);
    if (s.type === 'buttons') {
      if (!s.config.options?.length) problems.push(`Buttons step ${s.id} has no options.`);
      for (const o of s.config.options || []) {
        if (o.next_step_id && !ids.has(o.next_step_id)) problems.push(`Option "${o.label}" in ${s.id} points to a missing step.`);
      }
    }
  }
  return problems;
}

export async function activateScenario(env: Env, workspaceId: string, scenarioId: string) {
  const scenario = await getScenario(env, workspaceId, scenarioId);
  const problems = validateFlow(scenario.steps, scenario.start_step_id);
  if (problems.length) throw new HttpError(400, `Cannot publish flow: ${problems.join(' ')}`);
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE scenarios SET status = 'inactive', updated_at = ? WHERE workspace_id = ? AND status = 'active'").bind(ts, workspaceId),
    env.DB.prepare("UPDATE scenarios SET status = 'active', updated_at = ? WHERE id = ?").bind(ts, scenarioId),
  ]);
  return getScenario(env, workspaceId, scenarioId);
}

export async function deactivateScenario(env: Env, workspaceId: string, scenarioId: string) {
  await getScenario(env, workspaceId, scenarioId);
  await env.DB.prepare("UPDATE scenarios SET status = 'inactive', updated_at = ? WHERE id = ?").bind(now(), scenarioId).run();
  return getScenario(env, workspaceId, scenarioId);
}

export interface FlowDefinitionStep {
  key: string;
  type: StepType;
  content?: string;
  next?: string;
  variable?: string;
  validation?: 'text' | 'email' | 'phone';
  fallback?: 'ai' | 'repeat';
  options?: { label: string; value?: string; next?: string }[];
}

/** Create a whole scenario from a declarative definition that references steps by key (used by site presets). */
export async function importFlow(
  env: Env,
  workspaceId: string,
  definition: { name: string; start: string; steps: FlowDefinitionStep[]; activate?: boolean },
) {
  if (!definition || !Array.isArray(definition.steps) || !definition.steps.length) {
    throw new HttpError(400, 'definition.steps must be a non-empty array');
  }
  const keys = new Set<string>();
  for (const step of definition.steps) {
    if (!step || typeof step.key !== 'string' || !step.key) throw new HttpError(400, 'Every step needs a string key');
    if (keys.has(step.key)) throw new HttpError(400, `Duplicate step key ${step.key}`);
    keys.add(step.key);
    if (!STEP_TYPES.includes(step.type)) throw new HttpError(400, `Unknown step type ${step.type}`);
    if (step.next && !definition.steps.some((s) => s.key === step.next)) throw new HttpError(400, `Step ${step.key} points to unknown step ${step.next}`);
    for (const o of step.options || []) {
      if (!o || typeof o.label !== 'string' || !o.label.trim()) throw new HttpError(400, `Every option in ${step.key} needs a label`);
      if (o.next && !keys.has(o.next) && !definition.steps.some((s) => s.key === o.next)) {
        throw new HttpError(400, `Option "${o.label}" in ${step.key} points to unknown step ${o.next}`);
      }
    }
  }
  if (!keys.has(definition.start)) throw new HttpError(400, `start step ${definition.start} not found`);
  const scenario = await createScenario(env, workspaceId, String(definition.name || 'Imported flow'));
  const idByKey = new Map<string, string>();
  for (const step of definition.steps) idByKey.set(step.key, newId('step'));
  const ts = now();
  const statements: D1PreparedStatement[] = [];
  definition.steps.forEach((step, position) => {
    const config = sanitizeConfig(step.type, {
      next_step_id: step.next ? idByKey.get(step.next) : undefined,
      variable: step.variable,
      validation: step.validation,
      fallback: step.fallback,
      options: (step.options || []).map((o) => ({
        label: o.label,
        value: o.value,
        next_step_id: o.next ? idByKey.get(o.next) : undefined,
      })),
    });
    statements.push(
      env.DB.prepare(
        'INSERT INTO scenario_steps (id, scenario_id, type, content, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(idByKey.get(step.key), scenario.id, step.type, String(step.content || '').slice(0, 4000), JSON.stringify(config), position, ts),
    );
  });
  statements.push(
    env.DB.prepare('UPDATE scenarios SET start_step_id = ? WHERE id = ?').bind(idByKey.get(definition.start) || null, scenario.id),
  );
  await env.DB.batch(statements);
  if (definition.activate) return activateScenario(env, workspaceId, scenario.id);
  return getScenario(env, workspaceId, scenario.id);
}
