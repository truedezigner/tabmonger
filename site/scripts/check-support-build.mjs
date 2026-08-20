import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const siteRoot = new URL('..', import.meta.url);
const builtPage = new URL('../dist/index.html', import.meta.url);
const stripeHost = ['buy', 'stripe', 'com'].join('.');
const smokeCheckoutUrl = `https://${stripeHost}/support-smoke-placeholder`;
const releaseBaseUrl = 'https://github.com/truedezigner/tabmonger/releases/latest/download';
const requiredReleaseAssets = [
  `${releaseBaseUrl}/TabMonger-portable.zip`,
  `${releaseBaseUrl}/TabMonger-Chromium-extension.zip`,
  `${releaseBaseUrl}/TabMonger-Firefox-extension.zip`,
];
const requiredSetupLinks = [
  'https://github.com/truedezigner/tabmonger/blob/main/docs/INSTALL.md#windows',
  'https://github.com/truedezigner/tabmonger/blob/main/docs/INSTALL.md#macos',
  'https://github.com/truedezigner/tabmonger/blob/main/docs/INSTALL.md#linux',
];

function redacted(value = '') {
  return value.replace(/https:\/\/buy\.stripe\.com\/[^\s"']+/g, '[STRIPE_URL_REDACTED]');
}

function build(label, overrides, shouldPass = true) {
  const result = spawnSync(npmCommand, ['run', 'build'], {
    cwd: siteRoot,
    env: {
      ...process.env,
      PUBLIC_SUPPORT_URL: '',
      PUBLIC_STRIPE_SUPPORT_URL: '',
      PUBLIC_STRIPE_SUPPORT_READY: 'false',
      ...overrides,
    },
    encoding: 'utf8',
  });
  const passed = result.status === 0;
  if (passed !== shouldPass) {
    process.stdout.write(redacted(result.stdout));
    process.stderr.write(redacted(result.stderr));
    throw new Error(`${label}: build ${passed ? 'passed' : 'failed'} unexpectedly.`);
  }
  if (!passed) return `${result.stdout}\n${result.stderr}`;
  const html = readFileSync(builtPage, 'utf8');
  assertReleaseDownloads(html, label);
  return html;
}

function assertReleaseDownloads(html, label) {
  for (const assetUrl of requiredReleaseAssets) {
    if (!html.includes(`href="${assetUrl}"`)) {
      throw new Error(`${label}: missing required release download ${assetUrl.split('/').at(-1)}.`);
    }
  }
  for (const disclosure of [
    'Python 3.10+',
    'Run it on macOS',
    'Run it on Windows',
    'Run it on Linux',
    'Start TabMonger.command',
    'Start TabMonger.bat',
    'Start TabMonger.sh',
    'Private networks only',
    'Standard Firefox installation is temporary until Mozilla signing',
  ]) {
    if (!html.includes(disclosure)) throw new Error(`${label}: missing download disclosure: ${disclosure}.`);
  }
  for (const setupUrl of requiredSetupLinks) {
    if (!html.includes(`href="${setupUrl}"`)) {
      throw new Error(`${label}: missing platform setup guide ${setupUrl.split('#').at(-1)}.`);
    }
  }
  const platformDownloads = html.indexOf('data-platform-downloads');
  const browserDownloads = html.indexOf('data-browser-downloads');
  const chromiumCard = html.indexOf('Chrome, Brave, and Edge', browserDownloads);
  const firefoxCard = html.indexOf('>Firefox<', browserDownloads);
  if (platformDownloads < 0 || browserDownloads <= platformDownloads) {
    throw new Error(`${label}: browser companions must follow all platform launchers.`);
  }
  if (chromiumCard <= browserDownloads || firefoxCard <= chromiumCard) {
    throw new Error(`${label}: browser companion cards are missing or out of order.`);
  }
}

function assertActive(html, label) {
  const checkoutOccurrences = html.split(smokeCheckoutUrl).length - 1;
  const requiredLabels = [
    'Support TabMonger with an optional one-time contribution',
    'Make a one-time contribution',
    'Optional contribution',
  ];
  if (checkoutOccurrences !== 3) {
    throw new Error(`${label}: expected 3 active support checkout links, found ${checkoutOccurrences}.`);
  }
  if (html.includes('Contributions opening soon') || html.includes('class="button coffee-cta is-pending"')) {
    throw new Error(`${label}: active support build still contains pending contribution UI.`);
  }
  for (const text of requiredLabels) {
    if (!html.includes(text)) throw new Error(`${label}: missing an active support CTA.`);
  }
}

assertActive(build('preferred variable', {
  PUBLIC_SUPPORT_URL: smokeCheckoutUrl,
  PUBLIC_STRIPE_SUPPORT_READY: 'true',
}), 'preferred variable');

assertActive(build('legacy variable', {
  PUBLIC_STRIPE_SUPPORT_URL: smokeCheckoutUrl,
  PUBLIC_STRIPE_SUPPORT_READY: 'true',
}), 'legacy variable');

const pending = build('pending state', {});
if (!pending.includes('Contributions opening soon') || pending.includes(smokeCheckoutUrl)) {
  throw new Error('Pending support build did not fail closed.');
}

for (const [label, value] of [
  ['non-HTTPS scheme', 'javascript:alert(1)'],
  ['non-Stripe host', 'https://payments.example/support'],
]) {
  const output = build(label, {
    PUBLIC_SUPPORT_URL: value,
    PUBLIC_STRIPE_SUPPORT_READY: 'true',
  }, false);
  if (!/support checkout|Payment Link/i.test(output)) {
    throw new Error(`${label}: rejected build did not explain the safe configuration requirement.`);
  }
}

console.log('Site smoke check passed: three platform launchers, browser companion ordering, release downloads, setup disclosures, preferred and legacy Stripe links, 3 CTAs, pending state, and invalid-host rejection.');
