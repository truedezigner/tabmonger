import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalTitle, validatePublicTitle, validateSubmission } from './moderation.mjs';

const SCHEMA_VERSION = 1;
const STORE_FILENAME = 'community.json';
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_SUBMISSIONS = 5_000;
const MAX_POLL_ITEMS = 500;
const MAX_ACTIVE_POLL_ITEMS = 50;
const MAX_VOTES = 100_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const PENDING_RETENTION_MS = 180 * DAY_MS;
const DECIDED_RETENTION_MS = 30 * DAY_MS;
const ARCHIVED_POLL_RETENTION_MS = 30 * DAY_MS;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const TEMP_STORE_FILE = /^\.community\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;

export class StoreError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.status = status;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertState(state) {
  if (!isObject(state) || state.schemaVersion !== SCHEMA_VERSION) {
    throw new StoreError('corrupt_store', 'Unsupported or corrupt community store.');
  }
  if (!validTimestamp(state.createdAt) || !validTimestamp(state.updatedAt)) {
    throw new StoreError('corrupt_store', 'Community store timestamps are invalid.');
  }
  if (
    !Array.isArray(state.submissions)
    || !Array.isArray(state.pollItems)
    || !isObject(state.votes)
    || state.submissions.length > MAX_SUBMISSIONS
    || state.pollItems.length > MAX_POLL_ITEMS
    || Object.keys(state.votes).length > MAX_VOTES
  ) {
    throw new StoreError('corrupt_store', 'Community store collections are invalid.');
  }

  const submissionIds = new Set();
  for (const submission of state.submissions) {
    if (
      !isObject(submission)
      || !UUID_V4.test(submission.id)
      || submissionIds.has(submission.id)
      || (submission.kind !== 'feature' && submission.kind !== 'feedback')
      || typeof submission.title !== 'string'
      || typeof submission.details !== 'string'
      || Object.hasOwn(submission, 'sourceHash')
      || !['pending', 'approved', 'rejected', 'reviewed'].includes(submission.status)
      || !validTimestamp(submission.submittedAt)
    ) {
      throw new StoreError('corrupt_store', 'Community submission data is invalid.');
    }
    if (submission.kind === 'feedback' && submission.status === 'approved') {
      throw new StoreError('corrupt_store', 'Feedback cannot be approved for the public poll.');
    }
    if (submission.status === 'reviewed' && submission.kind !== 'feedback') {
      throw new StoreError('corrupt_store', 'Only feedback can be marked reviewed.');
    }
    if (
      (submission.status === 'approved' || submission.status === 'rejected')
      && !validTimestamp(submission.decidedAt)
    ) {
      throw new StoreError('corrupt_store', 'Community decision timestamp is missing.');
    }
    if (submission.status === 'reviewed' && !validTimestamp(submission.reviewedAt)) {
      throw new StoreError('corrupt_store', 'Community review timestamp is missing.');
    }
    if (submission.decidedAt !== undefined && !validTimestamp(submission.decidedAt)) {
      throw new StoreError('corrupt_store', 'Community decision timestamp is invalid.');
    }
    if (submission.reviewedAt !== undefined && !validTimestamp(submission.reviewedAt)) {
      throw new StoreError('corrupt_store', 'Community review timestamp is invalid.');
    }
    try {
      const checked = validateSubmission({
        kind: submission.kind,
        title: submission.title,
        details: submission.details,
        website: '',
      });
      if (checked.title !== submission.title || checked.details !== submission.details) throw new Error('not canonical');
    } catch {
      throw new StoreError('corrupt_store', 'Community submission text is invalid.');
    }
    submissionIds.add(submission.id);
  }

  const pollIds = new Set();
  for (const item of state.pollItems) {
    if (
      !isObject(item)
      || !UUID_V4.test(item.id)
      || pollIds.has(item.id)
      || !UUID_V4.test(item.sourceSubmissionId)
      || typeof item.title !== 'string'
      || typeof item.active !== 'boolean'
      || !validTimestamp(item.createdAt)
      || !validTimestamp(item.updatedAt)
    ) {
      throw new StoreError('corrupt_store', 'Community poll data is invalid.');
    }
    if ((item.active && item.closedAt !== undefined) || (!item.active && !validTimestamp(item.closedAt))) {
      throw new StoreError('corrupt_store', 'Community poll lifecycle data is invalid.');
    }
    try {
      if (validatePublicTitle(item.title) !== item.title) throw new Error('not canonical');
    } catch {
      throw new StoreError('corrupt_store', 'Community poll title is invalid.');
    }
    pollIds.add(item.id);
  }

  for (const [voterHash, vote] of Object.entries(state.votes)) {
    if (
      !HASH.test(voterHash)
      || !isObject(vote)
      || !pollIds.has(vote.featureId)
      || !validTimestamp(vote.updatedAt)
    ) {
      throw new StoreError('corrupt_store', 'Community vote data is invalid.');
    }
  }
}

function initialState(now) {
  const timestamp = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    submissions: [],
    pollItems: [],
    votes: {},
  };
}

function pruneState(state, now) {
  const nowMs = now.getTime();
  const originalSubmissionCount = state.submissions.length;
  const originalPollItemCount = state.pollItems.length;
  const originalVoteCount = Object.keys(state.votes).length;

  state.submissions = state.submissions.filter((submission) => {
    if (submission.status === 'pending') {
      return nowMs - Date.parse(submission.submittedAt) < PENDING_RETENTION_MS;
    }
    if (submission.status === 'rejected' || submission.status === 'approved') {
      return nowMs - Date.parse(submission.decidedAt) < DECIDED_RETENTION_MS;
    }
    if (submission.status === 'reviewed' && submission.kind === 'feedback') {
      return nowMs - Date.parse(submission.reviewedAt) < DECIDED_RETENTION_MS;
    }
    return true;
  });

  state.pollItems = state.pollItems.filter((item) => (
    item.active || nowMs - Date.parse(item.closedAt) < ARCHIVED_POLL_RETENTION_MS
  ));

  const activePollIds = new Set(
    state.pollItems.filter((item) => item.active).map((item) => item.id),
  );
  for (const [voterHash, vote] of Object.entries(state.votes)) {
    if (!activePollIds.has(vote.featureId)) {
      delete state.votes[voterHash];
    }
  }

  return (
    state.submissions.length !== originalSubmissionCount
    || state.pollItems.length !== originalPollItemCount
    || Object.keys(state.votes).length !== originalVoteCount
  );
}

async function syncDirectory(directory) {
  const directoryHandle = await open(directory, fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function removeStaleTemporaryFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let removed = false;
  for (const entry of entries) {
    if (!TEMP_STORE_FILE.test(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    const info = await lstat(candidate);
    if (!entry.isFile() || !info.isFile() || info.isSymbolicLink()) {
      throw new StoreError('unsafe_temporary_store', 'Community storage contains an unsafe temporary file.');
    }
    await unlink(candidate);
    removed = true;
  }
  if (removed) await syncDirectory(directory);
}

async function atomicWrite(directory, filename, state, directorySync = syncDirectory) {
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  let handle;
  let renamed = false;

  try {
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    renamed = true;
    await directorySync(directory);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(temporary).catch(() => {});
    const storeError = new StoreError(
      renamed ? 'storage_state_uncertain' : 'storage_unavailable',
      'Community storage is temporarily unavailable.',
      503,
    );
    storeError.fatal = true;
    throw storeError;
  }
}

export class CommunityStore {
  #directory;
  #filename;
  #now;
  #state;
  #queue = Promise.resolve();
  #initialized = false;
  #fatalError;
  #directorySync;
  #onFatalError;

  constructor({
    dataDir,
    now = () => new Date(),
    directorySync = syncDirectory,
    onFatalError = () => {},
  }) {
    if (typeof dataDir !== 'string' || dataDir.length === 0) {
      throw new StoreError('invalid_config', 'COMMUNITY_DATA_DIR is required.');
    }
    this.#directory = path.resolve(dataDir);
    this.#filename = STORE_FILENAME;
    this.#now = now;
    this.#directorySync = directorySync;
    this.#onFatalError = onFatalError;
  }

  get dataFile() {
    return path.join(this.#directory, this.#filename);
  }

  async init() {
    if (this.#initialized) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await chmod(this.#directory, 0o700);
    await removeStaleTemporaryFiles(this.#directory);

    try {
      const info = await lstat(this.dataFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STORE_BYTES) {
        throw new StoreError('corrupt_store', 'Community store is not a safe regular file.');
      }
      const payload = await readFile(this.dataFile, 'utf8');
      try {
        this.#state = JSON.parse(payload);
      } catch {
        throw new StoreError('corrupt_store', 'Community store contains invalid JSON.');
      }
      assertState(this.#state);
      await chmod(this.dataFile, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      this.#state = initialState(this.#now());
      await atomicWrite(this.#directory, this.#filename, this.#state, this.#directorySync);
    }

    this.#initialized = true;
    await this.cleanup();
  }

  #enqueue(operation) {
    const task = this.#queue.then(operation);
    this.#queue = task.catch(() => {});
    return task;
  }

  #assertReady() {
    if (!this.#initialized) {
      throw new StoreError('not_initialized', 'Community store has not been initialized.');
    }
    if (this.#fatalError) {
      throw new StoreError('storage_unavailable', 'Community storage is temporarily unavailable.', 503);
    }
  }

  async #persist(draft) {
    try {
      await atomicWrite(this.#directory, this.#filename, draft, this.#directorySync);
    } catch (error) {
      if (!this.#fatalError) {
        this.#fatalError = error;
        try {
          this.#onFatalError(error);
        } catch {
          // The store remains fail-stopped even if an operational callback fails.
        }
      }
      throw error;
    }
  }

  #read(selector) {
    this.#assertReady();
    return this.#enqueue(() => {
      this.#assertReady();
      return structuredClone(selector(this.#state));
    });
  }

  #mutate(mutator) {
    this.#assertReady();
    return this.#enqueue(async () => {
      this.#assertReady();
      const draft = structuredClone(this.#state);
      pruneState(draft, this.#now());
      const result = mutator(draft);
      draft.updatedAt = this.#now().toISOString();
      assertState(draft);
      await this.#persist(draft);
      this.#state = draft;
      return structuredClone(result);
    });
  }

  cleanup() {
    this.#assertReady();
    return this.#enqueue(async () => {
      this.#assertReady();
      const draft = structuredClone(this.#state);
      if (!pruneState(draft, this.#now())) return false;
      draft.updatedAt = this.#now().toISOString();
      assertState(draft);
      await this.#persist(draft);
      this.#state = draft;
      return true;
    });
  }

  addSubmission({ kind, title, details, sourceHash }) {
    return this.#mutate((state) => {
      if (state.submissions.length >= MAX_SUBMISSIONS) {
        throw new StoreError('capacity', 'The submission queue is temporarily full.', 503);
      }
      if (!HASH.test(sourceHash)) {
        throw new StoreError('invalid_source', 'The submission source is invalid.', 500);
      }

      const submittedAt = this.#now().toISOString();
      const submission = {
        id: randomUUID(),
        kind,
        title,
        details,
        status: 'pending',
        submittedAt,
      };
      state.submissions.push(submission);
      return submission;
    });
  }

  listSubmissions({ status, kind, limit = 200 } = {}) {
    return this.#read((state) => state.submissions
      .filter((submission) => !status || submission.status === status)
      .filter((submission) => !kind || submission.kind === kind)
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
      .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 1_000))
      .map((submission) => ({
        id: submission.id,
        kind: submission.kind,
        title: submission.title,
        status: submission.status,
        submittedAt: submission.submittedAt,
      })));
  }

  getSubmission(id) {
    return this.#read((state) => state.submissions.find((submission) => submission.id === id) ?? null);
  }

  approve(id, publicTitle) {
    return this.#mutate((state) => {
      let checkedTitle;
      try {
        checkedTitle = validatePublicTitle(publicTitle);
      } catch {
        throw new StoreError('invalid_title', 'The public poll title is invalid.', 400);
      }
      const submission = state.submissions.find((entry) => entry.id === id);
      if (!submission) throw new StoreError('not_found', 'Submission not found.', 404);
      if (submission.kind !== 'feature') {
        throw new StoreError('wrong_kind', 'Only feature requests can become poll items.', 409);
      }
      if (submission.status !== 'pending') {
        throw new StoreError('wrong_status', 'Only pending feature requests can be approved.', 409);
      }
      if (
        state.pollItems.length >= MAX_POLL_ITEMS
        || state.pollItems.filter((item) => item.active).length >= MAX_ACTIVE_POLL_ITEMS
      ) {
        throw new StoreError('capacity', 'The poll is full.', 503);
      }

      const duplicate = state.pollItems.find(
        (item) => item.active && canonicalTitle(item.title) === canonicalTitle(checkedTitle),
      );
      if (duplicate) {
        throw new StoreError('duplicate_title', 'An active poll item already uses that title.', 409);
      }

      const timestamp = this.#now().toISOString();
      const item = {
        id: randomUUID(),
        sourceSubmissionId: submission.id,
        title: checkedTitle,
        active: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.pollItems.push(item);
      submission.status = 'approved';
      submission.decidedAt = timestamp;
      return item;
    });
  }

  reject(id) {
    return this.#mutate((state) => {
      const submission = state.submissions.find((entry) => entry.id === id);
      if (!submission) throw new StoreError('not_found', 'Submission not found.', 404);
      if (submission.status !== 'pending') {
        throw new StoreError('wrong_status', 'Only pending submissions can be rejected.', 409);
      }
      submission.status = 'rejected';
      submission.decidedAt = this.#now().toISOString();
      return submission;
    });
  }

  markReviewed(id) {
    return this.#mutate((state) => {
      const submission = state.submissions.find((entry) => entry.id === id);
      if (!submission) throw new StoreError('not_found', 'Submission not found.', 404);
      if (submission.kind !== 'feedback') {
        throw new StoreError('wrong_kind', 'Only general feedback can be marked reviewed.', 409);
      }
      if (submission.status !== 'pending') {
        throw new StoreError('wrong_status', 'Only pending feedback can be marked reviewed.', 409);
      }
      submission.status = 'reviewed';
      submission.reviewedAt = this.#now().toISOString();
      return submission;
    });
  }

  recordVote(voterHash, featureId) {
    return this.#mutate((state) => {
      if (!HASH.test(voterHash)) {
        throw new StoreError('invalid_voter', 'The voter identifier is invalid.', 400);
      }
      const item = state.pollItems.find((entry) => entry.id === featureId && entry.active);
      if (!item) throw new StoreError('not_found', 'Poll item not found.', 404);
      if (!Object.hasOwn(state.votes, voterHash) && Object.keys(state.votes).length >= MAX_VOTES) {
        throw new StoreError('capacity', 'The poll is temporarily at capacity.', 503);
      }
      state.votes[voterHash] = {
        featureId: item.id,
        updatedAt: this.#now().toISOString(),
      };
      return { featureId: item.id };
    });
  }

  closePollItem(id) {
    return this.#mutate((state) => {
      const item = state.pollItems.find((entry) => entry.id === id);
      if (!item) throw new StoreError('not_found', 'Poll item not found.', 404);
      if (!item.active) throw new StoreError('wrong_status', 'Poll item is already closed.', 409);
      const timestamp = this.#now().toISOString();
      item.active = false;
      item.closedAt = timestamp;
      item.updatedAt = timestamp;
      for (const [voterHash, vote] of Object.entries(state.votes)) {
        if (vote.featureId === item.id) delete state.votes[voterHash];
      }
      return item;
    });
  }

  listPollItems({ includeArchived = false } = {}) {
    return this.#read((state) => {
      const counts = new Map(state.pollItems.map((item) => [item.id, 0]));
      for (const vote of Object.values(state.votes)) {
        counts.set(vote.featureId, (counts.get(vote.featureId) ?? 0) + 1);
      }
      return state.pollItems
        .filter((item) => includeArchived || item.active)
        .map((item) => ({
          id: item.id,
          title: item.title,
          active: item.active,
          votes: counts.get(item.id) ?? 0,
          createdAt: item.createdAt,
          ...(item.closedAt === undefined ? {} : { closedAt: item.closedAt }),
        }))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
  }

  getPublicPoll() {
    return this.#read((state) => {
      const counts = new Map(state.pollItems.map((item) => [item.id, 0]));
      for (const vote of Object.values(state.votes)) {
        counts.set(vote.featureId, (counts.get(vote.featureId) ?? 0) + 1);
      }
      const pollActivity = [
        state.createdAt,
        ...state.pollItems.map((item) => item.updatedAt),
        ...Object.values(state.votes)
          .filter((vote) => counts.has(vote.featureId))
          .map((vote) => vote.updatedAt),
      ].sort().at(-1);
      return {
        updatedAt: pollActivity,
        items: state.pollItems
          .filter((item) => item.active)
          .map((item) => ({ id: item.id, title: item.title, votes: counts.get(item.id) ?? 0 }))
          .sort((left, right) => (
            right.votes - left.votes
            || left.title.localeCompare(right.title, 'en-US')
            || left.id.localeCompare(right.id)
          )),
      };
    });
  }

  stats() {
    return this.#read((state) => ({
      submissions: state.submissions.length,
      activePollItems: state.pollItems.filter((item) => item.active).length,
      votes: Object.keys(state.votes).length,
    }));
  }
}

export const retention = Object.freeze({
  pendingDays: PENDING_RETENTION_MS / DAY_MS,
  decidedDays: DECIDED_RETENTION_MS / DAY_MS,
  archivedPollDays: ARCHIVED_POLL_RETENTION_MS / DAY_MS,
});
