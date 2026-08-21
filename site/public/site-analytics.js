(() => {
  'use strict';

  const ENDPOINT = '/api/analytics/event';
  const EVENTS = new Set([
    'page_view',
    'download_portable',
    'download_chromium',
    'download_firefox',
    'github_open',
    'support_open',
    'feedback_open',
    'feedback_submit',
    'poll_vote'
  ]);

  const category = (value) => {
    const source = String(value || '').trim().toLowerCase();
    if (!source) return null;
    if (/google|bing|duckduckgo|yahoo|brave|kagi|ecosia|search/.test(source)) return 'search';
    if (/github/.test(source)) return 'github';
    if (/reddit/.test(source)) return 'reddit';
    if (/hacker.?news|news\.ycombinator|^hn$/.test(source)) return 'hackernews';
    if (/product.?hunt/.test(source)) return 'producthunt';
    if (/newsletter|email|mailchimp|buttondown|convertkit/.test(source)) return 'newsletter';
    if (/x\.com|twitter|facebook|instagram|linkedin|mastodon|bluesky|bsky|youtube|tiktok/.test(source)) return 'social';
    return 'other';
  };

  const source = (() => {
    try {
      const campaign = new URL(window.location.href).searchParams.get('utm_source');
      const classifiedCampaign = category(campaign);
      if (classifiedCampaign) return classifiedCampaign;
      if (!document.referrer) return 'direct';
      const referrer = new URL(document.referrer);
      if (referrer.origin === window.location.origin) return 'direct';
      return category(referrer.hostname) || 'other';
    } catch {
      return 'other';
    }
  })();

  const record = (event) => {
    if (!EVENTS.has(event)) return;
    fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, source })
    }).catch(() => {});
  };

  const eventForLink = (anchor) => {
    let url;
    try {
      url = new URL(anchor.href, window.location.href);
    } catch {
      return null;
    }
    if (url.hostname === 'buy.stripe.com') return 'support_open';
    if (url.hostname !== 'github.com') return null;
    if (url.pathname.endsWith('/TabMonger-portable.zip')) return 'download_portable';
    if (url.pathname.endsWith('/TabMonger-Chromium-extension.zip')) return 'download_chromium';
    if (url.pathname.endsWith('/TabMonger-Firefox-extension.zip')) return 'download_firefox';
    return 'github_open';
  };

  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const analyticsEvent = eventForLink(anchor);
    if (analyticsEvent) record(analyticsEvent);
  }, { capture: true });

  window.addEventListener('tabmonger:analytics', (event) => {
    const analyticsEvent = event instanceof CustomEvent ? event.detail?.event : null;
    if (typeof analyticsEvent === 'string') record(analyticsEvent);
  });

  record('page_view');
})();
