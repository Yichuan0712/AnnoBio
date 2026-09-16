function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

export function buildPromptNodeSpec(args = {}) {
  const name = toCleanString(args?.name) || 'Prompt';
  const note = toCleanString(args?.note);
  const rawSections = Array.isArray(args?.sections) ? args.sections : [];
  const sections = rawSections
    .map((section) => ({
      name: toCleanString(section?.name),
      content: String(section?.content == null ? '' : section.content).trim(),
    }))
    .filter((section) => section.name && section.content);
  const rawOutputFormat = args?.outputFormat && typeof args.outputFormat === 'object'
    ? args.outputFormat
    : {};
  const returnShape = toCleanString(rawOutputFormat?.returnShape) || 'single';
  const fields = (Array.isArray(rawOutputFormat?.fields) ? rawOutputFormat.fields : [])
    .map((field) => ({
      key: toCleanString(field?.key),
      type: toCleanString(field?.type) || 'str',
      description: String(field?.description == null ? '' : field.description).trim(),
      examples: Array.isArray(field?.examples)
        ? field.examples.map((example) => String(example == null ? '' : example)).filter(Boolean)
        : [],
      allowNone: normalizeBoolean(field?.allowNone, false),
    }))
    .filter((field) => field.key);
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;
  const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);
  const inputTypes = Object.fromEntries(Object.entries(args?.inputTypes || args?.input_types || {})
    .map(([key, type]) => [toCleanString(key), toCleanString(type)])
    .filter(([key, type]) => key && (type === 'text' || type === 'image')));

  if (!note) {
    throw new Error('Prompt note is required.');
  }
  if (sections.length === 0) {
    throw new Error('At least one non-empty prompt section is required.');
  }
  if (fields.length === 0) {
    throw new Error('At least one output field is required.');
  }

  return {
    name,
    note,
    sections,
    outputFormat: {
      returnShape,
      fields,
    },
    inputTypes,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    ensureUniqueName,
  };
}

export function summarizePromptNodeSpec(spec = {}) {
  const sectionCount = Array.isArray(spec?.sections) ? spec.sections.length : 0;
  const fieldCount = Array.isArray(spec?.outputFormat?.fields) ? spec.outputFormat.fields.length : 0;
  const returnShape = toCleanString(spec?.outputFormat?.returnShape) || 'single';
  return {
    name: toCleanString(spec?.name) || 'Prompt',
    note: String(spec?.note || ''),
    sectionCount,
    outputFieldCount: fieldCount,
    returnShape,
  };
}
