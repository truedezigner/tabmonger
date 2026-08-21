const OTHER_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const HTML_MARKUP = /<\/?[a-z][^>]*>|&(?:lt|gt|#0*60|#x0*3c);/iu;
const MARKDOWN_MARKUP = /!?(?:\[[^\]\n]{0,160}\]\([^\)\n]{0,320}\)|`{1,3})/u;
const BBCODE_MARKUP = /\[(?:\/?(?:url|img|code|quote|script|iframe)|url=[^\]]+)\]/iu;
const ACTIVE_CONTENT = /(?:javascript\s*:|data\s*:\s*text\/html|on(?:error|load|click)\s*=)/iu;
const URLISH = /(?:https?:\/\/|www\.|(?:^|[\s(])(?:[a-z0-9][a-z0-9-]{0,62}\.)+(?:com|net|org|io|co|dev|app|xyz|top|click|link|site|online|shop|ru|cn|gg|me)(?:\b|\/))/iu;

const BLOCKED_WORDS = new Set([
  'asshole',
  'bastard',
  'bitch',
  'bullshit',
  'cock',
  'cunt',
  'dick',
  'faggot',
  'fuck',
  'fucker',
  'fucking',
  'motherfucker',
  'nigga',
  'nigger',
  'pussy',
  'retard',
  'shit',
  'slut',
  'whore',
]);
const BLOCKED_COMPOUNDS = ['bitch', 'bullshit', 'cunt', 'faggot', 'fuck', 'nigga', 'nigger', 'retard'];
const CONFUSABLES = new Map([
  ['а', 'a'], ['α', 'a'],
  ['е', 'e'], ['ε', 'e'],
  ['і', 'i'], ['ι', 'i'],
  ['ј', 'j'],
  ['к', 'k'], ['κ', 'k'],
  ['о', 'o'], ['ο', 'o'],
  ['р', 'p'], ['ρ', 'p'],
  ['с', 'c'],
  ['ѕ', 's'],
  ['у', 'u'], ['υ', 'u'],
  ['х', 'x'], ['χ', 'x'],
]);

const BLOCKED_PHRASES = [
  /\bkill\s+(?:yourself|urself|your\s+self)\b/u,
  /\bk\s+i\s+l\s+l\s+(?:yourself|urself|your\s+self)\b/u,
  /\bgo\s+die\b/u,
  /\bi(?:'| a)?m\s+going\s+to\s+kill\s+you\b/u,
  /\bi\s+will\s+kill\s+you\b/u,
  /\b(?:rape|murder)\s+you\b/u,
  /\bkys\b/u,
];

const SPAM_PHRASES = [
  /\b(?:buy|gain|get)\s+(?:followers|subscribers|traffic|likes)\b/u,
  /\b(?:crypto|forex|binary options?)\s+(?:profit|signal|investment|returns?)\b/u,
  /\bcasino\s+(?:bonus|offer|winner)\b/u,
  /\bpayday\s+loans?\b/u,
  /\bsearch\s+engine\s+optimization\b/u,
  /\bguest\s+post(?:ing)?\b/u,
  /\bclick\s+here\b/u,
  /\b(?:telegram|whatsapp)\s*(?:me|us|at|@|:)/u,
];

export class InputError extends Error {
  constructor(code, message = 'The submitted content was not accepted.') {
    super(message);
    this.name = 'InputError';
    this.code = code;
  }
}

function plainText(value, { field, min, max }) {
  if (typeof value !== 'string') {
    throw new InputError(`invalid_${field}`, `${field} must be text.`);
  }

  let normalized;
  try {
    normalized = value.normalize('NFKC').replace(/\r\n?/g, '\n');
  } catch {
    throw new InputError(`invalid_${field}`);
  }

  for (const character of normalized) {
    if (character !== '\n' && OTHER_UNICODE.test(character)) {
      throw new InputError(`unsafe_${field}`);
    }
  }

  normalized = normalized.replace(/\s+/gu, ' ').trim();
  const length = [...normalized].length;
  if (length < min || length > max || !LETTER_OR_NUMBER.test(normalized)) {
    throw new InputError(`invalid_${field}`);
  }

  return normalized;
}

function abuseSkeleton(value) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[аеіјкоорсѕухαεικορυχ]/gu, (character) => CONFUSABLES.get(character) ?? character)
    .replace(/[@4]/g, 'a')
    .replace(/[8]/g, 'b')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[7+]/g, 't')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function rejectMarkupAndUrls(value) {
  if (
    HTML_MARKUP.test(value)
    || MARKDOWN_MARKUP.test(value)
    || BBCODE_MARKUP.test(value)
    || ACTIVE_CONTENT.test(value)
  ) {
    throw new InputError('markup_not_allowed');
  }
  if (URLISH.test(value)) {
    throw new InputError('url_not_allowed');
  }
}

function rejectAbuseAndSpam(value) {
  const skeleton = abuseSkeleton(value);
  const words = skeleton.match(/[\p{L}\p{N}]+/gu) ?? [];

  if (words.some((word) => BLOCKED_WORDS.has(word))) {
    throw new InputError('abusive_content');
  }
  if (words.some((word) => BLOCKED_COMPOUNDS.some((blocked) => (
    word.startsWith(blocked) || word.endsWith(blocked)
  )))) {
    throw new InputError('abusive_content');
  }

  let singleLetterRun = '';
  for (const word of words) {
    if ([...word].length === 1) {
      singleLetterRun += word;
      if (singleLetterRun.length >= 3 && BLOCKED_WORDS.has(singleLetterRun)) {
        throw new InputError('abusive_content');
      }
    } else {
      singleLetterRun = '';
    }
  }

  if (BLOCKED_PHRASES.some((pattern) => pattern.test(skeleton))) {
    throw new InputError('abusive_content');
  }
  if (SPAM_PHRASES.some((pattern) => pattern.test(skeleton))) {
    throw new InputError('spam_content');
  }

  if (/(.)\1{7,}/iu.test(value) || /[!?$*_=+\-.]{10,}/u.test(value)) {
    throw new InputError('spam_content');
  }

  const counts = new Map();
  for (const word of words) {
    const next = (counts.get(word) ?? 0) + 1;
    counts.set(word, next);
    if (word.length >= 3 && next >= 5) {
      throw new InputError('spam_content');
    }
  }
}

export function validatePublicTitle(value) {
  const title = plainText(value, { field: 'title', min: 3, max: 80 });
  rejectMarkupAndUrls(title);
  rejectAbuseAndSpam(title);
  return title;
}

export function validateSubmission(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('invalid_submission');
  }

  const allowedKeys = new Set(['kind', 'title', 'details', 'website']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new InputError('unknown_field');
  }

  if (value.website !== undefined && typeof value.website !== 'string') {
    throw new InputError('invalid_honeypot');
  }
  if (typeof value.website === 'string' && value.website.trim() !== '') {
    return { honeypot: true };
  }

  if (value.kind !== 'feature' && value.kind !== 'feedback') {
    throw new InputError('invalid_kind');
  }

  const title = validatePublicTitle(value.title);
  const details = plainText(value.details, { field: 'details', min: 3, max: 1_200 });
  rejectMarkupAndUrls(details);
  rejectAbuseAndSpam(`${title} ${details}`);

  return {
    honeypot: false,
    kind: value.kind,
    title,
    details,
  };
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateVote(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'voterId')
    || !Object.hasOwn(value, 'featureId')
    || typeof value.voterId !== 'string'
    || typeof value.featureId !== 'string'
    || !UUID_V4.test(value.voterId)
    || !UUID_V4.test(value.featureId)
  ) {
    throw new InputError('invalid_vote', 'The vote was not accepted.');
  }

  return { voterId: value.voterId.toLowerCase(), featureId: value.featureId.toLowerCase() };
}

export function canonicalTitle(value) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}
