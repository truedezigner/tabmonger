#!/usr/bin/env node

import path from 'node:path';
import { sendAdminCommand } from './admin.mjs';

const HELP = `TabMonger community moderation

Usage:
  node moderate.mjs list [--status pending|approved|rejected|reviewed] [--kind feature|feedback] [--limit N]
  node moderate.mjs show <submission-id>
  node moderate.mjs approve <submission-id> [--title "Public poll title"]
  node moderate.mjs reject <submission-id>
  node moderate.mjs mark-reviewed <submission-id>
  node moderate.mjs poll [--all]
  node moderate.mjs close <poll-item-id>

The CLI talks only to the running service's private Unix socket. There is no
public moderation API. Set COMMUNITY_ADMIN_SOCKET when using a non-default path.
`;

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
    throw new Error(`${name} requires a value.`);
  }
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function requestFromArguments(arguments_) {
  const args = [...arguments_];
  const command = args.shift();
  if (!command || command === '--help' || command === '-h' || command === 'help') return null;

  if (command === 'list') {
    const status = option(args, '--status');
    const kind = option(args, '--kind');
    const rawLimit = option(args, '--limit');
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    const limit = rawLimit === undefined ? 200 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('--limit must be an integer from 1 to 1000.');
    }
    return { command, status, kind, limit };
  }

  if (command === 'show' || command === 'reject' || command === 'mark-reviewed') {
    if (args.length !== 1) throw new Error(`${command} requires exactly one submission ID.`);
    return { command, id: args[0] };
  }

  if (command === 'poll') {
    const includeArchived = args.includes('--all');
    if (includeArchived) args.splice(args.indexOf('--all'), 1);
    if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
    return { command, includeArchived };
  }

  if (command === 'close') {
    if (args.length !== 1) throw new Error('close requires exactly one poll-item ID.');
    return { command, id: args[0] };
  }

  if (command === 'approve') {
    const title = option(args, '--title');
    if (args.length !== 1) throw new Error('approve requires one submission ID.');
    return { command, id: args[0], ...(title === undefined ? {} : { title }) };
  }

  throw new Error(`Unknown command: ${command}`);
}

function printList(items) {
  if (items.length === 0) {
    process.stdout.write('No matching submissions.\n');
    return;
  }
  for (const item of items) {
    process.stdout.write(`${item.id}\t${item.kind}\t${item.status}\t${item.submittedAt}\t${item.title}\n`);
  }
}

async function main() {
  const request = requestFromArguments(process.argv.slice(2));
  if (!request) {
    process.stdout.write(HELP);
    return;
  }
  const dataDir = path.resolve(process.env.COMMUNITY_DATA_DIR ?? '/data/community');
  const socketPath = path.resolve(process.env.COMMUNITY_ADMIN_SOCKET ?? path.join(dataDir, 'admin.sock'));
  const result = await sendAdminCommand(socketPath, request);
  if (request.command === 'list') printList(result);
  else if (request.command === 'poll') {
    if (result.length === 0) process.stdout.write('No matching poll items.\n');
    else {
      for (const item of result) {
        process.stdout.write(`${item.id}\t${item.active ? 'active' : 'closed'}\t${item.votes}\t${item.title}\n`);
      }
    }
  }
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Moderation command failed: ${error.message}\n`);
  process.exitCode = 1;
});
