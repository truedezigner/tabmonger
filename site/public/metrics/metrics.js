(() => {
  'use strict';

  const labels = {
    page_view: 'Page views',
    download_portable: 'General app download clicks',
    download_macos: 'macOS download clicks',
    download_windows: 'Windows download clicks',
    download_linux: 'Linux download clicks',
    download_chromium: 'Chrome / Brave / Edge download clicks',
    download_firefox: 'Firefox download clicks',
    github_open: 'GitHub opens',
    support_open: 'Support checkout opens',
    feedback_open: 'Suggestion form opens',
    feedback_submit: 'Feedback submitted',
    poll_vote: 'Poll votes'
  };
  const sourceLabels = {
    direct: 'Direct', search: 'Search', github: 'GitHub', reddit: 'Reddit',
    hackernews: 'Hacker News', producthunt: 'Product Hunt', social: 'Social',
    newsletter: 'Newsletter', other: 'Other'
  };
  const number = new Intl.NumberFormat();
  const byId = (id) => document.getElementById(id);
  const range = byId('range');
  const refresh = byId('refresh');
  const status = byId('status');
  let loading = false;

  const setText = (id, value) => { const element = byId(id); if (element) element.textContent = value; };
  const sum = (totals, keys) => keys.reduce((total, key) => total + Number(totals[key] || 0), 0);

  const ranked = (target, values, names) => {
    if (!target) return;
    target.replaceChildren();
    const entries = Object.entries(values).sort((left, right) => right[1] - left[1]);
    const maximum = Math.max(1, ...entries.map(([, value]) => value));
    for (const [key, value] of entries) {
      const item = document.createElement('li');
      const title = document.createElement('b');
      const count = document.createElement('strong');
      const meter = document.createElement('span');
      const fill = document.createElement('i');
      item.className = 'ranked-item';
      title.textContent = names[key] || key;
      count.textContent = number.format(value);
      meter.className = 'ranked-meter';
      fill.style.width = `${Math.max(value > 0 ? 2 : 0, (value / maximum) * 100)}%`;
      meter.append(fill);
      item.append(title, count, meter);
      target.append(item);
    }
  };

  const renderTrend = (daily) => {
    const target = byId('trend');
    if (!target) return;
    target.replaceChildren();
    const points = daily.map((day) => ({
      date: day.date,
      views: Number(day.page_view || 0),
      downloads: sum(day, ['download_portable', 'download_macos', 'download_windows', 'download_linux', 'download_chromium', 'download_firefox'])
    }));
    const maximum = Math.max(1, ...points.flatMap((point) => [point.views, point.downloads]));
    for (const point of points) {
      const day = document.createElement('span');
      const views = document.createElement('i');
      const downloads = document.createElement('i');
      day.className = 'trend-day';
      day.title = `${point.date}: ${point.views} views, ${point.downloads} downloads`;
      views.className = 'trend-bar';
      downloads.className = 'trend-bar downloads';
      views.style.height = `${Math.max(point.views > 0 ? 1 : 0, (point.views / maximum) * 100)}%`;
      downloads.style.height = `${Math.max(point.downloads > 0 ? 1 : 0, (point.downloads / maximum) * 100)}%`;
      day.append(views, downloads);
      target.append(day);
    }
  };

  const load = async () => {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    status.textContent = 'Refreshing the latest counters…';
    delete status.dataset.tone;
    try {
      const days = Number(range.value) || 30;
      const response = await fetch(`/api/analytics/report?days=${days}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('report unavailable');
      const report = await response.json();
      const totals = report.totals || {};
      setText('views', number.format(totals.page_view || 0));
      setText('downloads', number.format(sum(totals, ['download_portable', 'download_macos', 'download_windows', 'download_linux', 'download_chromium', 'download_firefox'])));
      setText('github', number.format(totals.github_open || 0));
      setText('community', number.format(sum(totals, ['poll_vote', 'feedback_open', 'feedback_submit'])));
      setText('support', number.format(totals.support_open || 0));
      setText('range-label', `${report.from} — ${report.through}`);
      ranked(byId('sources'), report.sources || {}, sourceLabels);
      ranked(byId('events'), totals, labels);
      renderTrend(Array.isArray(report.daily) ? report.daily : []);
      const updated = new Date(report.generatedAt);
      setText('updated', `Updated ${updated.toLocaleString()}`);
      status.textContent = `Showing the last ${report.days} days. This page refreshes every minute.`;
    } catch {
      status.textContent = 'Metrics are temporarily unavailable. The public site is unaffected.';
      status.dataset.tone = 'error';
    } finally {
      loading = false;
      refresh.disabled = false;
    }
  };

  refresh.addEventListener('click', load);
  range.addEventListener('change', load);
  load();
  window.setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60_000);
})();
