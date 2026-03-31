type StoryStatus = 'active' | 'deferred';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  status: StoryStatus;
  passes: boolean;
  consecutiveFailures?: number;
  lastError?: string;
}

export interface PRD {
  version: string;
  projectName: string;
  stories: Story[];
  qualityGates: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
}
