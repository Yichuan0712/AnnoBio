import { createSamplerNodeSkill } from './create_sampler_node/execute.js';
import { createSampledDatasetNodeSkill } from './create_sampled_dataset_node/execute.js';
import { createSyntheticDatasetNodeSkill } from './create_synthetic_dataset_node/execute.js';
import { createPromptNodeSkill } from './create_prompt_node/execute.js';
import { createAndRunReviewNodeSkill } from './create_and_run_review_node/execute.js';
import { createRunNodeSkill } from './create_run_node/execute.js';
import { createScoreNodeSkill } from './create_score_node/execute.js';
import { runExistingNodeSkill } from './run_existing_node/execute.js';
import { saveRunResultsToWorkspaceSkill } from './save_run_results_to_workspace/execute.js';
import { saveScoreResultsToWorkspaceSkill } from './save_score_results_to_workspace/execute.js';
import { designReviewNodeSkill } from './design_review_node/execute.js';
import { designSamplerNodeSkill } from './design_sampler_node/execute.js';
import { designScoreNodeSkill } from './design_score_node/execute.js';
import { designSyntheticDatasetSkill } from './design_synthetic_dataset/execute.js';
import { designPromptNodeSkill } from './design_prompt_node/execute.js';
import { designRunNodeSkill } from './design_run_node/execute.js';
import { inspectNodeSkill } from './inspect_node/execute.js';

export const AGENT_SKILLS = Object.freeze([
  designSamplerNodeSkill,
  designSyntheticDatasetSkill,
  designPromptNodeSkill,
  designRunNodeSkill,
  designReviewNodeSkill,
  designScoreNodeSkill,
  createSamplerNodeSkill,
  createSampledDatasetNodeSkill,
  createSyntheticDatasetNodeSkill,
  createPromptNodeSkill,
  createAndRunReviewNodeSkill,
  createRunNodeSkill,
  createScoreNodeSkill,
  runExistingNodeSkill,
  saveRunResultsToWorkspaceSkill,
  saveScoreResultsToWorkspaceSkill,
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
