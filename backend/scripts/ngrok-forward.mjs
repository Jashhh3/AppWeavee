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

const shutdown = async () => {
  await ngrok.disconnect();
  await ngrok.kill();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// Keep the tunnel process alive. Without an explicit wait, Node can exit after
// the SDK finishes creating the endpoint, which leaves the reserved URL offline.
await new Promise(() => {});
