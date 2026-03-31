import type { PRD, Story } from '../types/prd.js';
import { atomicWriteJson, readJsonFile } from '../sync/atomic-write.js';
import { sanitizeOutput } from '../core/validator.js';

type LegacyStatus = 'todo' | 'in_progress' | 'blocked' | 'done';
const LEGACY_STATUSES = new Set<string>(['todo', 'in_progress', 'blocked', 'done']);

/** Migrate legacy PRD formats to current schema */
function migratePrd(prd: PRD): PRD {
  for (const story of prd.stories) {
    // Migrate old status values to new model
    const status = story.status as string;
    if (LEGACY_STATUSES.has(status)) {
      const legacyStatus = status as LegacyStatus;
      if (legacyStatus === 'todo' || legacyStatus === 'in_progress' || legacyStatus === 'blocked') {
        story.status = 'active';
        story.passes = false;
      } else {
        story.status = 'active';
        story.passes = true;
      }
    }
    // Ensure passes field exists
    if (story.passes === undefined) {
      story.passes = false;
    }
  }
  return prd;
}

export function loadPrd(path: string): PRD {
  const prd = readJsonFile<PRD>(path);

  if (!prd.stories || !Array.isArray(prd.stories)) {
    throw new Error(`PRD file ${path} is missing required "stories" array`);
  }
  if (!prd.version || !prd.projectName) {
    throw new Error(`PRD file ${path} is missing required "version" or "projectName" field`);
  }

  return migratePrd(prd);
}

/** Get all active stories that haven't passed yet, sorted by priority */
export function getFailingStories(prd: PRD, maxConsecutiveFailures?: number): Story[] {
  return prd.stories
    .filter(s => s.status === 'active' && !s.passes)
    .filter(s => {
      if (maxConsecutiveFailures === undefined) return true;
      return (s.consecutiveFailures ?? 0) < maxConsecutiveFailures;
    })
    .sort((a, b) => a.priority - b.priority);
}

/** Get IDs of all active stories that currently pass */
export function getPassingStoryIds(prd: PRD): string[] {
  return prd.stories
    .filter(s => s.status === 'active' && s.passes)
    .map(s => s.id);
}

/** Check if all active stories pass */
export function allStoriesPass(prd: PRD): boolean {
  const active = prd.stories.filter(s => s.status === 'active');
  return active.length > 0 && active.every(s => s.passes);
}

/** Update a story's passes field and consecutive failure count */
export function updateStoryPasses(path: string, storyId: string, passes: boolean, error?: string): void {
  const prd = loadPrd(path);
  const story = prd.stories.find(s => s.id === storyId);
  if (!story) {
    throw new Error(`Story "${storyId}" not found in PRD at ${path}`);
  }

  story.passes = passes;
  if (passes) {
    story.consecutiveFailures = 0;
    story.lastError = undefined;
  } else {
    story.consecutiveFailures = (story.consecutiveFailures ?? 0) + 1;
    // Sanitize error before persisting — validation errors may contain
    // secrets leaked from command output or environment variables.
    story.lastError = error ? sanitizeOutput(error) : undefined;
  }

  atomicWriteJson(path, prd);
}

/** Reset passes to false for stories whose quality gates now fail */
export function resetFailingStories(path: string, storyIds: string[], reason?: string): void {
  if (storyIds.length === 0) return;
  const prd = loadPrd(path);
  for (const id of storyIds) {
    const story = prd.stories.find(s => s.id === id);
    if (story && story.passes) {
      story.passes = false;
      story.consecutiveFailures = 0; // reset since this is a regression, not a repeated failure
      if (reason) {
        story.lastError = sanitizeOutput(reason);
      }
    }
  }
  atomicWriteJson(path, prd);
}
