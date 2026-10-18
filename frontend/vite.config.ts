import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // Tests always run against the in-browser mock API, whatever .env says.
    env: { VITE_USE_MOCK: 'true', VITE_MOCK_LATENCY_MS: '0' },
  },
});
