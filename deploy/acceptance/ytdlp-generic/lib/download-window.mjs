// The durable-`downloading` process window (§9-§12 of CORRECTION-02).
//
// Two defects this module exists to fix.
//
// ── 1. The window was not scoped to `downloading` ──────────────────────────
//
// The old sampler ran from job creation until the job settled, so samples taken
// while the job was in `processing` were fed into a check named
// "no FFmpeg during downloading". Worker FFmpeg is EXPLICITLY ALLOWED during
// `processing` — `preset:mp3`, and `preset:audio` from a muxed source, are
// Worker-side FFmpeg operations performed strictly after `beginProcessing()`
// commits. A correct deployment would therefore have failed the check, and the
// lifecycle boundary the acceptance exists to prove was not being tested at all.
//
// ── 2. One "best" sample decided a security verdict ────────────────────────
//
// The old sampler kept whichever sample had the most rows and discarded the
// rest. A transient `ffmpeg` visible in one 250 ms sample and gone by the next
// would simply not be in the retained sample. A negative security claim has to
// be true across the WHOLE measured window, so every sample contributes.
//
// This module is pure over a list of samples. Collecting them is the producer's
// job; deciding what they mean is this module's.

import {
  classifyAcquisitionTree,
  evaluateNamespaceIdentity,
  evaluateNodeContainment,
  evaluateYtdlpIdentity,
  validateSampleShape,
} from "./process-tree.mjs";

/**
 * Aggregates every sample taken while durable state was `downloading`.
 *
 * @param {object} window
 *   `{ samples: [{ sample, ytdlpPid, at }], workerPid, expectedNetns }`
 * @returns a sanitized aggregate — basenames, pids, namespace ids and booleans.
 *   Never a command line, never a URL.
 */
export function aggregateDownloadWindow(window) {
  const samples = Array.isArray(window?.samples) ? window.samples : [];
  const workerPid = window?.workerPid;
  const expectedNetns = window?.expectedNetns ?? null;

  if (samples.length === 0) {
    // The empty-collection shape must match the populated one, so a caller
    // reading `shapeViolations.length` on an empty window does not crash.
    return Object.freeze({
      usable: false,
      reason: "no process sample was taken while the job was observed in `downloading`",
      samplesTaken: 0,
      usableSamples: 0,
      shapeViolations: Object.freeze([]),
      forbiddenSeen: Object.freeze([]),
      unknownSeen: Object.freeze([]),
      namespaceViolations: Object.freeze([]),
      nodeObservations: Object.freeze([]),
      ytdlpIdentities: Object.freeze([]),
      basenamesSeen: Object.freeze([]),
      expectedNetns,
      workerPid: workerPid ?? null,
    });
  }

  const shapeViolations = [];
  const forbiddenSeen = [];
  const unknownSeen = [];
  const namespaceViolations = [];
  const nodeObservations = [];
  const ytdlpIdentities = [];
  const basenamesSeen = new Set();
  let usableSamples = 0;

  samples.forEach((entry, index) => {
    const shape = validateSampleShape(entry?.sample);
    if (!shape.ok) {
      shapeViolations.push(`sample ${index}: ${shape.violations.slice(0, 3).join("; ")}`);
      return;
    }
    usableSamples += 1;

    const classified = classifyAcquisitionTree(entry.sample, workerPid);
    for (const name of classified.basenames) basenamesSeen.add(name);

    // A single appearance is enough to fail. `push` rather than "keep the worst
    // sample" is the whole point: transient observations must survive.
    for (const row of classified.forbidden) {
      forbiddenSeen.push({ sampleIndex: index, pid: row.pid, comm: row.comm });
    }
    for (const row of classified.unknown) {
      unknownSeen.push({ sampleIndex: index, pid: row.pid, comm: row.comm });
    }

    const namespaces = evaluateNamespaceIdentity(classified, expectedNetns);
    if (namespaces.measured && !namespaces.consistent) {
      for (const offender of namespaces.offenders) {
        namespaceViolations.push({ sampleIndex: index, pid: offender.pid, comm: offender.comm });
      }
    } else if (!namespaces.measured) {
      namespaceViolations.push({ sampleIndex: index, pid: null, comm: "<namespace unknown>" });
    }

    const identity = evaluateYtdlpIdentity(entry.sample, workerPid, entry.ytdlpPid, expectedNetns);
    if (identity.identified) {
      ytdlpIdentities.push({ sampleIndex: index, pid: identity.pid, comm: identity.comm });
    }

    // Node containment is evaluated PER SAMPLE, anchored to that sample's own
    // verified owned process. A Node solver that appears for one sample is
    // exercised, and its containment in that sample must hold.
    if (classified.nodeProcesses.length > 0) {
      const containment = evaluateNodeContainment(classified, identity, expectedNetns);
      nodeObservations.push({
        sampleIndex: index,
        count: classified.nodeProcesses.length,
        anchored: containment.anchored === true,
        contained: containment.contained === true,
        failures: containment.failures ?? [containment.reason].filter(Boolean),
      });
    }
  });

  return Object.freeze({
    usable: usableSamples > 0,
    reason: usableSamples > 0 ? null : `no sample passed the closed schema: ${shapeViolations[0] ?? "unknown"}`,
    samplesTaken: samples.length,
    usableSamples,
    shapeViolations: Object.freeze(shapeViolations),
    forbiddenSeen: Object.freeze(forbiddenSeen),
    unknownSeen: Object.freeze(unknownSeen),
    namespaceViolations: Object.freeze(namespaceViolations),
    nodeObservations: Object.freeze(nodeObservations),
    ytdlpIdentities: Object.freeze(ytdlpIdentities),
    basenamesSeen: Object.freeze([...basenamesSeen].sort()),
    expectedNetns,
    workerPid: workerPid ?? null,
  });
}

/**
 * Was the owned yt-dlp process positively identified at least once?
 *
 * Once is enough and once is required: the process legitimately exits before the
 * window closes, but a window in which it was NEVER identifiable cannot support
 * any statement about "the owned process".
 */
export function ytdlpIdentified(aggregate) {
  return Array.isArray(aggregate?.ytdlpIdentities) && aggregate.ytdlpIdentities.length > 0;
}

/** Node appeared in at least one sample => the case is EXERCISED. */
export function nodeExercised(aggregate) {
  return Array.isArray(aggregate?.nodeObservations) && aggregate.nodeObservations.length > 0;
}

/** Every Node observation must be anchored and contained. */
export function nodeContained(aggregate) {
  return (aggregate?.nodeObservations ?? []).every(
    (entry) => entry.anchored === true && entry.contained === true,
  );
}

/**
 * A collector for the producer to drive while polling.
 *
 * `noteState` opens the window on the first observed `downloading` and closes it
 * on the first observed state after it, so samples are admitted only for the
 * interval the durable state actually says `downloading`.
 */
export function createDownloadWindowCollector({ workerPid, expectedNetns } = {}) {
  const samples = [];
  let opened = false;
  let closed = false;
  let observedDownloading = false;
  let worker = workerPid ?? null;
  let netns = expectedNetns ?? null;

  return {
    /** Feed each polled durable status here. */
    noteState(status) {
      if (status === "downloading") {
        if (!closed) {
          opened = true;
          observedDownloading = true;
        }
        return;
      }
      // Any state after the window opened closes it permanently. `processing`
      // is precisely the state whose samples must not reach the acquisition
      // verdict.
      if (opened) closed = true;
    },

    get open() {
      return opened && !closed;
    },

    get observedDownloading() {
      return observedDownloading;
    },

    /**
     * Admits a sample.
     *
     * `takenWhileOpen` exists because sampling is ASYNCHRONOUS: a sample whose
     * capture began inside the window can land after the job has moved to
     * `processing`, and judging admission by the state at LANDING time silently
     * discarded every sample of a fast job. What matters is when the process
     * tree was read, so the caller records that and passes it here.
     */
    addSample(observation, opts = {}) {
      const admissible = opts.takenWhileOpen ?? (opened && !closed);
      if (!admissible || !observation) return false;
      if (!opened) return false;
      worker = observation.workerPid ?? worker;
      netns = observation.expectedNetns ?? netns;
      samples.push({
        sample: observation.sample,
        ytdlpPid: observation.ytdlpPid ?? null,
        at: new Date().toISOString(),
      });
      return true;
    },

    result() {
      return {
        samples,
        workerPid: worker,
        expectedNetns: netns,
        observedDownloading,
        windowClosed: closed,
      };
    },
  };
}
