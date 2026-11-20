import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply } from 'fastify';
import { config } from './config.js';
import { PortalError, pruneTraces, tracesDir } from './browser.js';
import { addison, downloadDocument, listDocuments, submitCode } from './portals/addison.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// --- Auth: alles außer /health braucht den Header x-api-key -------------------------------
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return;
  const given = Buffer.from(String(request.headers['x-api-key'] ?? ''));
  const expected = Buffer.from(config.apiToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return reply.code(401).send({ status: 'error', code: 'UNAUTHORIZED' });
  }
});

// --- Einheitliche Fehlerantwort (inkl. Trace-Datei zum Debuggen) --------------------------
app.setErrorHandler((error, request, reply) => {
  const err = error as Error & Partial<PortalError> & { statusCode?: number };
  const status = err instanceof PortalError ? err.status : (err.statusCode ?? 500);
  request.log.error({ err, trace: err.trace }, err.message);
  return reply.code(status).send({
    status: 'error',
    code: err.code ?? 'INTERNAL_ERROR',
    message: err.message.replace(/\u001b\[\d+m/g, ''),
    trace: err.trace ?? null,
    page: err.page ?? null,
  });
});

type FileResult = { status: 'file'; filename: string; content: Buffer };

function sendResult(reply: FastifyReply, result: object | FileResult) {
  if ('status' in result && result.status === 'file') {
    const file = result as FileResult;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`)
      .header('x-filename', encodeURIComponent(file.filename))
      .send(file.content);
  }
  return reply.send(result);
}

app.get('/health', async () => ({ status: 'ok' }));

// --- ADDISON ------------------------------------------------------------------------------
app.post('/addison/documents', async (_request, reply) => sendResult(reply, await listDocuments()));

app.post<{ Body: { name?: string } }>('/addison/download', async (request, reply) => {
  const name = request.body?.name?.trim();
  if (!name) throw new PortalError('Feld "name" fehlt', 400, 'BAD_REQUEST');
  return sendResult(reply, await downloadDocument(name));
});

app.post<{ Body: { code?: string } }>('/addison/2fa', async (request, reply) => {
  const code = String(request.body?.code ?? '').trim();
  if (!/^\d{4,8}$/.test(code)) throw new PortalError('Feld "code" fehlt oder ungültig', 400, 'BAD_REQUEST');
  return sendResult(reply, await submitCode(code));
});

// --- Traces: Liste + Download, ansehen mit `npx playwright show-trace <datei>` --------------
app.get('/traces', async () => {
  const files = (await fs.readdir(tracesDir()).catch(() => [] as string[])).sort().reverse();
  return { traces: files };
});

app.get<{ Params: { file: string } }>('/traces/:file', async (request, reply) => {
  const file = path.basename(request.params.file);
  const content = await fs.readFile(path.join(tracesDir(), file)).catch(() => undefined);
  if (!content) throw new PortalError('Trace nicht gefunden', 404, 'NOT_FOUND');
  return reply
    .header('content-type', 'application/zip')
    .header('content-disposition', `attachment; filename="${file}"`)
    .send(content);
});

// --- Start / Stop --------------------------------------------------------------------------
await pruneTraces();
await app.listen({ host: '0.0.0.0', port: config.port });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await addison.close();
    await app.close();
    process.exit(0);
  });
}
