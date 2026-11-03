import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// The React app lives in ui/ and builds to ui/dist, which server.js serves at /. `npm run dev:ui` proxies the API and
// demo media to the Node server on 4173.
export default defineConfig({
  root:'ui',
  plugins:[react()],
  build:{outDir:'dist', emptyOutDir:true},
  server:{port:5173, proxy:{'/api':'http://127.0.0.1:4173', '/demo-media':'http://127.0.0.1:4173'}}
});
