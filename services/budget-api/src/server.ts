import 'dotenv/config';
import { createApp } from './app';

const port = Number(process.env.PORT || 4002);

const app = createApp();

app.listen(port, () => {
  console.log(`budget-api listening on http://localhost:${port}`);
});

