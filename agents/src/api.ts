import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CharacterError, type CharacterRegistry } from './registry.js';

export async function startApi(registry: CharacterRegistry, token: string, port: number, status: () => object = () => ({ status: 'ok' })): Promise<Server> {
  if (token.length < 32) throw new Error('Gateway bearer token must contain at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    const send = (code: number, body: unknown) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.url === '/healthz' && request.method === 'GET') { send(200, status()); return; }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(401, { error: 'unauthorized' }); return; }
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const match = /^\/v1\/characters(?:\/([a-z0-9-]+)(?:\/(messages|mentions))?)?$/.exec(url.pathname);
      if (!match) throw new CharacterError('not_found', 404);
      const [, id, action] = match;
      let body: unknown = {};
      if (request.method !== 'GET') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) {
          size += chunk.length; if (size > 32 * 1024) throw new CharacterError('invalid'); chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CharacterError('invalid'); }
      }
      if (!id && request.method === 'GET') send(200, { characters: registry.list() });
      else if (!id && request.method === 'POST') send(201, await registry.create(body));
      else if (id && !action && request.method === 'PATCH') send(200, await registry.edit(id, body));
      else if (id && !action && request.method === 'DELETE') send(200, await registry.delete(id, body));
      else if (id && action === 'messages' && request.method === 'POST') send(200, await registry.say(id, body));
      else if (id && action === 'mentions' && request.method === 'GET') send(200, registry.mentions(id, { actorDiscordId: url.searchParams.get('actorDiscordId'), ...(url.searchParams.has('after') ? { after: url.searchParams.get('after') } : {}) }));
      else throw new CharacterError('not_found', 404);
    } catch (error) {
      if (error instanceof CharacterError) send(error.status, { error: error.code });
      else send(500, { error: 'delivery_failed' });
    }
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
