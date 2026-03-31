import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeCodeAgent } from '../src/agents/claude-code.js';

describe('ClaudeCodeAgent', () => {
  let agent: ClaudeCodeAgent;

  beforeEach(() => {
    agent = new ClaudeCodeAgent();
  });

  describe('properties', () => {
    it('has correct name', () => {
      expect(agent.name).toBe('claude-code');
    });

    it('supports session continuity', () => {
      expect(agent.supportsSessionContinuity).toBe(true);
    });

    it('supports structured output', () => {
      expect(agent.supportsStructuredOutput).toBe(true);
    });
  });
});
