(() => {
  'use strict';

  const ENDPOINT = '/api/analytics/event';
  const OPTOUT_KEY = 'tabmonger.site.analytics.optout.v1';
  const OPTOUT_COOKIE = 'tm_analytics=off';
  const PAGE_VIEW_SESSION_KEY = 'tabmonger.site.analytics.pageview.v1';
  const EVENTS = new Set([
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
    'poll_vote'
  ]);

  const optedOut = (() => {
    let disabled = false;
    let preferenceSaved = false;
    try {
      const url = new URL(window.location.href);
      const directive = url.searchParams.get('analytics');
      if (directive === 'off') {
        disabled = true;
        try {
          window.localStorage.setItem(OPTOUT_KEY, '1');
          preferenceSaved = window.localStorage.getItem(OPTOUT_KEY) === '1';
        } catch {}
        try {
          document.cookie = `${OPTOUT_COOKIE}; Max-Age=31536000; Path=/; SameSite=Lax; Secure`;
          preferenceSaved ||= document.cookie.split(';').some((value) => value.trim() === OPTOUT_COOKIE);
        } catch {}
      } else if (directive === 'on') {
        try { window.localStorage.removeItem(OPTOUT_KEY); } catch {}
        try { document.cookie = 'tm_analytics=; Max-Age=0; Path=/; SameSite=Lax; Secure'; } catch {}
      } else {
        try { disabled = window.localStorage.getItem(OPTOUT_KEY) === '1'; } catch {}
        try {
          disabled ||= document.cookie.split(';').some((value) => value.trim() === OPTOUT_COOKIE);
        } catch {}
      }
      if (directive === 'on' || (directive === 'off' && preferenceSaved)) {
        url.searchParams.delete('analytics');
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      }
    } catch {
      disabled = new URL(window.location.href).searchParams.get('analytics') === 'off';
    }
    return disabled;
  })();

  if (optedOut) {
    document.documentElement.dataset.analytics = 'off';
    return;
  }

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
    const explicitEvent = anchor.dataset.analyticsEvent;
    if (EVENTS.has(explicitEvent)) return explicitEvent;
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

  let pageViewAlreadyCounted = false;
  try {
    pageViewAlreadyCounted = window.sessionStorage.getItem(PAGE_VIEW_SESSION_KEY) === '1';
    if (!pageViewAlreadyCounted) window.sessionStorage.setItem(PAGE_VIEW_SESSION_KEY, '1');
  } catch {}
  if (!pageViewAlreadyCounted) record('page_view');
})();
