import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sendAdminCommand } from '../admin.mjs';
import { InputError, validateSubmission } from '../moderation.mjs';
import { createCommunityService } from '../server.mjs';
import { CommunityStore } from '../store.mjs';

const ORIGIN = 'https://tabmonger.test';
const TEST_SALT = 'test-only-community-hash-salt-32-bytes-minimum';

async function temporaryRoot() {
  return fsMkdtemp(path.join(os.tmpdir(), 'tabmonger-community-test-'));
}

async function fsMkdtemp(prefix) {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(prefix);
}

async function fixture(options = {}) {
  const root = await temporaryRoot();
  const dataDir = path.join(root, 'data');
  const staticRoot = path.join(root, 'dist');
  await mkdir(path.join(staticRoot, '_astro'), { recursive: true });
  await mkdir(path.join(staticRoot, 'docs'), { recursive: true });
  await writeFile(path.join(staticRoot, 'index.html'), '<!doctype html><title>TabMonger test</title>', 'utf8');
  await writeFile(path.join(staticRoot, 'docs', 'index.html'), '<!doctype html><p>Docs</p>', 'utf8');
  await writeFile(path.join(staticRoot, '_astro', 'app.123.js'), 'globalThis.testAsset = true;\n', 'utf8');
  await writeFile(path.join(staticRoot, '.env'), 'must-not-serve=true\n', 'utf8');

  const serviceOptions = {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    staticRoot,
    adminSocketPath: path.join(dataDir, 'admin.sock'),
    allowedOrigins: [ORIGIN],
    salt: TEST_SALT,
    cleanupIntervalMs: 0,
    trustProxy: true,
    ...options,
  };
  const service = await createCommunityService(serviceOptions);
  await service.listen();
  const address = service.address();

  return {
    root,
    dataDir,
    staticRoot,
    service,
    serviceOptions,
    baseUrl: `http://127.0.0.1:${address.port}`,
    async restart() {
      await this.service.close();
      this.service = await createCommunityService(serviceOptions);
      await this.service.listen();
      const nextAddress = this.service.address();
      this.baseUrl = `http://127.0.0.1:${nextAddress.port}`;
    },
    async close() {
      await this.service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function post(app, pathname, body, options = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Origin: options.origin ?? ORIGIN,
    'Sec-Fetch-Site': options.fetchSite ?? 'same-origin',
    'CF-Connecting-IP': options.ip ?? '203.0.113.42',
    ...(options.headers ?? {}),
  };
  if (options.noOrigin) delete headers.Origin;
  if (options.noFetchSite) delete headers['Sec-Fetch-Site'];
  return fetch(`${app.baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function submit(app, values = {}, requestOptions = {}) {
  return post(app, '/api/community/submissions', {
    kind: 'feature',
    title: 'Add keyboard shortcuts',
    details: 'A focused shortcut menu would make navigation faster.',
    website: '',
    ...values,
  }, requestOptions);
}

async function poll(app) {
  const response = await fetch(`${app.baseUrl}/api/community/poll`, {
    headers: { 'CF-Connecting-IP': '203.0.113.42' },
  });
  assert.equal(response.status, 200);
  return response.json();
}

function rawRequest(baseUrl, requestPath, { method = 'GET', headers = {}, body } = {}) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: base.hostname,
      port: base.port,
      method,
      path: requestPath,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test('submission moderation normalizes safe text and rejects abuse, spam, markup, URLs, and hidden controls', () => {
  const accepted = validateSubmission({
    kind: 'feature',
    title: 'Ｆａｓｔｅｒ search',
    details: 'Please add a compact search history.',
    website: '',
  });
  assert.deepEqual(accepted, {
    honeypot: false,
    kind: 'feature',
    title: 'Faster search',
    details: 'Please add a compact search history.',
  });

  const rejected = [
    { title: '<b>Bad markup</b>', details: 'A normal explanation here.' },
    { title: 'Visit bad.example.com', details: 'A normal explanation here.' },
    { title: 'Normal request', details: '[click here](https://bad.example)' },
    { title: 'Normal request', details: 'k i l l yourself now' },
    { title: 'Normal request', details: 'f.u.c.k this project' },
    { title: 'Normal request', details: 'fuckyou this project' },
    { title: 'Normal request', details: 'fуck this project' },
    { title: 'Normal request', details: 'nіgger content' },
    { title: 'Normal request', details: 'Buy followers and traffic today' },
    { title: 'Normal\u202erequest', details: 'A normal explanation here.' },
    { title: 'Normal request', details: 'AAAAAAAAAAAAAAAAAAAAAAAA' },
  ];
  for (const example of rejected) {
    assert.throws(
      () => validateSubmission({ kind: 'feedback', website: '', ...example }),
      InputError,
    );
  }

  assert.throws(() => validateSubmission({
    kind: 'feedback',
    title: 'Normal title',
    details: 'x'.repeat(1_201),
    website: '',
  }), InputError);
  assert.deepEqual(validateSubmission({ website: 'bot-filled-this' }), { honeypot: true });
});

test('pending and feedback content stay private; approval copies only an owner-approved title', async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  let response = await submit(app, {
    title: 'Original private feature wording',
    details: 'FEATURE-DETAIL-PRIVATE should never appear in the public poll.',
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });
  response = await submit(app, {
    kind: 'feedback',
    title: 'Private general feedback',
    details: 'GENERAL-FEEDBACK-PRIVATE must never be published.',
  });
  assert.equal(response.status, 202);

  const emptyPoll = await poll(app);
  assert.deepEqual(emptyPoll.items, []);
  assert.match(emptyPoll.updatedAt, /^2026-|^20\d\d-/);
  const pending = await sendAdminCommand(app.service.adminSocketPath, {
    command: 'list',
    status: 'pending',
  });
  assert.equal(pending.length, 2);
  const feature = pending.find((item) => item.kind === 'feature');
  const feedback = pending.find((item) => item.kind === 'feedback');

  await assert.rejects(
    sendAdminCommand(app.service.adminSocketPath, { command: 'approve', id: feedback.id }),
    /Only feature requests/,
  );
  const approved = await sendAdminCommand(app.service.adminSocketPath, {
    command: 'approve',
    id: feature.id,
    title: 'Keyboard-first navigation',
  });
  await sendAdminCommand(app.service.adminSocketPath, { command: 'mark-reviewed', id: feedback.id });

  const publicPoll = await poll(app);
  assert.deepEqual(publicPoll.items, [{ id: approved.id, title: 'Keyboard-first navigation', votes: 0, starterVotes: 0 }]);
  assert.equal(publicPoll.includesStarterVotes, false);
  assert.equal(typeof publicPoll.updatedAt, 'string');
  assert.deepEqual(Object.keys(publicPoll.items[0]).sort(), ['id', 'starterVotes', 'title', 'votes']);
  const serializedPublic = JSON.stringify(publicPoll);
  assert.doesNotMatch(serializedPublic, /Original private|FEATURE-DETAIL|GENERAL-FEEDBACK|status|sourceHash|submittedAt/);

  const shown = await sendAdminCommand(app.service.adminSocketPath, { command: 'show', id: feature.id });
  assert.equal(shown.title, 'Original private feature wording');
  assert.equal(shown.details, 'FEATURE-DETAIL-PRIVATE should never appear in the public poll.');

  await sendAdminCommand(app.service.adminSocketPath, {
    command: 'set-starter-votes', id: approved.id, count: 12,
  });
  const seededPoll = await poll(app);
  assert.equal(seededPoll.includesStarterVotes, true);
  assert.equal(seededPoll.items[0].votes, 12);
  assert.equal(seededPoll.items[0].starterVotes, 12);

  const disk = await readFile(path.join(app.dataDir, 'community.json'), 'utf8');
  assert.doesNotMatch(disk, /sourceHash|203\.0\.113\./);
  assert.doesNotMatch(disk, /203\.0\.113\.42/);
  const socketInfo = await stat(app.service.adminSocketPath);
  assert.equal(socketInfo.mode & 0o777, 0o600);
});

test('one vote per browser ID changes choice, survives restart, and concurrent votes are not lost', async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  await submit(app, { title: 'Feature alpha', details: 'The first candidate feature in this poll.' });
  await submit(app, { title: 'Feature beta', details: 'The second candidate feature in this poll.' });
  const pending = await sendAdminCommand(app.service.adminSocketPath, { command: 'list', status: 'pending' });
  const alphaSubmission = pending.find((item) => item.title === 'Feature alpha');
  const betaSubmission = pending.find((item) => item.title === 'Feature beta');
  const alpha = await sendAdminCommand(app.service.adminSocketPath, { command: 'approve', id: alphaSubmission.id });
  const beta = await sendAdminCommand(app.service.adminSocketPath, { command: 'approve', id: betaSubmission.id });

  const voterId = randomUUID();
  let response = await post(app, '/api/community/vote', { voterId, featureId: alpha.id });
  assert.equal(response.status, 200);
  response = await post(app, '/api/community/vote', { voterId, featureId: beta.id });
  assert.equal(response.status, 200);
  let result = await poll(app);
  assert.equal(result.items.find((item) => item.id === alpha.id).votes, 0);
  assert.equal(result.items.find((item) => item.id === beta.id).votes, 1);

  const concurrentVoters = Array.from({ length: 40 }, () => randomUUID());
  const voteResponses = await Promise.all(concurrentVoters.map((id) => post(
    app,
    '/api/community/vote',
    { voterId: id, featureId: beta.id },
    { ip: `198.51.100.${(concurrentVoters.indexOf(id) % 200) + 1}` },
  )));
  assert.ok(voteResponses.every((entry) => entry.status === 200));
  result = await poll(app);
  assert.equal(result.items.find((item) => item.id === beta.id).votes, 41);

  response = await post(app, '/api/community/vote', { voterId: randomUUID(), featureId: betaSubmission.id });
  assert.equal(response.status, 404);
  response = await post(app, '/api/community/vote', { voterId: 'not-random-enough', featureId: beta.id });
  assert.equal(response.status, 400);

  await app.restart();
  result = await poll(app);
  assert.equal(result.items.find((item) => item.id === beta.id).votes, 41);
  const persisted = await readFile(path.join(app.dataDir, 'community.json'), 'utf8');
  assert.doesNotMatch(persisted, new RegExp(voterId, 'i'));

  await sendAdminCommand(app.service.adminSocketPath, { command: 'close', id: beta.id });
  result = await poll(app);
  assert.equal(result.items.some((item) => item.id === beta.id), false);
  const archived = await sendAdminCommand(app.service.adminSocketPath, {
    command: 'poll', includeArchived: true,
  });
  const closed = archived.find((item) => item.id === beta.id);
  assert.equal(closed.active, false);
  assert.equal(closed.votes, 0);
  await app.restart();
  result = await poll(app);
  assert.equal(result.items.some((item) => item.id === beta.id), false);
});

test('active poll items are capped at 50 and closing one frees a slot without retaining its votes', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CommunityStore({ dataDir: root });
  await store.init();
  const sourceHash = 'c'.repeat(64);
  const approved = [];
  for (let index = 1; index <= 50; index += 1) {
    const submission = await store.addSubmission({
      kind: 'feature',
      title: `Bounded poll item ${index}`,
      details: `Details for bounded poll item ${index}.`,
      sourceHash,
    });
    approved.push(await store.approve(submission.id, submission.title));
  }
  const overflow = await store.addSubmission({
    kind: 'feature',
    title: 'Overflow poll item',
    details: 'This item must wait until an active slot is available.',
    sourceHash,
  });
  await assert.rejects(store.approve(overflow.id, overflow.title), (error) => error.code === 'capacity');

  await store.recordVote('d'.repeat(64), approved[0].id);
  await store.closePollItem(approved[0].id);
  await store.approve(overflow.id, overflow.title);
  const publicPoll = await store.getPublicPoll();
  assert.equal(publicPoll.items.length, 50);
  assert.equal(publicPoll.items.some((item) => item.id === approved[0].id), false);
  const allItems = await store.listPollItems({ includeArchived: true });
  assert.equal(allItems.length, 51);
  assert.equal(allItems.find((item) => item.id === approved[0].id).votes, 0);
});

test('retention removes old pending, rejected, and reviewed rows but preserves active approved poll items and votes', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let current = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new CommunityStore({ dataDir: root, now: () => new Date(current) });
  await store.init();
  const sourceHash = 'a'.repeat(64);

  const pending = await store.addSubmission({
    kind: 'feature', title: 'Old pending title', details: 'Old pending details.', sourceHash,
  });
  const rejected = await store.addSubmission({
    kind: 'feature', title: 'Rejected title', details: 'Rejected details.', sourceHash,
  });
  await store.reject(rejected.id);
  const reviewed = await store.addSubmission({
    kind: 'feedback', title: 'Reviewed feedback', details: 'Reviewed feedback details.', sourceHash,
  });
  await store.markReviewed(reviewed.id);
  const approvedSubmission = await store.addSubmission({
    kind: 'feature', title: 'Durable approved title', details: 'Approved feature details.', sourceHash,
  });
  const approved = await store.approve(approvedSubmission.id, approvedSubmission.title);
  await store.recordVote('b'.repeat(64), approved.id);
  const archivedSubmission = await store.addSubmission({
    kind: 'feature', title: 'Short-lived archived title', details: 'Archived feature details.', sourceHash,
  });
  const archived = await store.approve(archivedSubmission.id, archivedSubmission.title);
  await store.closePollItem(archived.id);

  current += 31 * 24 * 60 * 60 * 1_000;
  await store.cleanup();
  assert.equal(await store.getSubmission(rejected.id), null);
  assert.equal(await store.getSubmission(reviewed.id), null);
  assert.equal(await store.getSubmission(approvedSubmission.id), null);
  assert.equal(await store.getSubmission(archivedSubmission.id), null);
  assert.ok(await store.getSubmission(pending.id));
  assert.equal((await store.listPollItems({ includeArchived: true })).some((item) => item.id === archived.id), false);

  current += 150 * 24 * 60 * 60 * 1_000;
  await store.cleanup();
  assert.equal(await store.getSubmission(pending.id), null);
  assert.equal(await store.getSubmission(approvedSubmission.id), null);
  const durablePoll = await store.getPublicPoll();
  assert.deepEqual(durablePoll.items, [{ id: approved.id, title: 'Durable approved title', votes: 1, starterVotes: 0 }]);
  assert.equal(typeof durablePoll.updatedAt, 'string');
});

test('startup removes abandoned regular store temporaries before loading private data', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const abandoned = `.community.json.999.${randomUUID()}.tmp`;
  await writeFile(path.join(root, abandoned), 'PRIVATE-ABANDONED-CONTENT', { mode: 0o600 });
  const store = new CommunityStore({ dataDir: root });
  await store.init();
  assert.equal((await readdir(root)).includes(abandoned), false);
  assert.deepEqual(await store.stats(), { submissions: 0, activePollItems: 0, votes: 0 });
});

test('static server blocks traversal and escapes while returning cache and security headers', async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const outside = path.join(app.root, 'outside.txt');
  await writeFile(outside, 'OUTSIDE-SECRET', 'utf8');
  await symlink(outside, path.join(app.staticRoot, 'escape.txt'));

  let response = await rawRequest(app.baseUrl, '/');
  assert.equal(response.status, 200);
  assert.match(response.body, /TabMonger test/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-cache');

  const etag = response.headers.etag;
  response = await rawRequest(app.baseUrl, '/', { headers: { 'If-None-Match': etag } });
  assert.equal(response.status, 304);
  response = await rawRequest(app.baseUrl, '/', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.body, '');
  response = await rawRequest(app.baseUrl, '/docs');
  assert.equal(response.status, 200);
  assert.match(response.body, /Docs/);
  response = await rawRequest(app.baseUrl, '/_astro/app.123.js');
  assert.equal(response.status, 200);
  assert.match(response.headers['cache-control'], /immutable/);

  for (const unsafePath of [
    '/%2e%2e/outside.txt',
    '/safe/%2e%2e/%2e%2e/outside.txt',
    '/%5c..%5coutside.txt',
    '/.env',
  ]) {
    response = await rawRequest(app.baseUrl, unsafePath);
    assert.ok(response.status === 400 || response.status === 404, `${unsafePath} returned ${response.status}`);
    assert.doesNotMatch(response.body, /OUTSIDE-SECRET|must-not-serve/);
  }
  response = await rawRequest(app.baseUrl, '/escape.txt');
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.body, /OUTSIDE-SECRET/);
});

test('mutations require strict same-origin JSON, enforce limits and honeypot, and expose no admin HTTP route', async (t) => {
  const app = await fixture({
    rateLimits: { submission: { perSource: 20, global: 100, windowMs: 60_000 } },
  });
  t.after(() => app.close());

  let response = await submit(app, {}, { noOrigin: true });
  assert.equal(response.status, 403);
  response = await post(app, '/api/community/submissions', {
    kind: 'feedback', title: 'Normal feedback', details: 'A normal feedback message.', website: '',
  }, { origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  response = await post(app, '/api/community/submissions', {
    kind: 'feedback', title: 'Normal feedback', details: 'A normal feedback message.', website: '',
  }, { fetchSite: 'cross-site' });
  assert.equal(response.status, 403);

  response = await fetch(`${app.baseUrl}/api/community/submissions`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(response.status, 415);
  response = await post(app, '/api/community/submissions', '{not-json');
  assert.equal(response.status, 400);
  response = await post(app, '/api/community/submissions', {
    kind: 'feedback', title: 'Normal feedback', details: 'A normal feedback message.', website: '', extra: true,
  });
  assert.equal(response.status, 400);
  response = await post(app, '/api/community/submissions', 'x'.repeat(17_000));
  assert.equal(response.status, 413);

  const before = await sendAdminCommand(app.service.adminSocketPath, { command: 'list' });
  response = await post(app, '/api/community/submissions', {
    kind: 'feature', title: 'Ignored bot request', details: 'This must not enter moderation.', website: 'filled-by-bot',
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true });
  const after = await sendAdminCommand(app.service.adminSocketPath, { command: 'list' });
  assert.equal(after.length, before.length);

  response = await fetch(`${app.baseUrl}/api/community/admin`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('submission rate limiting is keyed by a salted source hash', async (t) => {
  const app = await fixture({
    rateLimits: { submission: { perSource: 1, global: 100, windowMs: 60_000 } },
  });
  t.after(() => app.close());

  let response = await submit(app, { title: 'First request' });
  assert.equal(response.status, 202);
  response = await submit(app, { title: 'Second request' });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) >= 1);
  response = await post(app, '/api/community/submissions', {
    kind: 'feature', title: 'Other source request', details: 'A request from a different source.', website: '',
  }, { ip: '203.0.113.99' });
  assert.equal(response.status, 202);
});

test('aggregate analytics accepts only allowlisted counters and stores no visitor details', async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  let response = await post(app, '/api/analytics/event', { event: 'page_view', source: 'search' }, {
    ip: '198.51.100.77',
    headers: { 'User-Agent': 'Private Browser Detail', Referer: 'https://search.example/private?q=tabmonger' },
  });
  assert.equal(response.status, 202);
  response = await post(app, '/api/analytics/event', { event: 'download_portable', source: 'github' });
  assert.equal(response.status, 202);
  for (const event of ['download_macos', 'download_windows', 'download_linux', 'download_chromium', 'download_firefox']) {
    response = await post(app, '/api/analytics/event', { event, source: 'direct' });
    assert.equal(response.status, 202);
  }

  response = await post(app, '/api/analytics/event', { event: 'page_view', source: 'search', visitor: 'not-allowed' });
  assert.equal(response.status, 400);
  response = await post(app, '/api/analytics/event', { event: 'unknown', source: 'direct' });
  assert.equal(response.status, 400);
  response = await post(app, '/api/analytics/event', { event: 'page_view', source: 'direct' }, { origin: 'https://evil.example' });
  assert.equal(response.status, 403);

  response = await fetch(`${app.baseUrl}/api/analytics/report?days=30`);
  assert.equal(response.status, 200);
  let report = await response.json();
  assert.equal(report.totals.page_view, 1);
  assert.equal(report.totals.download_portable, 1);
  assert.equal(report.totals.download_macos, 1);
  assert.equal(report.totals.download_windows, 1);
  assert.equal(report.totals.download_linux, 1);
  assert.equal(report.totals.download_chromium, 1);
  assert.equal(report.totals.download_firefox, 1);
  assert.equal(report.sources.search, 1);
  assert.equal(report.sources.github, 1);
  assert.equal(report.sources.direct, 5);
  assert.equal(report.daily.length, 30);
  assert.equal(report.daily.at(-1).page_view, 1);

  const stored = await readFile(path.join(app.dataDir, 'analytics.ndjson'), 'utf8');
  assert.match(stored, /"event":"page_view"/);
  assert.doesNotMatch(stored, /198\.51\.100\.77|Private Browser Detail|search\.example|visitor|sourceHash/);

  await app.restart();
  response = await fetch(`${app.baseUrl}/api/analytics/report?days=30`);
  report = await response.json();
  assert.equal(report.totals.page_view, 1);
  assert.equal(report.totals.download_portable, 1);
  assert.equal(report.totals.download_macos, 1);
  assert.equal(report.totals.download_windows, 1);
  assert.equal(report.totals.download_linux, 1);

  response = await fetch(`${app.baseUrl}/api/analytics/report?days=181`);
  assert.equal(response.status, 400);
  response = await fetch(`${app.baseUrl}/api/analytics/report?days=30&raw=true`);
  assert.equal(response.status, 400);
});

test('startup fails closed for a missing or short hash salt and for corrupt persistent JSON', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(createCommunityService({
    dataDir: path.join(root, 'missing-salt'),
    staticRoot: root,
    allowedOrigins: [ORIGIN],
    salt: 'short',
  }), /COMMUNITY_HASH_SALT/);

  const corruptDir = path.join(root, 'corrupt');
  await mkdir(corruptDir, { recursive: true });
  await chmod(corruptDir, 0o700);
  await writeFile(path.join(corruptDir, 'community.json'), '{not valid json', { mode: 0o600 });
  await assert.rejects(createCommunityService({
    dataDir: corruptDir,
    staticRoot: root,
    adminSocketPath: path.join(corruptDir, 'admin.sock'),
    allowedOrigins: [ORIGIN],
    salt: TEST_SALT,
  }), /invalid JSON/);
});

test('failed atomic replacement returns storage unavailable and removes its temporary file', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CommunityStore({ dataDir: root });
  await store.init();
  const destination = path.join(root, 'community.json');
  await rename(destination, path.join(root, 'community-before-fault.json'));
  await mkdir(destination);

  await assert.rejects(store.addSubmission({
    kind: 'feedback',
    title: 'Storage fault test',
    details: 'This mutation must fail without leaving a temporary file.',
    sourceHash: 'e'.repeat(64),
  }), (error) => error.code === 'storage_unavailable' && error.status === 503);
  const names = await readdir(root);
  assert.equal(names.some((name) => /^\.community\.json\..+\.tmp$/.test(name)), false);
});

test('post-rename directory sync failure fail-stops stale memory and restart loads the replaced state', async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  let directorySyncs = 0;
  let fatalCallbacks = 0;
  const store = new CommunityStore({
    dataDir: root,
    directorySync: async () => {
      directorySyncs += 1;
      if (directorySyncs > 1) throw new Error('synthetic directory fsync failure');
    },
    onFatalError: () => { fatalCallbacks += 1; },
  });
  await store.init();
  await assert.rejects(store.addSubmission({
    kind: 'feedback',
    title: 'Uncertain durability test',
    details: 'The renamed file must never be overwritten by stale process memory.',
    sourceHash: 'f'.repeat(64),
  }), (error) => error.code === 'storage_state_uncertain' && error.status === 503);
  assert.throws(() => store.stats(), (error) => error.code === 'storage_unavailable' && error.status === 503);
  assert.equal(fatalCallbacks, 1);
  assert.match(await readFile(path.join(root, 'community.json'), 'utf8'), /Uncertain durability test/);

  const restarted = new CommunityStore({ dataDir: root });
  await restarted.init();
  assert.deepEqual(await restarted.stats(), { submissions: 1, activePollItems: 0, votes: 0 });
});
