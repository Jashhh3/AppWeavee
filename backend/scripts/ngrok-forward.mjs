import 'dotenv/config';
import ngrok from '@ngrok/ngrok';

const addr = process.env.NGROK_ADDR ?? `localhost:${process.env.PORT ?? '3000'}`;
const domain = process.env.NGROK_DOMAIN;

if (!process.env.NGROK_AUTHTOKEN && process.env.NGROK_AUTHTOKEN_FROM_ENV !== 'false') {
  throw new Error('Set NGROK_AUTHTOKEN in backend/.env or configure ngrok globally before starting the tunnel.');
}

const forwarder = await ngrok.forward({
  addr,
  authtoken: process.env.NGROK_AUTHTOKEN,
  ...(domain ? { domain } : {}),
});

console.log(`AppWeave is available at ${forwarder.url()}`);
console.log(`MCP endpoint: ${forwarder.url()}/mcp`);
console.log('Press Ctrl+C to stop the tunnel.');

const keepAlive = setInterval(() => {}, 60_000);

const shutdown = async () => {
  clearInterval(keepAlive);
  await ngrok.disconnect();
  await ngrok.kill();
  process.exit(0);
};

// Keep the tunnel process alive. Node 24 exits on an indefinitely pending
// top-level await, so use a real event-loop handle instead.
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
