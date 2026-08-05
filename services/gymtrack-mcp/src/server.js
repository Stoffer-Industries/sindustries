import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp({ config });

app.listen(config.port, '0.0.0.0', () => {
  console.log(`gymtrack-mcp listening on 0.0.0.0:${config.port}`);
});
