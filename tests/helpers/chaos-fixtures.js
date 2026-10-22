import http from 'node:http';

/**
 * Loopback HTTP target for fault-injection tests. Every request it receives is
 * recorded in `requests`, so tests can prove that nothing touched the network.
 */
export async function startLocalTarget() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/health') {
      const body = JSON.stringify({ status: 'ok' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function localExperiment(targetUrl, method = []) {
  return {
    id: 'local-fault-injection',
    title: 'Local fault injection steady-state check',
    'steady-state-hypothesis': {
      title: 'Local target answers HTTP 200',
      probes: [
        {
          type: 'probe',
          name: 'local-health',
          tolerance: { type: 'status', status: 200, max_latency_ms: 1500 },
          provider: {
            type: 'http',
            url: `${targetUrl}/health`,
            method: 'GET',
            timeout: 1500,
            simulation: {
              before: { status: 200, latency_ms: 5 },
              after: { status: 200, latency_ms: 5 },
            },
          },
        },
      ],
    },
    method,
    rollbacks: [],
  };
}

export function latencyAction(targetUrl, latencyMs, extra = {}) {
  return {
    type: 'action',
    name: `inject-latency-${latencyMs}ms`,
    provider: {
      type: 'fault_injection',
      func: 'http_latency',
      arguments: {
        target_url: `${targetUrl}/health`,
        latency_ms: latencyMs,
        samples: 3,
        ...extra,
      },
    },
  };
}
