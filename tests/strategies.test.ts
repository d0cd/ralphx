import { describe, it, expect } from 'vitest';
import { buildFreshPrompt, buildContinuePrompt } from '../src/context/strategies.js';
import type { Story } from '../src/types/prd.js';

const story: Story = {
  id: 's-1',
  title: 'Add auth middleware',
  description: 'Implement JWT-based auth middleware.',
  acceptanceCriteria: ['Validates JWT tokens', 'Returns 401 on invalid token'],
  priority: 1,
  status: 'active',
  passes: false,
};

describe('Context Strategies', () => {
  describe('buildFreshPrompt', () => {
    it('includes all expected sections', () => {
      const prompt = buildFreshPrompt({
        story,
        agentMd: '# Agent\nUse `npm test` to run tests.',
      });
      expect(prompt).toContain('Add auth middleware');
      expect(prompt).toContain('Implement JWT-based auth middleware');
      expect(prompt).toContain('Validates JWT tokens');
      expect(prompt).toContain('Returns 401 on invalid token');
      expect(prompt).toContain('npm test');
    });

    it('includes validation results when available', () => {
      const prompt = buildFreshPrompt({
        story,
        validationSummary: 'Tests failed: 2 assertions failed in auth.test.ts',
      });
      expect(prompt).toContain('Tests failed');
      expect(prompt).toContain('auth.test.ts');
    });

    it('omits optional sections when not provided', () => {
      const prompt = buildFreshPrompt({ story });
      expect(prompt).not.toContain('Validation');
      expect(prompt).not.toContain('Agent Instructions');
    });
  });

  describe('buildContinuePrompt', () => {
    it('includes story and hint', () => {
      const prompt = buildContinuePrompt({
        story,
        hint: 'Focus on the token expiry edge case.',
      });
      expect(prompt).toContain('Add auth middleware');
      expect(prompt).toContain('Focus on the token expiry edge case');
    });

    it('includes story without hint', () => {
      const prompt = buildContinuePrompt({ story });
      expect(prompt).toContain('Add auth middleware');
      expect(prompt).not.toContain('Hint');
    });

    it('omits prior summary', () => {
      const prompt = buildContinuePrompt({ story });
      expect(prompt).not.toContain('Prior Progress');
    });
  });
});
