/** Lightweight empty-chat guidance; examples become drafts, never automatic requests. */
export function createAgentWelcome({ projectOpen, hasNodes, onChoose, onDismiss }) {
  const element = document.createElement('section');
  element.className = 'agent-window__welcome';
  element.setAttribute('aria-label', 'What the Agent can help with');

  const header = document.createElement('div');
  header.className = 'agent-window__welcome-header';
  const title = document.createElement('h3');
  title.className = 'agent-window__welcome-title';
  title.textContent = 'What would you like to do?';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'agent-window__welcome-close';
  close.textContent = '\u00d7';
  close.title = 'Dismiss suggestions';
  close.setAttribute('aria-label', 'Dismiss Agent suggestions');
  close.addEventListener('click', () => onDismiss?.());
  header.append(title, close);
  const description = document.createElement('p');
  description.className = 'agent-window__welcome-description';
  description.textContent = 'I can help you learn AnnoBio, find biomedical data, build pipelines, and improve prompts.';

  const examples = document.createElement('div');
  examples.className = 'agent-window__welcome-examples';
  const suggestions = [
    ['Show me how to use AnnoBio', hasNodes
      ? 'Show me how to use AnnoBio step by step, using this workspace as an example. Explain the next action and guide me one step at a time.'
      : 'Show me how to use AnnoBio step by step. Help me choose a first task and guide me one step at a time.'],
    ['Help me find relevant data', 'Help me find relevant biomedical data. Ask me about my research topic and goals, then help me choose a source and import the data.'],
    ['Help me build a pipeline', projectOpen
      ? 'Help me build a pipeline. Ask me about my data and the steps I want to perform, then guide me through setting it up.'
      : 'Help me build a pipeline in a new workspace. Ask me about my data and goals first, then help me create the workspace and set up the pipeline.'],
    ['Help me improve a prompt', 'Help me improve a prompt. Ask me about my task, current prompt, and expected output. Help me evaluate it if I have ground-truth data.'],
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
  element.append(header, description, examples, hint);
  return element;
}
