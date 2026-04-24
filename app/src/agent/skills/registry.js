import { inspectNodeSkill } from './inspect_node/execute.js';

export const AGENT_SKILLS = Object.freeze([
  inspectNodeSkill,
]);

export const AGENT_SKILL_REGISTRY = Object.freeze(
  AGENT_SKILLS.map((skill) => skill.meta)
);

const AGENT_SKILLS_BY_NAME = new Map(
  AGENT_SKILLS.map((skill) => [String(skill?.meta?.name || '').trim(), skill])
);

export function getAgentSkillByName(name) {
  return AGENT_SKILLS_BY_NAME.get(String(name || '').trim()) || null;
}
