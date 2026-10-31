/** Lightweight empty-chat guidance; examples become drafts, never automatic requests. */
export function createAgentWelcome({ projectOpen, hasNodes, onChoose }) {
  const element = document.createElement('section');
  element.className = 'agent-window__welcome';
  element.setAttribute('aria-label', 'What the Agent can help with');

  const title = document.createElement('h3');
  title.className = 'agent-window__welcome-title';
  title.textContent = 'What would you like to do?';
  const description = document.createElement('p');
  description.className = 'agent-window__welcome-description';
  description.textContent = 'I can help you find biomedical data, build annotation pipelines, and evaluate or improve prompts.';

  const examples = document.createElement('div');
  examples.className = 'agent-window__welcome-examples';
  const suggestions = [
    hasNodes
      ? ['Explain this workspace', 'Explain the pipeline in this workspace and suggest what I should do next.']
      : ['Find biomedical data', 'Help me find biomedical data for an annotation task. Ask me about the topic and data source first.'],
    projectOpen
      ? ['Build an annotation pipeline', 'Help me build an annotation pipeline. Ask me about my data and the fields I want to extract.']
      : ['Start a workspace', 'Help me create a workspace for a biomedical annotation task. Ask me about my data and goals first.'],
    ['Evaluate and improve a prompt', 'Help me set up prompt evaluation using ground-truth data, then improve the prompt.'],
  ];
  for (const [label, prompt] of suggestions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-window__welcome-example';
    button.textContent = label;
    button.addEventListener('click', () => onChoose(prompt));
    examples.appendChild(button);
  }

  const hint = document.createElement('p');
  hint.className = 'agent-window__welcome-hint';
  hint.textContent = 'Choose an example to edit, or describe your task below.';
  element.append(title, description, examples, hint);
  return element;
}
