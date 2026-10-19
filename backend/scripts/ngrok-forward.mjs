import { spawn } from 'node:child_process';

// Use the installed ngrok CLI rather than the native npm SDK. This avoids
// platform-specific node_modules conflicts when the workspace is shared by
// Windows and Linux containers.
const addr = process.env.NGROK_ADDR ?? `localhost:${process.env.PORT ?? '3000'}`;
const domain = process.env.NGROK_DOMAIN;
const executable = process.platform === 'win32' ? 'ngrok.exe' : 'ngrok';
const args = ['http', addr];
// ngrok 3.3.x uses --domain; newer examples sometimes show --url.
if (domain) args.push('--domain', domain);

const child = spawn(executable, args, { stdio: 'inherit', windowsHide: false });
child.once('error', error => {
  console.error(`Unable to start ${executable}. Install ngrok and run "ngrok config add-authtoken <token>" once.`, error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal !== 'SIGINT' && signal !== 'SIGTERM') process.exitCode = code ?? 1;
});
