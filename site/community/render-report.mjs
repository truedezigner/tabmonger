#!/usr/bin/env node

const days = Number(process.argv[2] ?? 7);
if (!Number.isSafeInteger(days) || days < 1 || days > 180) {
  process.stderr.write('Report days must be an integer from 1 to 180.\n');
  process.exitCode = 1;
} else {
  const response = await fetch(`http://127.0.0.1:8081/api/analytics/report?days=${days}`);
  if (!response.ok) throw new Error(`Analytics report returned HTTP ${response.status}.`);
  const report = await response.json();
  const total = (keys) => keys.reduce((sum, key) => sum + Number(report.totals[key] || 0), 0);
  const sources = Object.entries(report.sources).sort((left, right) => right[1] - left[1]);
  const lines = [
    '# TabMonger weekly metrics',
    '',
    `Generated: ${report.generatedAt}`,
    `Window: ${report.from} through ${report.through}`,
    '',
    '## Funnel',
    '',
    `- Page views: ${report.totals.page_view || 0}`,
    `- Total download clicks: ${total(['download_portable', 'download_macos', 'download_windows', 'download_linux', 'download_chromium', 'download_firefox'])}`,
    `- General app download clicks: ${report.totals.download_portable || 0}`,
    `- macOS download clicks: ${report.totals.download_macos || 0}`,
    `- Windows download clicks: ${report.totals.download_windows || 0}`,
    `- Linux download clicks: ${report.totals.download_linux || 0}`,
    `- Chrome / Brave / Edge download clicks: ${report.totals.download_chromium || 0}`,
    `- Firefox download clicks: ${report.totals.download_firefox || 0}`,
    `- GitHub opens: ${report.totals.github_open || 0}`,
    `- Poll votes: ${report.totals.poll_vote || 0}`,
    `- Feedback form opens: ${report.totals.feedback_open || 0}`,
    `- Feedback submissions: ${report.totals.feedback_submit || 0}`,
    `- Support checkout opens: ${report.totals.support_open || 0}`,
    '',
    '## Discovery sources',
    '',
    ...sources.map(([source, count]) => `- ${source}: ${count}`),
    '',
    'Use the private LAN dashboard for the daily chart and longer date windows.',
    '',
  ];
  process.stdout.write(lines.join('\n'));
}
