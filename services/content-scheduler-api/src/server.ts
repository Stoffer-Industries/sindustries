import 'dotenv/config';
import { createApp } from './app.ts';
import { config, ConfigValidationError } from './config/env.ts';

const { PORT } = config;

function start() {
  const app = createApp();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[content-scheduler-api] listening on http://localhost:${PORT} (env=${config.NODE_ENV})`,
    );
  });
}

try {
  start();
} catch (err) {
  if (err instanceof ConfigValidationError) {
    // eslint-disable-next-line no-console
    console.error(`[content-scheduler-api] config error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
