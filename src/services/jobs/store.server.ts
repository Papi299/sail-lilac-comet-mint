import { randomBytes } from "node:crypto";
import { config } from "../../lib/config.ts";
import type { JobRecord, JobStatusName } from "../../types/job.ts";

const jobs = new Map<string, JobRecord>();

export function createJobId(): string {
  return randomBytes(16).toString("hex");
}

export function nowMs(): number {
  return Date.now();
}

export function createJob(input: {
  url: string;
  formatId: string;
  principalId: string;
  workDir: string;
  id?: string;
  title?: string | null;
  thumbnail?: string | null;
  source?: string | null;
  extractor?: string | null;
}): JobRecord {
  const id = input.id ?? createJobId();
  const createdAt = nowMs();
  const job: JobRecord = {
    id,
    url: input.url,
    formatId: input.formatId,
    principalId: input.principalId,
    workDir: input.workDir,
    outputPath: null,
    outputMime: null,
    status: "queued",
    progress: 0,
    stageLabel: "Queued",
    downloadedBytes: null,
    totalBytes: null,
    speed: null,
    eta: null,
    error: null,
    errorCode: null,
    filename: null,
    fileSize: null,
    quality: null,
    container: null,
    title: input.title ?? null,
    thumbnail: input.thumbnail ?? null,
    source: input.source ?? null,
    extractor: input.extractor ?? null,
    createdAt,
    updatedAt: createdAt,
    expiresAt: createdAt + config.fileExpirationMinutes * 60_000,
    downloadUrl: null,
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function listJobs(): JobRecord[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
  const current = jobs.get(id);
  if (!current) return undefined;
  const next: JobRecord = { ...current, ...patch, updatedAt: nowMs() };
  jobs.set(id, next);
  return next;
}

export function countByStatus(status: JobStatusName): number {
  let n = 0;
  for (const job of jobs.values()) if (job.status === status) n += 1;
  return n;
}

export function countActive(): number {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.status !== "ready" && job.status !== "failed") n += 1;
  }
  return n;
}

export function countActiveForPrincipal(principalId: string): number {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.principalId === principalId && job.status !== "ready" && job.status !== "failed") n += 1;
  }
  return n;
}

export function expiredJobs(at = nowMs()): JobRecord[] {
  return [...jobs.values()].filter((job) => job.expiresAt <= at);
}

export function deleteJob(id: string) {
  jobs.delete(id);
}

export function resetJobsForTests() {
  jobs.clear();
}

export function averageProcessingMs(): number | null {
  const done = [...jobs.values()].filter((j) => j.finishedAt && j.startedAt);
  if (!done.length) return null;
  const total = done.reduce((sum, j) => sum + ((j.finishedAt ?? 0) - (j.startedAt ?? 0)), 0);
  return Math.round(total / done.length);
}

export function toPublicJob(job: JobRecord) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    stageLabel: job.stageLabel,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    errorCode: job.errorCode,
    filename: job.filename,
    fileSize: job.fileSize,
    quality: job.quality,
    container: job.container,
    title: job.title,
    thumbnail: job.thumbnail,
    source: job.source,
    extractor: job.extractor,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
    downloadUrl: job.status === "ready" ? `/api/download/${job.id}/file` : null,
  };
}
