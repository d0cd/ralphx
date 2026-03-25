import { readFileSync } from 'node:fs';
import type { PRD, Story } from '../types/prd.js';
import { atomicWriteJson } from '../sync/atomic-write.js';

/** Legacy status values that may exist in older PRD files */
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
      } else if (legacyStatus === 'done') {
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
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new Error(`Failed to read PRD file at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  let prd: PRD;
  try {
    prd = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in PRD file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

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

/**
 * Group stories by their `group` field for parallel execution.
 * Stories in the same group run in parallel. Groups run sequentially (lower group first).
 * Stories without a group field default to their priority (sequential).
 */
export function groupStories(stories: Story[]): Story[][] {
  const grouped = new Map<number, Story[]>();

  for (const story of stories) {
    const group = story.group ?? story.priority;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(story);
  }

  // Sort groups by group number, return as array of arrays
  return Array.from(grouped.entries())
    .sort(([a], [b]) => a - b)
    .map(([_, stories]) => stories);
}

/** Get next failing story not in the exclude set */
export function getNextStory(prd: PRD, excludeIds: Set<string> = new Set(), maxConsecutiveFailures?: number): Story | null {
  const candidates = getFailingStories(prd, maxConsecutiveFailures).filter(s => !excludeIds.has(s.id));
  return candidates[0] ?? null;
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
    story.lastError = error;
  }

  atomicWriteJson(path, prd);
}

/** Reset passes to false for stories whose quality gates now fail */
export function resetFailingStories(path: string, storyIds: string[]): void {
  if (storyIds.length === 0) return;
  const prd = loadPrd(path);
  for (const id of storyIds) {
    const story = prd.stories.find(s => s.id === id);
    if (story && story.passes) {
      story.passes = false;
      story.consecutiveFailures = 0; // reset since this is a regression, not a repeated failure
    }
  }
  atomicWriteJson(path, prd);
}

