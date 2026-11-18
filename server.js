// Local development server. On Vercel the /api/*.js files run as serverless functions
// and /public is served as static files, so this file is only used for `npm start`.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tts from './api/tts.js';
import llm from './api/llm.js';
import image from './api/image.js';
import config from './api/config.js';
import motion from './api/motion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '8mb' }));

app.all('/api/tts', tts);
app.all('/api/llm', llm);
app.all('/api/image', image);
app.all('/api/motion', motion);
app.get('/api/config', config);
app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AI Story Video Studio running at http://localhost:${port}`));
