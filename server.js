import { createApp } from './src/app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1'; // local prototype: loopback only unless told otherwise
const dbPath = process.env.DB_PATH ?? 'stickywall.db';

const { server, close } = createApp({ dbPath, log: (...a) => console.error('[stickywall]', ...a) });
server.listen(port, host, () => console.log(`stickywall on http://${host}:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (close(), process.exit(0)));
