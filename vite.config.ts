import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
const version=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version;
export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'development-csp',
    transformIndexHtml(html) {
      // React's development refresh preamble is inline. Production stays self-only.
      return command === 'serve' ? html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") : html;
    }
  }],
  define: { 'import.meta.env.VITE_ROOTPATH_VERSION': JSON.stringify(version) },
  base: './', server: { host: '127.0.0.1', port: 5173, strictPort: true }
}));
