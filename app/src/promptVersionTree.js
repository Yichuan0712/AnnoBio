const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

/** Use the same cards, arrows and branch groups as Pipeline. */
export function renderPromptFamily(family) {
  const byId = new Map(family.versions.map((version) => [version.promptId, version]));
  const children = new Map();
  for (const version of family.versions) {
    if (!version.parentId) continue;
    if (!children.has(version.parentId)) children.set(version.parentId, []);
    children.get(version.parentId).push(version);
  }

  function renderBranch(version) {
    const parent = byId.get(version.parentId);
    const title = `${version.changeLabel}${version.reviewName ? ` — ${version.reviewName}` : ''} — Compare ${parent.name} with ${version.name}`;
    return `<div class="prompt-version__lane">
      <button type="button" class="prompt-version__change" data-action="compare" data-from-id="${escapeHtml(version.parentId)}" data-to-id="${escapeHtml(version.promptId)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">
        <span class="prompt-version__change-label">${escapeHtml(version.changeLabel)}</span>
        <span class="pipeline-overview-arrow" aria-hidden="true">→</span>
      </button>
      ${renderNode(version)}
    </div>`;
  }

  function renderNode(version) {
    const descendants = children.get(version.promptId) || [];
    const branches = descendants.length > 1
      ? `<span class="pipeline-overview-arrow" aria-hidden="true">→</span>
        <div class="pipeline-overview-branch prompt-version__fork"><div class="pipeline-overview-branch-lanes">${descendants.map(renderBranch).join('')}</div></div>`
      : descendants.map(renderBranch).join('');
    return `<div class="prompt-version__subtree">
      <button type="button" class="pipeline-overview-step prompt-version__node" data-action="locate" data-prompt-id="${escapeHtml(version.promptId)}" title="${escapeHtml(`Locate ${version.name} on canvas`)}" aria-label="${escapeHtml(`Locate ${version.name} on canvas`)}">
        <span class="pipeline-step-name">${escapeHtml(version.name)}</span>
      </button>
      ${branches}
    </div>`;
  }

  const root = byId.get(family.rootId);
  return `<section class="pipeline-overview-card prompt-optimization__family" aria-label="${escapeHtml(`Prompt family: ${root?.name || 'Prompt'}`)}">
    <div class="pipeline-overview-card-header"><h3 class="pipeline-overview-card-title">${escapeHtml(root?.name || 'Prompt')}</h3></div>
    <div class="prompt-version__graph">${root ? renderNode(root) : ''}</div>
  </section>`;
}
