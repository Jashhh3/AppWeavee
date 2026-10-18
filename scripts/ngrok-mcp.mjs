import ngrok from '@ngrok/ngrok';

const port = Number(process.env.APPWEAVE_PORT ?? 3000);
if (!process.env.NGROK_AUTHTOKEN) {
  console.error('Missing NGROK_AUTHTOKEN. Get it from https://dashboard.ngrok.com/get-started/your-authtoken and set it only in your local shell.');
  process.exit(1);
}

const listener = await ngrok.forward({ addr: port, authtoken_from_env: true });
const publicUrl = listener.url();
console.log(`AppWeave is expected at http://localhost:${port}`);
console.log(`Public AppWeave URL: ${publicUrl}`);
console.log(`Public MCP URL: ${publicUrl}/mcp`);
console.log('Press Ctrl+C to stop the tunnel.');

const shutdown = async () => {
  await listener.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await new Promise(() => {});
