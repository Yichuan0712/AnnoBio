/**
 * Pure functions for applying agent-side prompt-node edits.
 *
 * Used by the `add_prompt_version` skill to derive a new prompt version from an
 * existing one with a list of small, atomic operations that mirror what a human
 * can do in the UI after right-click "Add new version". The same skill is used
 * repeatedly across iterations, so this module makes no assumption about which
 * round of refinement it is being invoked for.
 *
 * The shape is an op-tagged union; each op is a pure local edit on the node data
 * (sections / outputFormat). Constraints prevent wholesale rewrites: per-replacement
 * char caps, per-section change-ratio, and a global change-ratio guard at the top.
 *
 * No DOM, no canvas, no async. Pure data in -> data out (or thrown error with rich
 * diagnostic context the agent can read).
 */

import { findSegmentInContent } from './reviewWorkingSections.js';

export const DEFAULT_LIMITS = Object.freeze({
  maxOldTextChars: 300,
  maxNewTextChars: 600,
  maxNewTextRatio: 3,
  maxAddSectionContentChars: 1000,
  perSectionChangeRatio: 0.40,
  // Absolute char allowance below which a section is too small for the % gate to
  // matter (e.g. a 10-char section can still get a typo fix). Both the ratio AND
  // the absolute distance must be exceeded for a per-section violation.
  perSectionChangeAbsoluteFloor: 40,
  globalChangeRatio: 0.35,
  softMaxEdits: 8,
});

const SUPPORTED_OPS = Object.freeze([
  'add_section',
  'delete_section',
  'modify_section',
  'add_output_field',
  'remove_output_field',
  'modify_output_field',
]);

function asSectionsArray(sections) {
  if (!Array.isArray(sections)) return [];
  return sections.map((section) => ({
    name: String(section?.name ?? ''),
    content: String(section?.content ?? ''),
  }));
}

function asOutputFormat(outputFormat) {
  const fields = Array.isArray(outputFormat?.fields) ? outputFormat.fields : [];
  return {
    returnShape: String(outputFormat?.returnShape ?? 'single'),
    fields: fields.map((field) => ({
      key: String(field?.key ?? ''),
      type: String(field?.type ?? 'str'),
      description: String(field?.description ?? ''),
      examples: Array.isArray(field?.examples) ? field.examples.map((value) => String(value ?? '')) : [],
      allowNone: field?.allowNone === true,
    })),
  };
}

function clonePromptData(data) {
  return {
    sections: asSectionsArray(data?.sections),
    outputFormat: asOutputFormat(data?.outputFormat),
  };
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen > 50000 || bLen > 50000) {
    return Math.abs(aLen - bLen);
  }
  let prev = new Array(bLen + 1);
  let cur = new Array(bLen + 1);
  for (let j = 0; j <= bLen; j++) prev[j] = j;
  for (let i = 1; i <= aLen; i++) {
    cur[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[bLen];
}

function changeRatio(before, after) {
  const a = String(before ?? '');
  const b = String(after ?? '');
  const denom = Math.max(a.length, b.length, 1);
  return levenshteinDistance(a, b) / denom;
}

function buildEditError(detail) {
  const message = String(detail?.message || 'Edit failed.');
  const error = new Error(message);
  error.name = 'PromptEditError';
  for (const [key, value] of Object.entries(detail || {})) {
    if (key === 'message') continue;
    try { error[key] = value; } catch (_) { /* ignore */ }
  }
  return error;
}

function summarizeAvailableSections(state) {
  return state.sections.map((section) => section.name);
}

function findSectionIndexByName(state, name) {
  const target = String(name ?? '');
  return state.sections.findIndex((section) => section.name === target);
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while ((from = haystack.indexOf(needle, from)) !== -1) {
    count += 1;
    from += needle.length;
  }
  return count;
}

function findRegexMatches(haystack, pattern) {
  const matches = [];
  let regex;
  try {
    regex = new RegExp(pattern, 'g');
  } catch (_) {
    return matches;
  }
  let safety = 0;
  let match;
  while ((match = regex.exec(haystack)) !== null) {
    matches.push({ start: match.index, length: match[0].length, matched: match[0] });
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
    safety += 1;
    if (safety > 10000) break;
  }
  return matches;
}

/**
 * Locate `oldText` inside `content` using strict three-tier matching.
 * No fuzzy fallback. Returns { matched, start, end, matchedString, matchCount, tier }
 * where matched=true requires exactly one match.
 */
function locateUniqueOldText(content, oldText) {
  const raw = String(oldText ?? '');
  if (!raw) {
    return { matched: false, matchCount: 0, tier: 'empty' };
  }

  // Tier 1: literal substring search.
  const literalCount = countOccurrences(content, raw);
  if (literalCount === 1) {
    const start = content.indexOf(raw);
    return { matched: true, start, end: start + raw.length, matchedString: raw, matchCount: 1, tier: 'literal' };
  }
  if (literalCount > 1) {
    return { matched: false, matchCount: literalCount, tier: 'literal' };
  }

  // Tier 2: trim the candidate and try literal again.
  const trimmed = raw.trim();
  if (trimmed && trimmed !== raw) {
    const trimCount = countOccurrences(content, trimmed);
    if (trimCount === 1) {
      const start = content.indexOf(trimmed);
      return { matched: true, start, end: start + trimmed.length, matchedString: trimmed, matchCount: 1, tier: 'trim' };
    }
    if (trimCount > 1) {
      return { matched: false, matchCount: trimCount, tier: 'trim' };
    }
  }

  // Tier 3: whitespace-flexible regex.
  const baseTrim = trimmed || raw;
  const escaped = baseTrim
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const matches = findRegexMatches(content, escaped);
  if (matches.length === 1) {
    return {
      matched: true,
      start: matches[0].start,
      end: matches[0].start + matches[0].length,
      matchedString: matches[0].matched,
      matchCount: 1,
      tier: 'ws-flex',
    };
  }
  if (matches.length > 1) {
    return { matched: false, matchCount: matches.length, tier: 'ws-flex' };
  }

  // Sanity: if findSegmentInContent (review's locator) finds something but our
  // strict match did not, the agent might have whitespace differences we still
  // cannot reduce to one unique span. Fall through to not-found.
  if (findSegmentInContent(content, raw)) {
    return { matched: false, matchCount: 0, tier: 'all', segmentLikelyExists: true };
  }
  return { matched: false, matchCount: 0, tier: 'all' };
}

/**
 * Apply text replacements to a section content all-at-once based on the original
 * content (later replacements never see earlier replacements' output). Detects
 * overlapping replacement ranges and reports them as a structured error.
 */
function applyReplacementsSimultaneously({
  content,
  replacements,
  opIndex,
  sectionName,
}) {
  const matches = [];
  for (let i = 0; i < replacements.length; i += 1) {
    const replacement = replacements[i] || {};
    const oldText = String(replacement.old_text ?? '');
    const newText = String(replacement.new_text ?? '');
    const located = locateUniqueOldText(content, oldText);
    if (!located.matched) {
      if (located.matchCount > 1) {
        throw buildEditError({
          message: `modify_section "${sectionName}" text_replacements[${i}] is ambiguous: old_text matched ${located.matchCount} times in this section. Extend old_text with surrounding context until it is unique.`,
          failedOpIndex: opIndex,
          failedOp: 'modify_section',
          reason: 'old_text_ambiguous',
          section_name: sectionName,
          replacement_index: i,
          attempted_old_text: oldText,
          match_count: located.matchCount,
          match_tier: located.tier,
        });
      }
      throw buildEditError({
        message: `modify_section "${sectionName}" text_replacements[${i}] failed: old_text not found in this section. Use inspect_node on the source prompt to copy a verbatim substring.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_section',
        reason: 'old_text_not_found',
        section_name: sectionName,
        replacement_index: i,
        attempted_old_text: oldText,
        current_section_content: content,
        likely_close_match: located.segmentLikelyExists === true,
      });
    }
    matches.push({ start: located.start, end: located.end, newText });
  }

  matches.sort((a, b) => a.start - b.start);
  for (let i = 1; i < matches.length; i += 1) {
    if (matches[i].start < matches[i - 1].end) {
      throw buildEditError({
        message: `modify_section "${sectionName}" text_replacements overlap: replacements at offsets ${matches[i - 1].start}..${matches[i - 1].end} and ${matches[i].start}..${matches[i].end} cover the same text. Combine them into a single replacement.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_section',
        reason: 'overlapping_replacements',
        section_name: sectionName,
      });
    }
  }

  let result = '';
  let cursor = 0;
  for (const match of matches) {
    result += content.slice(cursor, match.start);
    result += match.newText;
    cursor = match.end;
  }
  result += content.slice(cursor);
  return result;
}

function ensureUniqueSectionName(state, name, ignoreIndex = -1) {
  for (let i = 0; i < state.sections.length; i += 1) {
    if (i === ignoreIndex) continue;
    if (state.sections[i].name === name) return false;
  }
  return true;
}

function ensureUniqueFieldKey(state, key, ignoreIndex = -1) {
  for (let i = 0; i < state.outputFormat.fields.length; i += 1) {
    if (i === ignoreIndex) continue;
    if (state.outputFormat.fields[i].key === key) return false;
  }
  return true;
}

function applyAddSection(state, op, opIndex, limits) {
  const name = String(op?.name ?? '').trim();
  if (!name) {
    throw buildEditError({
      message: `add_section requires a non-empty "name".`,
      failedOpIndex: opIndex,
      failedOp: 'add_section',
      reason: 'missing_name',
    });
  }
  if (!ensureUniqueSectionName(state, name)) {
    throw buildEditError({
      message: `add_section cannot create section "${name}" because a section with that name already exists.`,
      failedOpIndex: opIndex,
      failedOp: 'add_section',
      reason: 'duplicate_section_name',
      attempted_name: name,
      existing_sections: summarizeAvailableSections(state),
    });
  }
  const content = String(op?.content ?? '');
  if (content.length > limits.maxAddSectionContentChars) {
    throw buildEditError({
      message: `add_section "${name}" content length ${content.length} exceeds limit ${limits.maxAddSectionContentChars}. Split into multiple sections or shorten.`,
      failedOpIndex: opIndex,
      failedOp: 'add_section',
      reason: 'content_too_large',
      attempted_name: name,
      content_length: content.length,
      limit: limits.maxAddSectionContentChars,
    });
  }

  const after = String(op?.after ?? '').trim();
  let insertIdx = state.sections.length;
  if (after) {
    const idx = findSectionIndexByName(state, after);
    if (idx < 0) {
      throw buildEditError({
        message: `add_section anchor "after"="${after}" did not match any existing section.`,
        failedOpIndex: opIndex,
        failedOp: 'add_section',
        reason: 'anchor_section_not_found',
        attempted_after: after,
        available_sections: summarizeAvailableSections(state),
      });
    }
    insertIdx = idx + 1;
  }

  state.sections = [
    ...state.sections.slice(0, insertIdx),
    { name, content },
    ...state.sections.slice(insertIdx),
  ];
}

function applyDeleteSection(state, op, opIndex) {
  const name = String(op?.name ?? '').trim();
  if (!name) {
    throw buildEditError({
      message: `delete_section requires a non-empty "name".`,
      failedOpIndex: opIndex,
      failedOp: 'delete_section',
      reason: 'missing_name',
    });
  }
  const idx = findSectionIndexByName(state, name);
  if (idx < 0) {
    throw buildEditError({
      message: `delete_section target "${name}" was not found.`,
      failedOpIndex: opIndex,
      failedOp: 'delete_section',
      reason: 'section_not_found',
      attempted_name: name,
      available_sections: summarizeAvailableSections(state),
    });
  }
  if (state.sections.length <= 1) {
    throw buildEditError({
      message: `delete_section refused: prompt must keep at least one section.`,
      failedOpIndex: opIndex,
      failedOp: 'delete_section',
      reason: 'cannot_delete_last_section',
      attempted_name: name,
    });
  }
  state.sections = state.sections.filter((_, i) => i !== idx);
}

function applyModifySection(state, op, opIndex, limits) {
  const sectionName = String(op?.section_name ?? '').trim();
  if (!sectionName) {
    throw buildEditError({
      message: `modify_section requires "section_name" to identify the target.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_section',
      reason: 'missing_section_name',
    });
  }
  const idx = findSectionIndexByName(state, sectionName);
  if (idx < 0) {
    throw buildEditError({
      message: `modify_section target "${sectionName}" was not found.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_section',
      reason: 'section_not_found',
      attempted_section_name: sectionName,
      available_sections: summarizeAvailableSections(state),
    });
  }

  const before = state.sections[idx];
  const newNameRaw = op?.new_name;
  const hasNewName = newNameRaw != null && String(newNameRaw).trim() !== '' && String(newNameRaw).trim() !== before.name;
  const replacements = Array.isArray(op?.text_replacements) ? op.text_replacements : null;
  const hasReplacements = replacements && replacements.length > 0;
  const appendText = typeof op?.append_text === 'string' ? op.append_text : '';
  const hasAppend = appendText.length > 0;

  if (!hasNewName && !hasReplacements && !hasAppend) {
    throw buildEditError({
      message: `modify_section "${sectionName}" needs at least one of new_name, text_replacements, append_text.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_section',
      reason: 'empty_modify',
      attempted_section_name: sectionName,
    });
  }

  let nextName = before.name;
  if (hasNewName) {
    const trimmedNewName = String(newNameRaw).trim();
    if (!ensureUniqueSectionName(state, trimmedNewName, idx)) {
      throw buildEditError({
        message: `modify_section cannot rename "${sectionName}" to "${trimmedNewName}" because that name is already in use.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_section',
        reason: 'rename_conflict',
        attempted_section_name: sectionName,
        attempted_new_name: trimmedNewName,
        existing_sections: summarizeAvailableSections(state),
      });
    }
    nextName = trimmedNewName;
  }

  let nextContent = before.content;
  if (hasReplacements) {
    for (let i = 0; i < replacements.length; i += 1) {
      const replacement = replacements[i] || {};
      const oldText = String(replacement.old_text ?? '');
      const newText = String(replacement.new_text ?? '');
      if (typeof replacement.old_text !== 'string' || oldText === '') {
        throw buildEditError({
          message: `modify_section "${sectionName}" text_replacements[${i}].old_text must be a non-empty string.`,
          failedOpIndex: opIndex,
          failedOp: 'modify_section',
          reason: 'replacement_invalid_old_text',
          replacement_index: i,
        });
      }
      if (typeof replacement.new_text !== 'string') {
        throw buildEditError({
          message: `modify_section "${sectionName}" text_replacements[${i}].new_text must be a string.`,
          failedOpIndex: opIndex,
          failedOp: 'modify_section',
          reason: 'replacement_invalid_new_text',
          replacement_index: i,
        });
      }
      if (oldText.length > limits.maxOldTextChars) {
        throw buildEditError({
          message: `modify_section "${sectionName}" text_replacements[${i}].old_text length ${oldText.length} exceeds limit ${limits.maxOldTextChars}. Split into multiple smaller replacements.`,
          failedOpIndex: opIndex,
          failedOp: 'modify_section',
          reason: 'replacement_old_text_too_long',
          replacement_index: i,
          old_text_length: oldText.length,
          limit: limits.maxOldTextChars,
        });
      }
      if (newText.length > limits.maxNewTextChars) {
        throw buildEditError({
          message: `modify_section "${sectionName}" text_replacements[${i}].new_text length ${newText.length} exceeds limit ${limits.maxNewTextChars}.`,
          failedOpIndex: opIndex,
          failedOp: 'modify_section',
          reason: 'replacement_new_text_too_long',
          replacement_index: i,
          new_text_length: newText.length,
          limit: limits.maxNewTextChars,
        });
      }
      if (oldText.length > 0 && newText.length > oldText.length * limits.maxNewTextRatio) {
        throw buildEditError({
          message: `modify_section "${sectionName}" text_replacements[${i}] expands the original by more than ${limits.maxNewTextRatio}x (${oldText.length} -> ${newText.length}). Use append_text or split into smaller edits instead.`,
          failedOpIndex: opIndex,
          failedOp: 'modify_section',
          reason: 'replacement_expansion_too_large',
          replacement_index: i,
          old_text_length: oldText.length,
          new_text_length: newText.length,
          ratio_limit: limits.maxNewTextRatio,
        });
      }
    }
    nextContent = applyReplacementsSimultaneously({
      content: nextContent,
      replacements,
      opIndex,
      sectionName,
    });
  }

  if (hasAppend) {
    const separator = nextContent && !nextContent.endsWith('\n') ? '\n' : '';
    nextContent = nextContent + separator + appendText;
  }

  if (hasReplacements || hasAppend) {
    const distance = levenshteinDistance(before.content, nextContent);
    const denom = Math.max(before.content.length, nextContent.length, 1);
    const ratio = distance / denom;
    // Two gates must BOTH be exceeded to fail: ratio > 40% AND raw distance > absolute floor.
    // The floor lets tiny sections still accept tiny changes (e.g. typo in a 10-char section)
    // while the ratio caps wholesale rewrites of medium/large sections.
    if (ratio > limits.perSectionChangeRatio && distance > limits.perSectionChangeAbsoluteFloor) {
      throw buildEditError({
        message: `modify_section "${sectionName}" change ratio ${(ratio * 100).toFixed(0)}% (${distance} chars edited out of ${denom}) exceeds the per-section limit of ${(limits.perSectionChangeRatio * 100).toFixed(0)}%. Either preserve more of the existing wording verbatim, split into multiple smaller modify_section calls across separate add_prompt_version versions, or use create_prompt_node for a from-scratch rewrite.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_section',
        reason: 'per_section_change_ratio_exceeded',
        attempted_section_name: sectionName,
        before_section_content: before.content,
        after_section_content_attempted: nextContent,
        change_ratio: Number(ratio.toFixed(4)),
        change_distance: distance,
        ratio_limit: Number(limits.perSectionChangeRatio.toFixed(4)),
        absolute_floor: limits.perSectionChangeAbsoluteFloor,
      });
    }
  }

  state.sections = state.sections.map((section, i) => (i === idx ? { name: nextName, content: nextContent } : section));
}

function applyAddOutputField(state, op, opIndex, limits) {
  const field = op?.field;
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw buildEditError({
      message: `add_output_field requires a "field" object with at least a non-empty "key".`,
      failedOpIndex: opIndex,
      failedOp: 'add_output_field',
      reason: 'missing_field',
    });
  }
  const key = String(field.key ?? '').trim();
  if (!key) {
    throw buildEditError({
      message: `add_output_field requires field.key to be a non-empty string.`,
      failedOpIndex: opIndex,
      failedOp: 'add_output_field',
      reason: 'missing_key',
    });
  }
  if (!ensureUniqueFieldKey(state, key)) {
    throw buildEditError({
      message: `add_output_field cannot create field "${key}" because that key already exists.`,
      failedOpIndex: opIndex,
      failedOp: 'add_output_field',
      reason: 'duplicate_field_key',
      attempted_key: key,
      existing_keys: state.outputFormat.fields.map((f) => f.key),
    });
  }
  const normalized = {
    key,
    type: String(field.type ?? 'str'),
    description: String(field.description ?? ''),
    examples: Array.isArray(field.examples) ? field.examples.map((value) => String(value ?? '')) : [],
    allowNone: field.allowNone === true,
  };
  const serialized = JSON.stringify(normalized);
  if (serialized.length > limits.maxAddSectionContentChars) {
    throw buildEditError({
      message: `add_output_field "${key}" definition is too large (${serialized.length} chars).`,
      failedOpIndex: opIndex,
      failedOp: 'add_output_field',
      reason: 'field_too_large',
      attempted_key: key,
      definition_length: serialized.length,
      limit: limits.maxAddSectionContentChars,
    });
  }
  state.outputFormat.fields = [...state.outputFormat.fields, normalized];
}

function applyRemoveOutputField(state, op, opIndex) {
  const key = String(op?.key ?? '').trim();
  if (!key) {
    throw buildEditError({
      message: `remove_output_field requires "key".`,
      failedOpIndex: opIndex,
      failedOp: 'remove_output_field',
      reason: 'missing_key',
    });
  }
  const idx = state.outputFormat.fields.findIndex((field) => field.key === key);
  if (idx < 0) {
    throw buildEditError({
      message: `remove_output_field target key "${key}" was not found.`,
      failedOpIndex: opIndex,
      failedOp: 'remove_output_field',
      reason: 'field_not_found',
      attempted_key: key,
      available_keys: state.outputFormat.fields.map((f) => f.key),
    });
  }
  if (state.outputFormat.fields.length <= 1) {
    throw buildEditError({
      message: `remove_output_field refused: output schema must keep at least one field.`,
      failedOpIndex: opIndex,
      failedOp: 'remove_output_field',
      reason: 'cannot_remove_last_field',
      attempted_key: key,
    });
  }
  state.outputFormat.fields = state.outputFormat.fields.filter((_, i) => i !== idx);
}

function applyModifyOutputField(state, op, opIndex) {
  const key = String(op?.key ?? '').trim();
  if (!key) {
    throw buildEditError({
      message: `modify_output_field requires "key" to identify the target field.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_output_field',
      reason: 'missing_key',
    });
  }
  const idx = state.outputFormat.fields.findIndex((field) => field.key === key);
  if (idx < 0) {
    throw buildEditError({
      message: `modify_output_field target key "${key}" was not found.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_output_field',
      reason: 'field_not_found',
      attempted_key: key,
      available_keys: state.outputFormat.fields.map((f) => f.key),
    });
  }
  const newKeyRaw = op?.new_key;
  const hasNewKey = newKeyRaw != null && String(newKeyRaw).trim() !== '' && String(newKeyRaw).trim() !== key;
  const patch = op?.patch;
  const hasPatch = patch != null && typeof patch === 'object' && !Array.isArray(patch);

  if (!hasNewKey && !hasPatch) {
    throw buildEditError({
      message: `modify_output_field "${key}" needs at least one of new_key, patch.`,
      failedOpIndex: opIndex,
      failedOp: 'modify_output_field',
      reason: 'empty_modify',
      attempted_key: key,
    });
  }

  const before = state.outputFormat.fields[idx];
  let nextKey = before.key;
  if (hasNewKey) {
    const trimmedNewKey = String(newKeyRaw).trim();
    if (!ensureUniqueFieldKey(state, trimmedNewKey, idx)) {
      throw buildEditError({
        message: `modify_output_field cannot rename "${key}" to "${trimmedNewKey}" because that key is already in use.`,
        failedOpIndex: opIndex,
        failedOp: 'modify_output_field',
        reason: 'rename_conflict',
        attempted_key: key,
        attempted_new_key: trimmedNewKey,
        existing_keys: state.outputFormat.fields.map((f) => f.key),
      });
    }
    nextKey = trimmedNewKey;
  }

  const next = { ...before, key: nextKey };
  if (hasPatch) {
    if (typeof patch.type === 'string') next.type = patch.type;
    if (typeof patch.description === 'string') next.description = patch.description;
    if (Array.isArray(patch.examples)) next.examples = patch.examples.map((value) => String(value ?? ''));
    if (typeof patch.allowNone === 'boolean') next.allowNone = patch.allowNone;
  }
  state.outputFormat.fields = state.outputFormat.fields.map((field, i) => (i === idx ? next : field));
}

const OP_HANDLERS = Object.freeze({
  add_section: applyAddSection,
  delete_section: applyDeleteSection,
  modify_section: applyModifySection,
  add_output_field: applyAddOutputField,
  remove_output_field: applyRemoveOutputField,
  modify_output_field: applyModifyOutputField,
});

/**
 * Compute a global change ratio between two prompt-data snapshots based on the
 * concatenated section content. Output schema changes are bounded by per-field
 * constraints and do not contribute to the global ratio.
 */
export function computeGlobalChangeRatio(beforeData, afterData) {
  const before = (beforeData?.sections || [])
    .map((section) => String(section?.content || ''))
    .join('\n');
  const after = (afterData?.sections || [])
    .map((section) => String(section?.content || ''))
    .join('\n');
  return {
    ratio: changeRatio(before, after),
    beforeChars: before.length,
    afterChars: after.length,
  };
}

/**
 * Apply a list of edit ops to a prompt data snapshot. Returns the new data plus
 * any non-fatal warnings (e.g. exceeding the soft op-count cap).
 *
 * Throws a PromptEditError on any structural or content-shape violation; the
 * thrown error carries rich diagnostic fields the agent loop can surface back
 * to the planner.
 */
export function applyPromptNodeEdits(initialData, edits, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options?.limits || {}) };
  const state = clonePromptData(initialData);
  const warnings = [];

  if (edits == null) {
    return { state, warnings };
  }
  if (!Array.isArray(edits)) {
    throw buildEditError({
      message: `edits must be an array of op objects.`,
      failedOpIndex: -1,
      failedOp: 'unknown',
      reason: 'edits_not_array',
    });
  }
  if (edits.length === 0) {
    return { state, warnings };
  }
  if (edits.length > limits.softMaxEdits) {
    warnings.push(
      `edits length ${edits.length} exceeds soft limit ${limits.softMaxEdits}; consider splitting into multiple add_prompt_version calls so each version is easy to review.`,
    );
  }

  for (let i = 0; i < edits.length; i += 1) {
    const op = edits[i];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      throw buildEditError({
        message: `edits[${i}] must be an object with an "op" field.`,
        failedOpIndex: i,
        failedOp: 'unknown',
        reason: 'invalid_op_shape',
      });
    }
    const opName = String(op.op || '').trim();
    const handler = OP_HANDLERS[opName];
    if (!handler) {
      throw buildEditError({
        message: `Unknown op "${opName || 'unset'}" at edits[${i}]. Supported ops: ${SUPPORTED_OPS.join(', ')}.`,
        failedOpIndex: i,
        failedOp: opName || 'unknown',
        reason: 'unknown_op',
        supported_ops: SUPPORTED_OPS,
      });
    }
    handler(state, op, i, limits);
  }

  if (state.sections.length === 0) {
    throw buildEditError({
      message: `After applying edits, the prompt has zero sections.`,
      failedOpIndex: -1,
      failedOp: 'final_validation',
      reason: 'no_sections_left',
    });
  }
  if (state.outputFormat.fields.length === 0) {
    throw buildEditError({
      message: `After applying edits, the output schema has zero fields.`,
      failedOpIndex: -1,
      failedOp: 'final_validation',
      reason: 'no_output_fields_left',
    });
  }

  return { state, warnings };
}

export const SUPPORTED_PROMPT_EDIT_OPS = SUPPORTED_OPS;
