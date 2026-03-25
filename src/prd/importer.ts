import type { PRD, Story } from '../types/prd.js';

export function parseRequirements(markdown: string, projectName: string): PRD {
  const lines = markdown.split('\n');
  const stories: Story[] = [];
  let currentTitle: string | null = null;
  let currentDescription: string[] = [];
  let currentCriteria: string[] = [];

  function flushStory() {
    if (currentTitle && currentTitle.trim()) {
      stories.push({
        id: `story-${stories.length + 1}`,
        title: currentTitle.trim(),
        description: currentDescription.join('\n').trim(),
        acceptanceCriteria: currentCriteria,
        priority: stories.length + 1,
        status: 'active',
        passes: false,
      });
    }
    currentTitle = null;
    currentDescription = [];
    currentCriteria = [];
  }

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      flushStory();
      currentTitle = h2Match[1];
      continue;
    }

    // Skip h1 lines
    if (line.match(/^#\s+/)) continue;

    if (currentTitle !== null) {
      const bulletMatch = line.match(/^[-*]\s+(.+)/);
      if (bulletMatch) {
        currentCriteria.push(bulletMatch[1].trim());
      } else if (line.trim()) {
        currentDescription.push(line);
      }
    }
  }

  flushStory();

  return {
    version: '1.0',
    projectName,
    stories,
    qualityGates: {},
  };
}
