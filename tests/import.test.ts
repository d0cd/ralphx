import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseRequirements } from '../src/prd/importer.js';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Requirements Importer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ralphx-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses markdown with headings into stories', () => {
    const md = `# Auth System

## Login endpoint
Implement POST /login with JWT tokens.
- Accepts email and password
- Returns JWT on success

## Signup endpoint
Implement POST /signup with validation.
- Validates email format
- Hashes password
`;

    const prd = parseRequirements(md, 'auth-system');
    expect(prd.projectName).toBe('auth-system');
    expect(prd.stories).toHaveLength(2);
    expect(prd.stories[0].title).toBe('Login endpoint');
    expect(prd.stories[0].description).toContain('Implement POST /login');
    expect(prd.stories[0].acceptanceCriteria).toContain('Accepts email and password');
    expect(prd.stories[0].acceptanceCriteria).toContain('Returns JWT on success');
    expect(prd.stories[0].status).toBe('active');
    expect(prd.stories[0].passes).toBe(false);
    expect(prd.stories[0].priority).toBe(1);
    expect(prd.stories[1].title).toBe('Signup endpoint');
    expect(prd.stories[1].priority).toBe(2);
  });

  it('handles file with no bullet points as empty acceptance criteria', () => {
    const md = `# Project

## Task one
Just do the thing.
`;
    const prd = parseRequirements(md, 'project');
    expect(prd.stories).toHaveLength(1);
    expect(prd.stories[0].acceptanceCriteria).toHaveLength(0);
    expect(prd.stories[0].description).toContain('Just do the thing');
  });

  it('ignores empty sections', () => {
    const md = `# Project

## Real task
Do something useful.
- It works

##

## Another real task
Do another thing.
- Also works
`;
    const prd = parseRequirements(md, 'project');
    expect(prd.stories).toHaveLength(2);
  });

  it('returns empty stories for file with no h2 sections', () => {
    const md = `# Just a title

Some description without any tasks.
`;
    const prd = parseRequirements(md, 'project');
    expect(prd.stories).toHaveLength(0);
  });

  it('returns empty stories for empty string', () => {
    const prd = parseRequirements('', 'project');
    expect(prd.stories).toHaveLength(0);
    expect(prd.projectName).toBe('project');
    expect(prd.version).toBe('1.0');
  });

  it('handles whitespace-only input', () => {
    const prd = parseRequirements('   \n\n  \n  ', 'project');
    expect(prd.stories).toHaveLength(0);
  });

  it('handles markdown with only bullet points (no h2)', () => {
    const md = `- item 1
- item 2
- item 3`;
    const prd = parseRequirements(md, 'project');
    expect(prd.stories).toHaveLength(0);
  });

  it('assigns sequential IDs and priorities', () => {
    const md = `## First
Do first thing
## Second
Do second thing
## Third
Do third thing`;
    const prd = parseRequirements(md, 'test');
    expect(prd.stories[0].id).toBe('story-1');
    expect(prd.stories[1].id).toBe('story-2');
    expect(prd.stories[2].id).toBe('story-3');
    expect(prd.stories[0].priority).toBe(1);
    expect(prd.stories[1].priority).toBe(2);
    expect(prd.stories[2].priority).toBe(3);
  });
});
