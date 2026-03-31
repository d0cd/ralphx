import type { Story } from '../types/prd.js';

interface FreshPromptInput {
  story: Story;
  agentMd?: string;
  validationSummary?: string;
  progressMd?: string;
  protectedPaths?: string[];
}

interface ContinuePromptInput {
  story: Story;
  hint?: string;
  protectedPaths?: string[];
}

function renderAcceptanceCriteria(sections: string[], criteria: string[], heading = '### Acceptance Criteria'): void {
  sections.push(heading);
  for (const ac of criteria) {
    sections.push(`- ${ac}`);
  }
}

function renderProtectedPaths(sections: string[], paths?: string[]): void {
  if (paths && paths.length > 0) {
    sections.push('');
    sections.push('### Protected Files');
    sections.push('Do NOT modify these files:');
    for (const p of paths) {
      sections.push(`- ${p}`);
    }
  }
}

export function buildFreshPrompt(input: FreshPromptInput): string {
  const sections: string[] = [];

  sections.push(`## Current Story: ${input.story.title}`);
  sections.push('');
  sections.push(input.story.description);
  sections.push('');
  renderAcceptanceCriteria(sections, input.story.acceptanceCriteria);

  if (input.validationSummary) {
    sections.push('');
    sections.push('### Validation Results');
    sections.push(input.validationSummary);
  }

  if (input.progressMd) {
    sections.push('');
    sections.push('### Prior Iterations');
    sections.push(input.progressMd);
  }

  renderProtectedPaths(sections, input.protectedPaths);

  if (input.agentMd) {
    sections.push('');
    sections.push('### Agent Instructions');
    sections.push(input.agentMd);
  }

  return sections.join('\n');
}

export function buildContinuePrompt(input: ContinuePromptInput): string {
  const sections: string[] = [];

  sections.push(`Continue working on: ${input.story.title}`);
  sections.push('');
  sections.push(input.story.description);
  sections.push('');
  renderAcceptanceCriteria(sections, input.story.acceptanceCriteria, 'Acceptance Criteria:');

  renderProtectedPaths(sections, input.protectedPaths);

  if (input.hint) {
    sections.push('');
    sections.push('### Hint');
    sections.push(input.hint);
  }

  return sections.join('\n');
}
