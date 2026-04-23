/**
 * GET /health
 *
 * Unauthenticated. Used by the HOME screen to confirm the phone can
 * reach the backend. If this fails, nothing else (sessions, chunks)
 * will work either, so it's the right single probe to expose first.
 */

import { apiFetch } from './client';

export interface HealthResponse {
  status: 'ok' | string;
  uptime_s?: number;
  version?: string;
}

export function pingHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health', {
    auth: false,
    ...(signal ? { signal } : {}),
  });
}
