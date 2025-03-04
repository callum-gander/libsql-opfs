import { defineConfig } from 'wxt';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

// See https://wxt.dev/api/config.html
export default defineConfig({
  extensionApi: 'chrome',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ browser, manifestVersion, mode, command }) => {
    return {
      name: 'LibSQL OPFS Example',  
      dev: {
        disableContentSecurityPolicy: true,
      },
      permissions: [
        'activeTab',
        'storage',
        'https://*/*',
        'http://*/*',
        'downloads',
        'notifications',
        'webRequest', // Add this
        'identity',
        'webNavigation',
        'unlimitedStorage',
      ],
      host_permissions: ['<all_urls>'],
      content_security_policy:
        manifestVersion === 2
          ? "script-src 'self' 'wasm-unsafe-eval' http://localhost:3000; object-src 'self'"
          : {
              extension_pages:
                "script-src 'self' 'wasm-unsafe-eval' http://localhost:3000; object-src 'self'; worker-src 'self' http://localhost:3000",
              sandbox: null,
            },
      web_accessible_resources: [
        {
          resources: [
            // this is the libsql one
            'workers/*',
            'assets/sqlite3.wasm',
          ],
          matches: ['<all_urls>'],
        },
      ],
    };
  },
  vite: () => ({
    plugins: [
      wasm(),
      // topLevelAwait(),
      {
        name: 'configure-server',
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            // Add required headers for Cross-Origin Isolation
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            next();
          });
        },
      },
      {
        name: 'sqlite-worker-handler',
        enforce: 'pre',
        resolveId(id, importer) {
          // Catch the OPFS async proxy worker request
          if (id.includes('sqlite3-opfs-async-proxy.js')) {
            return id;
          }
        },
        transform(code, id) {
          // Transform the OPFS worker to not use importScripts
          if (id.includes('sqlite3-opfs-async-proxy.js')) {
            return `
              self.importScripts = function() {}; // Mock importScripts
              ${code}
            `;
          }
        },
      },
    ],
    worker: {
      format: 'es',
      plugins: [wasm()],
      rollupOptions: {
        external: ['@vite/env'],
        output: {
          format: 'es',
        },
      },
      modulepreload: {
        polyfill: false,
      },
    },
    // optimizeDeps: {
    //   exclude: ['@vlcn.io/crsqlite-wasm/crsqlite.wasm', 'sqlocal'],
    // },
  }),
  hooks: {
    'build:publicAssets': (wxt, assets) => {
      // Add libsql WASM file
      const libsqlSourcePath = resolve(
        __dirname,
        'node_modules/@libsql/client-wasm/node_modules/@libsql/libsql-wasm-experimental/sqlite-wasm/jswasm/sqlite3.wasm'
      );
      const libsqlContents = readFileSync(libsqlSourcePath);

      assets.push({
        relativeDest: 'assets/sqlite3.wasm',
        contents: libsqlContents,
      });

      console.log('✅ Processed libsql WASM file');

      console.log('✅ Build complete');
    },
  },
});
