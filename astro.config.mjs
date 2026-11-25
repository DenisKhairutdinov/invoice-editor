import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  base: process.env.BASE_PATH || '/',
  site: process.env.SITE_URL,
  vite: {
    build: {
      assetsInlineLimit: 0,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'pdf-renderer', test: /[\\/]pdfjs-dist[\\/]/ },
              { name: 'pdf-editor', test: /[\\/]pdf-lib[\\/]/ },
              { name: 'pdf-fonts', test: /[\\/]fontkit[\\/]/ },
            ],
          },
        },
      },
    },
  },
});
