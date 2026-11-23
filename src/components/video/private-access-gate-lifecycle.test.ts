import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { act, createElement, StrictMode, type ComponentType } from "react";
import type { Root } from "react-dom/client";
import ts from "typescript";
import { ACTIVE_JOB_STORAGE_KEY, writeActiveJob } from "@/lib/active-job-storage";
import { GENERIC_API_ERROR_MESSAGE, NETWORK_API_ERROR_MESSAGE } from "@/lib/client-api";
import { JOB_ID, polledJob } from "@/lib/job-status-poll.fixtures";

/**
 * VIDEOFETCH-LD4B-PRIVATE-ACCESS-LIFECYCLE-CORRECTION-001 — the access gate
 * acts only on the answer of its CURRENT access check.
 *
 * The real `/` page (`Home`: `PrivateAccessGate` around the downloader) is
 * mounted by React 19's own client renderer, in development mode, so every
 * effect, every effect cleanup and StrictMode's development double effect are
 * React's own. What React writes to is a minimal DOM double below — this
 * repository has no DOM library, and none is added. Only `fetch` and the tab's
 * storage are doubles besides: every request is recorded, every storage write
 * is logged, and each access check is HELD until the test answers it, in the
 * order the test chooses. "An answer that arrives after its effect was cleaned
 * up" is therefore reproduced deterministically, never by timing.
 *
 * Each test checks its decisive storage or page assertion first, before it
 * waits for anything, so a broken gate fails on that assertion — not on a
 * timeout.
 */

// Node strips types from .ts but cannot load .tsx; see source-quality-render.test.ts.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

// ----------------------------------------------------------------------------
// The DOM double: what React DOM's client renderer touches, nothing more.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

type EventListenerRecord = { type: string; listener: (event: unknown) => void; capture: boolean };

function isCapture(options: unknown): boolean {
  return options === true || (typeof options === "object" && options !== null && "capture" in options && options.capture === true);
}

class FakeNode {
  nodeType: number;
  nodeName: string;
  ownerDocument: FakeDocument | null;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  listeners: EventListenerRecord[] = [];

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }

  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (before === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(before);
    if (index < 0) throw new Error("DOM double: insertBefore's reference is not a child");
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("DOM double: removeChild's target is not a child");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value) this.appendChild(new FakeText(String(value), this.ownerDocument));
  }

  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void {
    this.listeners.push({ type, listener, capture: isCapture(options) });
  }

  removeEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void {
    const capture = isCapture(options);
    const index = this.listeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener && entry.capture === capture,
    );
    if (index >= 0) this.listeners.splice(index, 1);
  }
}

class FakeText extends FakeNode {
  nodeValue: string;

  constructor(text: string, ownerDocument: FakeDocument | null) {
    super(TEXT_NODE, "#text", ownerDocument);
    this.nodeValue = text;
  }

  get textContent(): string {
    return this.nodeValue;
  }

  set textContent(value: string) {
    this.nodeValue = value;
  }
}

class FakeStyle {
  [property: string]: unknown;

  setProperty(name: string, value: string): void {
    this[name] = value;
  }

  removeProperty(name: string): void {
    delete this[name];
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  namespaceURI: string;
  attributes = new Map<string, string>();
  style = new FakeStyle();

  constructor(tagName: string, namespaceURI: string, ownerDocument: FakeDocument) {
    super(ELEMENT_NODE, tagName, ownerDocument);
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_namespace: string | null, name: string, value: unknown): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  removeAttributeNS(_namespace: string | null, name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  focus(): void {
    // Focus is not modelled: the active element stays the body.
  }

  blur(): void {
    // See focus().
  }
}

class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement | null = null;
  defaultView: object | null = null;

  constructor() {
    super(DOCUMENT_NODE, "#document", null);
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toUpperCase(), HTML_NAMESPACE, this);
  }

  createElementNS(namespaceURI: string, qualifiedName: string): FakeElement {
    return new FakeElement(qualifiedName, namespaceURI, this);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text, this);
  }
}

/** The tab's storage: a Storage that also logs every write, in order. */
class LoggedStorage implements Storage {
  private readonly items = new Map<string, string>();
  readonly writes: string[] = [];

  get length(): number {
    return this.items.size;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push(`set ${key}`);
    this.items.set(key, String(value));
  }

  removeItem(key: string): void {
    this.writes.push(`remove ${key}`);
    this.items.delete(key);
  }

  clear(): void {
    this.writes.push("clear");
    this.items.clear();
  }

  /** Forgets everything, the write log included (between tests only). */
  reset(): void {
    this.items.clear();
    this.writes.length = 0;
  }
}

/** React's focus walk asks whether the active element is an iframe; none ever is. */
class FakeIFrameElement {}

const fakeDocument = new FakeDocument();
const tabSession = new LoggedStorage();
const tabLocal = new LoggedStorage();
const fakeWindow = {
  document: fakeDocument,
  sessionStorage: tabSession,
  localStorage: tabLocal,
  HTMLIFrameElement: FakeIFrameElement,
  event: undefined,
  addEventListener(): void {
    // React DOM probes for passive listener support once; nothing to record.
  },
  removeEventListener(): void {
    // See addEventListener().
  },
};
fakeDocument.defaultView = fakeWindow;
Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, IS_REACT_ACT_ENVIRONMENT: true });
// The page's history and recent-URL helpers use the bare globals.
Object.defineProperty(globalThis, "sessionStorage", { value: tabSession, configurable: true, writable: true });
Object.defineProperty(globalThis, "localStorage", { value: tabLocal, configurable: true, writable: true });

// ----------------------------------------------------------------------------
// The network double: every request recorded; access checks held.

const SESSION_PATH = "/api/access/session";
const LOGOUT_PATH = "/api/access/logout";
const STATUS_PATH = `/api/download/${JOB_ID}/status`;

const AUTHENTICATED = { authenticated: true, configured: true, developmentBypass: false };
const UNAUTHENTICATED = { authenticated: false, configured: true, developmentBypass: false };
const NOT_CONFIGURED = { authenticated: false, configured: false, developmentBypass: false };
const DEVELOPMENT_BYPASS = { authenticated: false, configured: false, developmentBypass: true };

type HeldCheck = { answer: (response: Response) => void; drop: (error: unknown) => void };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const network = {
  requests: [] as string[],
  heldChecks: [] as HeldCheck[],
  logout: () => json(200, { success: true }),

  reset(): void {
    this.requests.length = 0;
    this.heldChecks.length = 0;
    this.logout = () => json(200, { success: true });
  },

  async fetch(input: unknown, init?: { method?: string }): Promise<Response> {
    const path = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    network.requests.push(`${method} ${path}`);
    if (method === "GET" && path === SESSION_PATH) {
      return new Promise<Response>((answer, drop) => network.heldChecks.push({ answer, drop }));
    }
    if (method === "GET" && path === STATUS_PATH) return json(200, polledJob("downloading", { thumbnail: null }));
    if (method === "POST" && path === LOGOUT_PATH) return network.logout();
    throw new Error(`unexpected request: ${method} ${path}`);
  },

  count(request: string): number {
    return this.requests.filter((recorded) => recorded === request).length;
  },
};
globalThis.fetch = network.fetch as typeof fetch;

// ----------------------------------------------------------------------------
// React and the page, imported only now that the DOM double exists.

const { createRoot } = await import("react-dom/client");
const { Route } = await import("../../routes/index.tsx");
const Home = Route.options.component as ComponentType;

const STORED = JSON.stringify({ v: 1, jobId: JOB_ID });
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Lets React, timers and pending answers run, inside act(). */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await pause(ms);
  });
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await settle(5);
  }
}

const mounted = new Set<Root>();

type Page = { container: FakeElement; text: () => string; unmount: () => Promise<void> };

/** A page load: the `/` route mounted in a fresh container of the same tab. */
async function loadPage(options: { strict?: boolean } = {}): Promise<Page> {
  const container = fakeDocument.createElement("div");
  fakeDocument.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  mounted.add(root);
  const page = options.strict ? createElement(StrictMode, null, createElement(Home)) : createElement(Home);
  await act(async () => {
    root.render(page);
  });
  return {
    container,
    text: () => container.textContent,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      mounted.delete(root);
      fakeDocument.body.removeChild(container);
    },
  };
}

/** Answers (or fails) the `index`-th access check of this test, inside act(). */
async function answerCheck(index: number, respond: (check: HeldCheck) => void): Promise<void> {
  const check = network.heldChecks[index];
  assert.ok(check, `access check #${index + 1} was never sent`);
  await act(async () => {
    respond(check);
    await pause(0);
  });
}

const grants = (session: object) => (check: HeldCheck) => check.answer(json(200, session));

function storedJob(): string | null {
  return tabSession.getItem(ACTIVE_JOB_STORAGE_KEY);
}

function rememberJob(): void {
  assert.ok(writeActiveJob(JOB_ID, tabSession), "the test stores a job id");
  tabSession.writes.length = 0;
}

/** The page shows the downloader, and the restored job by its own status. */
const showsRestoredJob = (page: Page) => page.text().includes("Download videos") && page.text().includes("Regression clip");

function findButton(node: FakeNode, label: string): FakeElement | null {
  if (node instanceof FakeElement && node.tagName === "BUTTON" && node.textContent.trim() === label) return node;
  for (const child of node.childNodes) {
    const found = findButton(child, label);
    if (found) return found;
  }
  return null;
}

/** A click as the browser delivers it: to React's listeners on the root container. */
async function click(page: Page, target: FakeElement): Promise<void> {
  const event = {
    type: "click",
    target,
    srcElement: target,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    isTrusted: true,
    timeStamp: Date.now(),
    button: 0,
    buttons: 0,
    detail: 1,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation(): void {
      // React propagates through its own tree.
    },
  };
  await act(async () => {
    for (const capture of [true, false]) {
      for (const entry of page.container.listeners) {
        if (entry.type === "click" && entry.capture === capture) entry.listener(event);
      }
    }
    await pause(0);
  });
}

/** Nothing in any test creates a job, starts one, or cancels one. */
function assertNoJobRequest(): void {
  const jobWrites = network.requests.filter((request) => request.startsWith("POST /api/download"));
  assert.deepEqual(jobWrites, [], "no request may create, start or cancel a job");
}

/** Every request was an access check, a status read of the stored job, or (when allowed) a logout. */
function assertOnlyReads(options: { logout?: boolean } = {}): void {
  const allowed = new Set([`GET ${SESSION_PATH}`, `GET ${STATUS_PATH}`]);
  if (options.logout) allowed.add(`POST ${LOGOUT_PATH}`);
  assert.deepEqual(
    network.requests.filter((request) => !allowed.has(request)),
    [],
    "only access checks and status reads of the stored job are sent",
  );
  assertNoJobRequest();
}

afterEach(async () => {
  for (const root of mounted) {
    await act(async () => {
      root.unmount();
    });
  }
  mounted.clear();
  fakeDocument.body.childNodes.length = 0;
  network.reset();
  tabSession.reset();
  tabLocal.reset();
});

describe("the access gate acts on its current access check", () => {
  it("keeps the stored job when the current check finds private access, and the page finds the job again by reading its status", async () => {
    rememberJob();
    const page = await loadPage();
    assert.equal(network.heldChecks.length, 1, "one access check per page load");
    await answerCheck(0, grants(AUTHENTICATED));
    assert.equal(storedJob(), STORED, "a current check that finds private access keeps the stored job");
    assert.ok(!tabSession.writes.includes(`remove ${ACTIVE_JOB_STORAGE_KEY}`), "and nothing removed it");
    await waitFor(() => showsRestoredJob(page), "the restored job");
    assert.ok(network.count(`GET ${STATUS_PATH}`) >= 1, "the job was found again by a status read");
    assert.ok(findButton(page.container, "Lock"), "an authenticated session can lock");
    assert.equal(storedJob(), STORED);
    assertOnlyReads();
    await page.unmount();
  });

  it("forgets the stored job when the current check confirms that this tab has no private access", async () => {
    for (const [session, shown] of [
      [UNAUTHENTICATED, "Enter the access secret to continue."],
      [NOT_CONFIGURED, "This server is not ready"],
    ] as const) {
      rememberJob();
      const page = await loadPage();
      await answerCheck(0, grants(session));
      assert.equal(storedJob(), null, "a current check without private access forgets the stored job");
      assert.ok(page.text().includes(shown), `the page shows: ${shown}`);
      assert.ok(!page.text().includes("Download videos"), "the downloader is not shown");
      assert.equal(network.count(`GET ${STATUS_PATH}`), 0, "and no status is read");
      assertOnlyReads();
      await page.unmount();
      network.reset();
      tabSession.reset();
    }
  });

  it("keeps the stored job under the development bypass, and restores it with a status read", async () => {
    rememberJob();
    const page = await loadPage();
    await answerCheck(0, grants(DEVELOPMENT_BYPASS));
    assert.equal(storedJob(), STORED, "the development bypass keeps the stored job");
    await waitFor(() => showsRestoredJob(page), "the restored job");
    assert.equal(findButton(page.container, "Lock"), null, "a bypass has no session to lock");
    assertOnlyReads();
    await page.unmount();
  });
});

describe("an access check whose effect was cleaned up changes nothing", () => {
  it("leaves the stored job untouched when the check answers 'no access' after its page was unmounted", async () => {
    rememberJob();
    const page = await loadPage();
    assert.equal(network.heldChecks.length, 1);
    await page.unmount();
    const writesBefore = tabSession.writes.length;
    await answerCheck(0, grants(UNAUTHENTICATED));
    await settle(20);
    assert.equal(storedJob(), STORED, "a cleaned-up access check must not change the stored job");
    assert.deepEqual(tabSession.writes.slice(writesBefore), [], "a cleaned-up access check writes nothing to storage");
    assert.equal(network.requests.length, 1, "and nothing else is sent");
  });

  it("does not let a superseded check's late answer change the page (StrictMode's development double effect)", async () => {
    rememberJob();
    const page = await loadPage({ strict: true });
    assert.equal(network.heldChecks.length, 2, "React ran the gate's effect twice; the first was cleaned up");
    // The superseded check answers first, granting access: nothing may change.
    await answerCheck(0, grants(AUTHENTICATED));
    await settle(20);
    assert.equal(page.text(), "", "an access check that is no longer current must not change the page");
    assert.equal(findButton(page.container, "Lock"), null);
    assert.equal(network.count(`GET ${STATUS_PATH}`), 0, "no status is read on a superseded answer");
    // The current check finds no access: the gate shows the lock and forgets the job.
    await answerCheck(1, grants(UNAUTHENTICATED));
    assert.equal(storedJob(), null, "the current check's answer is the one that counts");
    assert.ok(page.text().includes("Enter the access secret to continue."));
    assertOnlyReads();
    await page.unmount();
  });

  it("does not let a superseded check's late failure replace the current answer", async () => {
    rememberJob();
    const page = await loadPage({ strict: true });
    assert.equal(network.heldChecks.length, 2);
    await answerCheck(0, (check) => check.drop(new TypeError("Failed to fetch")));
    await settle(20);
    assert.equal(page.text(), "", "a superseded access check's failure must not change the page");
    await answerCheck(1, grants(AUTHENTICATED));
    assert.equal(storedJob(), STORED);
    await waitFor(() => showsRestoredJob(page), "the restored job");
    assertOnlyReads();
    await page.unmount();
  });

  it("a superseded 'no access' answer arriving FIRST cannot erase the job the current check keeps; the job is restored by GET only", async () => {
    rememberJob();
    const page = await loadPage({ strict: true });
    assert.equal(network.heldChecks.length, 2);
    await answerCheck(0, grants(UNAUTHENTICATED));
    await settle(20);
    assert.equal(storedJob(), STORED, "a superseded access check must not erase the stored job");
    assert.deepEqual(tabSession.writes, [], "a superseded access check writes nothing to storage");
    await answerCheck(1, grants(AUTHENTICATED));
    await waitFor(() => showsRestoredJob(page), "the restored job");
    assert.ok(network.count(`GET ${STATUS_PATH}`) >= 1, "the job was found again by a status read");
    assert.equal(storedJob(), STORED);
    assertOnlyReads();
    await page.unmount();
  });

  it("a superseded 'no access' answer arriving LAST cannot erase the job either; a reload still finds it, by GET only", async () => {
    rememberJob();
    const page = await loadPage({ strict: true });
    assert.equal(network.heldChecks.length, 2);
    await answerCheck(1, grants(AUTHENTICATED));
    await waitFor(() => showsRestoredJob(page), "the restored job");
    const writesBefore = tabSession.writes.length;
    await answerCheck(0, grants(UNAUTHENTICATED));
    await settle(20);
    assert.equal(storedJob(), STORED, "a superseded access check must not erase the stored job");
    assert.deepEqual(tabSession.writes.slice(writesBefore), [], "a superseded access check writes nothing to storage");
    assert.ok(showsRestoredJob(page), "the page still shows the job");
    await page.unmount();

    // A reload of the same tab: one access check, granted; the same job, read again.
    const statusReadsBefore = network.count(`GET ${STATUS_PATH}`);
    const reloaded = await loadPage();
    assert.equal(network.heldChecks.length, 3);
    await answerCheck(2, grants(AUTHENTICATED));
    await waitFor(() => showsRestoredJob(reloaded), "the job after the reload");
    assert.ok(network.count(`GET ${STATUS_PATH}`) > statusReadsBefore, "the reload read the job's status again");
    assert.equal(storedJob(), STORED);
    assertOnlyReads();
    await reloaded.unmount();
  });
});

describe("Lock, and a failed access check", () => {
  it("Lock forgets the stored job once the server confirms the lock", async () => {
    rememberJob();
    const page = await loadPage();
    await answerCheck(0, grants(AUTHENTICATED));
    await waitFor(() => showsRestoredJob(page), "the restored job");
    const lock = findButton(page.container, "Lock");
    assert.ok(lock, "the Lock button");
    await click(page, lock);
    assert.equal(network.count(`POST ${LOGOUT_PATH}`), 1, "Lock asks the server to end the session");
    assert.equal(network.heldChecks.length, 2, "and then reads the session again");
    await answerCheck(1, grants(UNAUTHENTICATED));
    assert.equal(storedJob(), null, "a confirmed lock forgets the stored job");
    assert.ok(page.text().includes("Enter the access secret to continue."));
    assertOnlyReads({ logout: true });
    await page.unmount();
  });

  it("a Lock the server refuses keeps the stored job and the session", async () => {
    rememberJob();
    const page = await loadPage();
    await answerCheck(0, grants(AUTHENTICATED));
    await waitFor(() => showsRestoredJob(page), "the restored job");
    network.logout = () => json(500, { success: false, error: { code: "PROCESSING_FAILED", message: "x" } });
    const lock = findButton(page.container, "Lock");
    assert.ok(lock);
    await click(page, lock);
    await settle(20);
    assert.equal(network.count(`POST ${LOGOUT_PATH}`), 1);
    assert.equal(network.heldChecks.length, 1, "a refused lock reads no session");
    assert.equal(storedJob(), STORED, "a refused lock keeps the stored job");
    assert.ok(showsRestoredJob(page), "and the page");
    assertOnlyReads({ logout: true });
    await page.unmount();
  });

  it("a failed access check fabricates no answer: the job is kept, the failure is shown, nothing retries by itself, and a reload recovers", async () => {
    for (const [fail, message] of [
      [(check: HeldCheck) => check.drop(new TypeError("Failed to fetch")), NETWORK_API_ERROR_MESSAGE],
      [(check: HeldCheck) => check.answer(new Response("<html>bad gateway</html>", { status: 502 })), GENERIC_API_ERROR_MESSAGE],
    ] as const) {
      rememberJob();
      const page = await loadPage();
      await answerCheck(0, fail);
      assert.equal(storedJob(), STORED, "a failed access check must not erase the stored job");
      assert.deepEqual(tabSession.writes, [], "a failed access check writes nothing to storage");
      assert.ok(page.text().includes(message), `the failure is shown: ${message}`);
      assert.ok(!page.text().includes("Enter the access secret to continue."), "no 'no access' answer is made up");
      assert.ok(!page.text().includes("Download videos"), "and the downloader is not shown");
      await settle(50);
      assert.equal(network.heldChecks.length, 1, "a failed access check is not retried by itself");
      await page.unmount();

      const reloaded = await loadPage();
      assert.equal(network.heldChecks.length, 2, "a reload checks access again, once");
      await answerCheck(1, grants(AUTHENTICATED));
      await waitFor(() => showsRestoredJob(reloaded), "the job after the reload");
      assertOnlyReads();
      await reloaded.unmount();
      network.reset();
      tabSession.reset();
    }
  });
});
