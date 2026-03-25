import type { Story } from '../types/prd.js';

interface FreshPromptInput {
  story: Story;
  agentMd?: string;
  validationSummary?: string;
  progressMd?: string;
}

interface ContinuePromptInput {
  story: Story;
  hint?: string;
}

export function buildFreshPrompt(input: FreshPromptInput): string {
  const sections: string[] = [];

  // Story
  sections.push(`## Current Story: ${input.story.title}`);
  sections.push('');
  sections.push(input.story.description);
  sections.push('');
  sections.push('### Acceptance Criteria');
  for (const ac of input.story.acceptanceCriteria) {
    sections.push(`- ${ac}`);
  }

  // Validation results
  if (input.validationSummary) {
    sections.push('');
    sections.push('### Validation Results');
    sections.push(input.validationSummary);
  }

  // Prior iterations
  if (input.progressMd) {
    sections.push('');
    sections.push('### Prior Iterations');
    sections.push(input.progressMd);
  }

  // Agent instructions
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
  sections.push('Acceptance Criteria:');
  for (const ac of input.story.acceptanceCriteria) {
    sections.push(`- ${ac}`);
  }

  if (input.hint) {
    sections.push('');
    sections.push('### Hint');
    sections.push(input.hint);
  }

  return sections.join('\n');
}
