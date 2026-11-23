export const JOB_PLATFORMS = ['google_maps', 'yandex_maps', 'gis'] as const;
export type JobPlatform = (typeof JOB_PLATFORMS)[number];
export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface CreateJobInput {
  platform: JobPlatform;
  query: string;
  url?: string;
  limit?: number;
  extractContacts?: boolean;
  fields?: string[];
  owner?: string;
  requestId?: string;
  timeoutSeconds?: number;
  enrichmentLimit?: number;
}

export interface Assignment {
  workerId: string;
  attempt: number;
}

export interface Job extends CreateJobInput {
  id: string;
  limit: number;
  status: JobStatus;
  phase: string;
  results: number;
  scrapedCount: number;
  error?: string;
  errorCode?: string;
  workerId?: string;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  deadlineAt: number;
  leaseExpiresAt?: number;
}
