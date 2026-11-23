import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVITY_LABELS,
  STAGE_DESCRIPTIONS,
  WAITING_NOTICE_AFTER_SECONDS,
  WAITING_NOTICE_TITLE,
  WAITING_NOTICE_TITLES,
  elapsedSinceRequestSeconds,
  formatClock,
  formatLimit,
  knownActivity,
  progressCardView,
} from "./job-activity-ui.ts";
import { WORKER_JOB_ACTIVITY_STATES } from "../shared/worker/job-activity.ts";
import type { JobActivity, JobProgress } from "../types/job.ts";

/**
 * VIDEOFETCH-LD4B-ACTIVITY-CONTRACT-PROGRESS-AND-REATTACHMENT-001: what the
 * progress card shows, from the job's own status only.
 */

const NOW = 1_700_000_000_000;

type CardJob = Pick<JobProgress, "status" | "activity" | "createdAt" | "expiresAt" | "progress" | "eta" | "speed">;

function job(overrides: Partial<CardJob> = {}): CardJob {
  return {
    status: "downloading",
    activity: null,
    createdAt: NOW - 95_000,
    expiresAt: NOW + 5_000_000,
    progress: null,
    eta: null,
    speed: null,
    ...overrides,
  };
}

const activity = (state: JobActivity["state"], idleSeconds: number | null, extra: Partial<JobActivity> = {}): JobActivity => ({
  state,
  elapsedSeconds: 80,
  limitSeconds: 600,
  idleSeconds,
  ...extra,
});

const view = (j: CardJob, connectivity: "connected" | "reconnecting" | "retry_exhausted" = "connected", nowMs = NOW) =>
  progressCardView(j, { connectivity, nowMs });

describe("labels", () => {
  it("every public state has a label, and none says the download failed or stalled", () => {
    assert.deepEqual(Object.keys(ACTIVITY_LABELS).sort(), [...WORKER_JOB_ACTIVITY_STATES].sort());
    for (const label of Object.values(ACTIVITY_LABELS)) {
      assert.equal(/stall|fail|error|stuck|dead/i.test(label), false, label);
    }
  });

  it("losing observation is described as such, never as the source stopping", () => {
    assert.match(ACTIVITY_LABELS.unobserved, /can't be measured/);
    assert.match(ACTIVITY_LABELS.unobserved, /Still downloading/);
  });

  it("processing and finalizing say the download itself is complete", () => {
    assert.match(STAGE_DESCRIPTIONS.processing!, /^Download complete/);
    assert.match(STAGE_DESCRIPTIONS.uploading!, /^Download complete/);
    assert.equal(STAGE_DESCRIPTIONS.ready, undefined);
  });
});

describe("the waiting notice: after about 20 s without new data, and only when the evidence says so", () => {
  it("appears at 20 s of idle time while waiting — not at 19", () => {
    assert.equal(WAITING_NOTICE_AFTER_SECONDS, 20);
    assert.equal(view(job({ activity: activity("waiting", 19) })).showWaitingNotice, false);
    assert.equal(view(job({ activity: activity("waiting", 20) })).showWaitingNotice, true);
    assert.equal(view(job({ activity: activity("waiting", 115) })).showWaitingNotice, true);
  });

  it("also while waiting for the first byte, or for the next stream resource — each with its own title", () => {
    const first = view(job({ activity: activity("awaiting-first-byte", 25) }));
    assert.equal(first.showWaitingNotice, true);
    assert.equal(first.waitingNoticeTitle, WAITING_NOTICE_TITLES["awaiting-first-byte"]);
    const next = view(job({ activity: activity("between-resources", 25) }));
    assert.equal(next.waitingNoticeTitle, WAITING_NOTICE_TITLES["between-resources"]);
    assert.equal(view(job({ activity: activity("between-resources", 3) })).showWaitingNotice, false);
    assert.equal(view(job({ activity: activity("waiting", 30) })).waitingNoticeTitle, WAITING_NOTICE_TITLE);
  });

  it("the notice replaces the activity line instead of repeating it", () => {
    const quiet = view(job({ activity: activity("waiting", 12) }));
    assert.equal(quiet.activityLabel, ACTIVITY_LABELS.waiting);
    assert.equal(quiet.waitingNoticeTitle, null);
    const long = view(job({ activity: activity("waiting", 20) }));
    assert.equal(long.activityLabel, null);
    assert.equal(long.waitingNoticeTitle, WAITING_NOTICE_TITLE);
    for (const title of Object.values(WAITING_NOTICE_TITLES)) {
      for (const label of Object.values(ACTIVITY_LABELS)) assert.equal(title.includes(label), false, `${title} / ${label}`);
    }
  });

  it("healthy progress suppresses it", () => {
    assert.equal(view(job({ activity: activity("receiving", 0) })).showWaitingNotice, false);
    assert.equal(view(job({ activity: activity("receiving", 4) })).showWaitingNotice, false);
  });

  it("observation loss, a pause between parts, or a start never shows it — nothing says the source is silent", () => {
    for (const state of ["unobserved", "between-phases", "starting"] as const) {
      assert.equal(view(job({ activity: activity(state, null) })).showWaitingNotice, false, state);
    }
  });

  it("is never derived from the percentage, speed or ETA: no activity, no notice", () => {
    for (const fields of [
      { progress: 12.5, speed: 0, eta: null },
      { progress: null, speed: null, eta: 9_999 },
      { progress: 0, speed: 0, eta: 0 },
    ]) {
      const v = view(job({ activity: null, ...fields }));
      assert.equal(v.showWaitingNotice, false);
      assert.equal(v.activityLabel, null);
    }
  });

  it("is hidden while the status channel is down: a reading from before the outage is not current", () => {
    const waiting = job({ activity: activity("waiting", 45) });
    for (const connectivity of ["reconnecting", "retry_exhausted"] as const) {
      const v = view(waiting, connectivity);
      assert.equal(v.showWaitingNotice, false, connectivity);
      assert.equal(v.activityLabel, null, connectivity);
      assert.equal(v.downloadingForSeconds, null, connectivity);
      assert.equal(v.downloadLimitSeconds, 600, "the limit itself is still true");
    }
  });
});

describe("time: elapsed since request, the download limit, measured download time", () => {
  it("elapsed since request comes from the job's creation; small clock lag reads as zero", () => {
    assert.equal(elapsedSinceRequestSeconds({ createdAt: NOW - 95_400, expiresAt: NOW + 1 }, NOW), 95);
    assert.equal(elapsedSinceRequestSeconds({ createdAt: NOW + 3_000, expiresAt: NOW + 10_000 }, NOW), 0);
  });

  it("a reading the clocks cannot support is unknown, never a wrong number", () => {
    assert.equal(elapsedSinceRequestSeconds({ createdAt: NOW + 60_000, expiresAt: NOW + 90_000 }, NOW), null);
    assert.equal(elapsedSinceRequestSeconds({ createdAt: NOW - 9_000_000, expiresAt: NOW - 3_000_000 }, NOW), null);
    assert.equal(elapsedSinceRequestSeconds({ createdAt: NOW, expiresAt: NOW }, Number.NaN), null);
  });

  it("the limit and the measured download time are shown only while downloading, from the Worker", () => {
    const v = view(job({ activity: activity("receiving", 0, { elapsedSeconds: 75, limitSeconds: 600 }) }));
    assert.equal(v.downloadLimitSeconds, 600);
    assert.equal(v.downloadingForSeconds, 75);
    for (const status of ["queued", "processing", "uploading"] as const) {
      const other = view(job({ status, activity: activity("receiving", 0) }));
      assert.equal(other.downloadLimitSeconds, null, status);
      assert.equal(other.downloadingForSeconds, null, status);
      assert.equal(other.activityLabel, null, status);
    }
  });

  it("with no activity (an older Worker), only the elapsed time since the request is shown", () => {
    const v = view(job({ activity: undefined }));
    assert.equal(v.downloadLimitSeconds, null);
    assert.equal(v.downloadingForSeconds, null);
    assert.equal(v.elapsedSinceRequestSeconds, 95);
    assert.equal(v.stageDescription, STAGE_DESCRIPTIONS.downloading);
  });

  it("formats clocks and limits plainly, with no countdown", () => {
    assert.equal(formatClock(0), "0:00");
    assert.equal(formatClock(95), "1:35");
    assert.equal(formatClock(3_725), "1:02:05");
    assert.equal(formatClock(null), "—");
    assert.equal(formatLimit(600), "10 min");
    assert.equal(formatLimit(9_000), "2 h 30 min");
    assert.equal(formatLimit(90), "1 min 30 s");
    assert.equal(formatLimit(null), "—");
  });
});

describe("knownActivity: the page trusts only what it understands", () => {
  it("an unknown state, a malformed count, or a non-downloading job is no activity", () => {
    const base = activity("receiving", 0);
    assert.deepEqual(knownActivity({ status: "downloading", activity: base }), base);
    for (const bad of [
      { ...base, state: "stalled" },
      { ...base, state: "toString" },
      { ...base, idleSeconds: -1 },
      { ...base, elapsedSeconds: 1.5 },
      { ...base, limitSeconds: 0 },
      { ...base, limitSeconds: 86_401 },
      { ...base, idleSeconds: "3" },
    ]) {
      assert.equal(knownActivity({ status: "downloading", activity: bad as unknown as JobActivity }), null, JSON.stringify(bad));
    }
    assert.equal(knownActivity({ status: "processing", activity: base }), null);
    assert.equal(knownActivity({ status: "downloading", activity: null }), null);
    assert.equal(knownActivity({ status: "downloading" }), null);
  });
});
