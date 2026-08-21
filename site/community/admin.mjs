import net from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { validatePublicTitle } from './moderation.mjs';
import { StoreError } from './store.mjs';

const MAX_ADMIN_REQUEST_BYTES = 16 * 1024;
const MAX_ADMIN_RESPONSE_BYTES = 8 * 1024 * 1024;
const ADMIN_TIMEOUT_MS = 5_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class AdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
  }
}

function validId(value) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    throw new AdminError('invalid_id', 'A valid submission ID is required.');
  }
  return value.toLowerCase();
}

async function dispatch(store, request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new AdminError('invalid_request', 'The moderation request is invalid.');
  }

  switch (request.command) {
    case 'list': {
      if (request.status !== undefined && !['pending', 'approved', 'rejected', 'reviewed'].includes(request.status)) {
        throw new AdminError('invalid_status', 'Unknown moderation status.');
      }
      if (request.kind !== undefined && !['feature', 'feedback'].includes(request.kind)) {
        throw new AdminError('invalid_kind', 'Unknown submission kind.');
      }
      return store.listSubmissions({
        status: request.status,
        kind: request.kind,
        limit: request.limit,
      });
    }
    case 'show': {
      const submission = await store.getSubmission(validId(request.id));
      if (!submission) throw new StoreError('not_found', 'Submission not found.', 404);
      return submission;
    }
    case 'poll': {
      if (request.includeArchived !== undefined && typeof request.includeArchived !== 'boolean') {
        throw new AdminError('invalid_request', 'includeArchived must be true or false.');
      }
      return store.listPollItems({ includeArchived: request.includeArchived === true });
    }
    case 'approve': {
      const id = validId(request.id);
      const submission = await store.getSubmission(id);
      if (!submission) throw new StoreError('not_found', 'Submission not found.', 404);
      const title = validatePublicTitle(request.title ?? submission.title);
      return store.approve(id, title);
    }
    case 'reject':
      return store.reject(validId(request.id));
    case 'mark-reviewed':
      return store.markReviewed(validId(request.id));
    case 'close':
      return store.closePollItem(validId(request.id));
    case 'set-starter-votes': {
      const count = Number(request.count);
      if (!Number.isSafeInteger(count) || count < 0 || count > 100_000) {
        throw new AdminError('invalid_count', 'Starter votes must be an integer from 0 to 100000.');
      }
      return store.setStarterVotes(validId(request.id), count);
    }
    default:
      throw new AdminError('unknown_command', 'Unknown moderation command.');
  }
}

function probeSocket(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AdminError('socket_busy', 'The existing moderation socket did not respond.'));
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
  });
}

async function prepareSocket(socketPath) {
  try {
    const info = await lstat(socketPath);
    if (!info.isSocket()) {
      throw new AdminError('unsafe_socket_path', 'The moderation socket path is occupied by a non-socket file.');
    }
    if (await probeSocket(socketPath)) {
      throw new AdminError('socket_in_use', 'Another moderation service is already running.');
    }
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function createAdminServer({ store, socketPath }) {
  await prepareSocket(socketPath);

  const server = net.createServer((socket) => {
    socket.setTimeout(ADMIN_TIMEOUT_MS, () => socket.destroy());
    let bytes = 0;
    let payload = '';
    let handled = false;

    const respond = (value) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify(value)}\n`);
    };

    socket.on('data', (chunk) => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_ADMIN_REQUEST_BYTES) {
        handled = true;
        respond({ ok: false, error: { code: 'request_too_large', message: 'Moderation request is too large.' } });
        return;
      }
      payload += chunk.toString('utf8');
      const newline = payload.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      socket.pause();

      const trailing = payload.slice(newline + 1).trim();
      if (trailing !== '') {
        respond({ ok: false, error: { code: 'invalid_request', message: 'Only one moderation request is allowed.' } });
        return;
      }

      let request;
      try {
        request = JSON.parse(payload.slice(0, newline));
      } catch {
        respond({ ok: false, error: { code: 'invalid_json', message: 'Moderation request is not valid JSON.' } });
        return;
      }

      dispatch(store, request)
        .then((result) => respond({ ok: true, result }))
        .catch((error) => respond({
          ok: false,
          error: {
            code: error?.code ?? 'internal_error',
            message: error instanceof StoreError || error instanceof AdminError
              ? error.message
              : 'Moderation command failed.',
          },
        }));
    });

    socket.on('error', () => {});
  });
  server.maxConnections = 8;

  const priorUmask = process.umask(0o177);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      process.umask(priorUmask);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      process.umask(priorUmask);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  await chmod(socketPath, 0o600);
  const identity = await lstat(socketPath);

  return {
    server,
    socketPath,
    async close() {
      if (server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
      try {
        const current = await lstat(socketPath);
        if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) {
          await unlink(socketPath);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
  };
}

export function sendAdminCommand(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let bytes = 0;
    let payload = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AdminError('timeout', 'The moderation service did not respond.'));
    }, ADMIN_TIMEOUT_MS);

    const finish = (error, response) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };

    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_ADMIN_RESPONSE_BYTES) {
        finish(new AdminError('response_too_large', 'Moderation response is too large.'));
        return;
      }
      payload += chunk.toString('utf8');
      const newline = payload.indexOf('\n');
      if (newline === -1) return;
      let response;
      try {
        response = JSON.parse(payload.slice(0, newline));
      } catch {
        finish(new AdminError('invalid_response', 'Moderation service returned invalid JSON.'));
        return;
      }
      if (!response?.ok) {
        finish(new AdminError(response?.error?.code ?? 'command_failed', response?.error?.message ?? 'Command failed.'));
      } else {
        finish(undefined, response.result);
      }
    });
    socket.once('error', (error) => finish(error));
  });
}
