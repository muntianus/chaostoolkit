import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { ChaosRunner } from './runner.js';

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error(`Invalid JSON request body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function health(req, res) {
  return sendJson(res, 200, {
    status: 'ok',
    service: 'perfops-chaostoolkit',
    version: '1.0.0',
  });
}

function listExperiments(req, res, url, { runner }) {
  const experiments = runner.listExperiments();
  return sendJson(res, 200, {
    count: experiments.length,
    experiments,
  });
}

async function runExperiment(req, res, url, { runner }) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (parseErr) {
    return sendJson(res, 400, { error: parseErr.message });
  }

  const experimentId = body.experiment_id || body.experimentId || body.id;
  const customExperiment = body.experiment;
  // Real injection is the default; callers must opt into simulation.
  const mode = body.mode || (body.dry_run === true ? 'dry_run' : 'live_probe');
  const overrides = body.overrides || {};

  if (!experimentId && !customExperiment) {
    return sendJson(res, 400, {
      error: "Missing 'experiment_id' or inline 'experiment' definition in request body.",
    });
  }

  try {
    const report = await runner.runExperiment({
      experimentId,
      experiment: customExperiment,
      mode,
      overrides,
    });
    return sendJson(res, 200, report);
  } catch (runErr) {
    const status = runErr.code === 'EXPERIMENT_NOT_FOUND' ? 404 : 400;
    return sendJson(res, status, { error: runErr.message, code: runErr.code || 'RUN_ERROR' });
  }
}

function listRuns(req, res, url, { runner }) {
  const runs = runner.listRuns();
  return sendJson(res, 200, {
    count: runs.length,
    runs,
  });
}

/**
 * Every route the service answers. Handlers get `(req, res, url, ctx)` where
 * ctx = { runner }. tests/openapi-contract.test.js keeps this table and
 * docs/api/openapi.json in lockstep.
 */
export const ROUTES = [
  { method: 'GET', path: '/health', handler: health },
  { method: 'GET', path: '/api/v1/experiments', handler: listExperiments },
  { method: 'POST', path: '/api/v1/experiments/run', handler: runExperiment },
  { method: 'GET', path: '/api/v1/runs', handler: listRuns },
];

export function createChaosServer(options = {}) {
  const runner = options.runner || new ChaosRunner(options);
  const ctx = { runner };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';

    try {
      const route = ROUTES.find((r) => r.method === method && r.path === url.pathname);
      if (route) {
        return await route.handler(req, res, url, ctx);
      }
      return sendJson(res, 404, {
        error: `Route ${method} ${url.pathname} not found`,
      });
    } catch (err) {
      return sendJson(res, 500, {
        error: err.message || 'Internal Server Error',
      });
    }
  });

  return { server, runner };
}

export function startServer(port = Number(process.env.PORT) || 4060, options = {}) {
  const { server, runner } = createChaosServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, runner, port: boundPort });
    });
  });
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const port = Number(process.env.PORT) || 4060;
  startServer(port).then(({ port: boundPort }) => {
    console.log(`[perfops-chaostoolkit] Resilience & Fault Injection Service listening on :${boundPort}`);
  });
}
