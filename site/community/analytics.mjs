import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ANALYTICS_FILENAME = 'analytics.ndjson';
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_DAYS = 180;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const analyticsEvents = Object.freeze([
  'page_view',
  'download_portable',
  'download_macos',
  'download_windows',
  'download_linux',
  'download_chromium',
  'download_firefox',
  'github_open',
  'support_open',
  'feedback_open',
  'feedback_submit',
  'poll_vote',
]);

export const analyticsSources = Object.freeze([
  'direct',
  'search',
  'github',
  'reddit',
  'hackernews',
  'producthunt',
  'social',
  'newsletter',
  'other',
]);

const eventSet = new Set(analyticsEvents);
const sourceSet = new Set(analyticsSources);

export class AnalyticsError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = 'AnalyticsError';
    this.code = code;
    this.status = status;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateAnalyticsEvent(value) {
  if (!plainObject(value)) throw new AnalyticsError('invalid_event', 'Analytics event is invalid.', 400);
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'event' || keys[1] !== 'source') {
    throw new AnalyticsError('invalid_event', 'Analytics event contains unsupported fields.', 400);
  }
  if (!eventSet.has(value.event) || !sourceSet.has(value.source)) {
    throw new AnalyticsError('invalid_event', 'Analytics event is not allowlisted.', 400);
  }
  return { event: value.event, source: value.source };
}

function validateRecord(value) {
  if (!plainObject(value) || !DATE_PATTERN.test(value.date)) {
    throw new AnalyticsError('corrupt_analytics', 'Analytics data is invalid.');
  }
  const checked = validateAnalyticsEvent({ event: value.event, source: value.source });
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'date' || keys[1] !== 'event' || keys[2] !== 'source') {
    throw new AnalyticsError('corrupt_analytics', 'Analytics data contains unsupported fields.');
  }
  return { date: value.date, ...checked };
}

function utcDate(now) {
  return now.toISOString().slice(0, 10);
}

function cutoffDate(now, days) {
  return new Date(now.getTime() - ((days - 1) * DAY_MS)).toISOString().slice(0, 10);
}

function parseDays(value) {
  const days = Number(value ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new AnalyticsError('invalid_days', `days must be between 1 and ${RETENTION_DAYS}.`, 400);
  }
  return days;
}

export class AnalyticsStore {
  #dataDir;
  #filename;
  #now;
  #queue = Promise.resolve();

  constructor({ dataDir, now = () => new Date() }) {
    this.#dataDir = path.resolve(dataDir);
    this.#filename = path.join(this.#dataDir, ANALYTICS_FILENAME);
    this.#now = now;
  }

  async init() {
    await mkdir(this.#dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.#dataDir, 0o700);
    try {
      const info = await lstat(this.#filename);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
        throw new AnalyticsError('unsafe_analytics', 'Analytics storage is unsafe or too large.');
      }
      await chmod(this.#filename, 0o600);
      await this.#readRecords();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await writeFile(this.#filename, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    await this.cleanup();
  }

  record(value) {
    const checked = validateAnalyticsEvent(value);
    return this.#serialize(async () => {
      const record = { date: utcDate(this.#now()), ...checked };
      await appendFile(this.#filename, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
      await chmod(this.#filename, 0o600);
      return record;
    });
  }

  report(daysInput = 30) {
    const days = parseDays(daysInput);
    return this.#serialize(async () => {
      const now = this.#now();
      const from = cutoffDate(now, days);
      const through = utcDate(now);
      const totals = Object.fromEntries(analyticsEvents.map((event) => [event, 0]));
      const sources = Object.fromEntries(analyticsSources.map((source) => [source, 0]));
      const dailyMap = new Map();
      for (let cursor = Date.parse(`${from}T00:00:00.000Z`); cursor <= Date.parse(`${through}T00:00:00.000Z`); cursor += DAY_MS) {
        dailyMap.set(new Date(cursor).toISOString().slice(0, 10), Object.fromEntries(analyticsEvents.map((event) => [event, 0])));
      }

      for (const record of await this.#readRecords()) {
        if (record.date < from || record.date > through) continue;
        totals[record.event] += 1;
        sources[record.source] += 1;
        const day = dailyMap.get(record.date) ?? Object.fromEntries(analyticsEvents.map((event) => [event, 0]));
        day[record.event] += 1;
        dailyMap.set(record.date, day);
      }

      return {
        generatedAt: now.toISOString(),
        days,
        from,
        through,
        totals,
        sources,
        daily: [...dailyMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, events]) => ({ date, ...events })),
      };
    });
  }

  cleanup() {
    return this.#serialize(async () => {
      const keepFrom = cutoffDate(this.#now(), RETENTION_DAYS);
      const records = (await this.#readRecords()).filter((record) => record.date >= keepFrom);
      const temporary = path.join(this.#dataDir, `.analytics.${process.pid}.${randomUUID()}.tmp`);
      const body = records.map((record) => JSON.stringify(record)).join('\n');
      try {
        await writeFile(temporary, body ? `${body}\n` : '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await rename(temporary, this.#filename);
        await chmod(this.#filename, 0o600);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      return records.length;
    });
  }

  async #readRecords() {
    const info = await lstat(this.#filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
      throw new AnalyticsError('unsafe_analytics', 'Analytics storage is unsafe or too large.');
    }
    const body = await readFile(this.#filename, 'utf8');
    if (!body) return [];
    return body.split('\n').filter(Boolean).map((line) => {
      try {
        return validateRecord(JSON.parse(line));
      } catch (error) {
        if (error instanceof AnalyticsError) throw error;
        throw new AnalyticsError('corrupt_analytics', 'Analytics data is invalid.');
      }
    });
  }

  #serialize(work) {
    const result = this.#queue.then(work, work);
    this.#queue = result.catch(() => {});
    return result;
  }
}

export const analyticsRetentionDays = RETENTION_DAYS;
