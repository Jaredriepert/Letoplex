/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// BASE_PATH lets the same build serve from a sub-path, e.g. GitHub Pages
// project sites at https://<user>.github.io/<repo>/ (set BASE_PATH=/<repo>/).
const base = process.env.BASE_PATH ?? '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,ttf,letoplex}'],
      },
      manifest: {
        id: './',
        name: 'Letoplex',
        short_name: 'Letoplex',
        description: 'Read illustrated, branching stories. Books stay on your device.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#efe1cc',
        theme_color: '#efe1cc',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // "Open with Letoplex" for book files (installed app, Chromium). .gab is the pre-rename extension.
        file_handlers: [{ action: './', accept: { 'application/x-letoplex-book': ['.letoplex', '.gab'] } }],
        // Lets Android's share sheet send a book (or a link to one) to the app.
        share_target: {
          action: './share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'book',
                accept: ['.letoplex', '.gab', '.zip', 'application/x-letoplex-book', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
              },
            ],
          },
        },
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
})
