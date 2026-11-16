import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Relative asset paths, so the build also works under a sub-path (as the housing app on the VM).
export default defineConfig({ base: './', plugins: [react()], server: { proxy: { '/api': 'http://127.0.0.1:8010' } } });
