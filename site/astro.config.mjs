import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://tabmonger.com',
  output: 'static',
  build: { format: 'directory' },
  vite: { build: { cssMinify: true } }
});
