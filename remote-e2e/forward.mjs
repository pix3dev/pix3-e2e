// A TCP forwarder standing in for ssh: `node forward.mjs <from>:<host>:<to> …` listens on
// 127.0.0.1:<from> and pipes every connection to <host>:<to>. A child process of run.mjs, whose
// own event loop blocks in spawnSync while a `pix3` command runs. Prints "ready" once listening.
import { connect, createServer } from 'node:net';

let pending = process.argv.length - 2;
for (const spec of process.argv.slice(2)) {
  const [from, host, to] = spec.split(':');
  const server = createServer(client => {
    const upstream = connect({ host, port: Number(to) });
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', end).on('close', end);
    upstream.on('error', end).on('close', end);
  });
  server.listen(Number(from), '127.0.0.1', () => {
    if (--pending === 0) console.log('ready');
  });
}
