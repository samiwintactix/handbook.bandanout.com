// Vercel serverless entry point. An Express app is itself a valid Node.js
// request handler ((req, res) => {}), so no adapter is needed — vercel.json
// just routes every request here instead of to individual per-file functions.
import app from '../server.js';

export default app;
