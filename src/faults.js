import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

export const SAFE_INJECTIONS = Object.freeze(['http_latency', 'http_error', 'process_kill']);

// Owned production domains are denied even if someone adds them to the
// allowlist. Local/CI tests must never inject into live PerfOps services.
export const DEFAULT_DENIED_HOSTS = Object.freeze([
  'globlex.pro',
  'perfops.tech',
  'perfops.shop',
]);

const DEFAULT_SCRIPT_ROOTS = [
  path.join(REPO_ROOT, 'demo'),
  path.join(REPO_ROOT, 'tests', 'fixtures'),
];

export class TargetGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TargetGuardError';
    this.code = 'TARGET_NOT_ALLOWED';
    this.details = details;
  }
}

export class ScriptGuardError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ScriptGuardError';
    this.code = 'SCRIPT_NOT_ALLOWED';
    this.details = details;
  }
}

/**
 * Parses a comma/space separated allowlist (used for CHAOS_ALLOWED_HOSTS).
 * Only explicit hostnames are honoured; wildcards must start with "*.".
 */
export function parseAllowedHosts(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return list.map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function normalizeHost(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

export function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host.split('.').every((octet) => Number(octet) <= 255);
  }
  return false;
}

function matchAllowlist(host, allowedHosts) {
  return allowedHosts.some((entry) => {
    const pattern = normalizeHost(entry);
    if (!pattern) return false;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.test"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function matchDenylist(host, deniedHosts) {
  return deniedHosts.some((entry) => {
    const pattern = normalizeHost(entry);
    if (!pattern) return false;
    return host === pattern || host.endsWith(`.${pattern}`);
  });
}

/**
 * Rejects any real fault-injection target that is not loopback or explicitly
 * allowlisted. Production domains are never injected even when a custom
 * experiment (or API caller) asks for them.
 */
export function assertLocalTarget(
  target,
  { allowedHosts = [], deniedHosts = DEFAULT_DENIED_HOSTS } = {},
) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new TargetGuardError('Fault-injection target URL is required.');
  }

  let url;
  try {
    url = new URL(target);
  } catch {
    throw new TargetGuardError(`Fault-injection target '${target}' is not a valid URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TargetGuardError(
      `Fault-injection target protocol '${url.protocol}' is not allowed (http/https only).`,
      { target: url.href },
    );
  }

  if (url.username || url.password) {
    throw new TargetGuardError('Fault-injection target must not contain credentials.', {
      target: url.href,
    });
  }

  const host = normalizeHost(url.hostname);
  const denied = parseAllowedHosts(deniedHosts);
  if (matchDenylist(host, denied)) {
    throw new TargetGuardError(
      `Refusing real fault injection against production domain '${url.origin}'.`,
      { target: url.href, host, denied_hosts: denied },
    );
  }

  if (isLoopbackHost(host)) {
    return { url, host, reason: 'loopback' };
  }

  const allowlist = parseAllowedHosts(allowedHosts);
  if (matchAllowlist(host, allowlist)) {
    return { url, host, reason: 'allowlist' };
  }

  throw new TargetGuardError(
    `Refusing real fault injection against '${url.origin}': only localhost/allowlist targets are allowed.`,
    { target: url.href, host, allowed_hosts: allowlist },
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function round(value, precision = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function summarizeLatencies(values) {
  if (!values.length) {
    return { avg_ms: null, median_ms: null, p95_ms: null, min_ms: null, max_ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const avg = sorted.reduce((acc, value) => acc + value, 0) / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  return {
    avg_ms: round(avg),
    median_ms: round(median),
    p95_ms: round(p95),
    min_ms: round(sorted[0]),
    max_ms: round(sorted[sorted.length - 1]),
  };
}

async function probeOnce(url, { timeoutMs, fetchImpl }) {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'x-chaos-probe': '1' },
    });
    if (typeof response.arrayBuffer === 'function') {
      await response.arrayBuffer();
    }
    return {
      ok: true,
      status: response.status,
      latency_ms: round(performance.now() - start),
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      latency_ms: round(performance.now() - start),
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Measures an endpoint with a discarded warm-up request followed by N samples.
 */
export async function probeEndpoint(
  url,
  { samples = 5, timeoutMs = 2500, fetchImpl = globalThis.fetch } = {},
) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to probe endpoints.');
  }

  await probeOnce(url, { timeoutMs, fetchImpl });

  const latencies = [];
  const statuses = [];
  const errors = [];
  for (let i = 0; i < samples; i += 1) {
    const result = await probeOnce(url, { timeoutMs, fetchImpl });
    if (result.ok) {
      latencies.push(result.latency_ms);
      statuses.push(result.status);
    } else {
      errors.push(result.error);
    }
  }

  return {
    url,
    samples,
    ...summarizeLatencies(latencies),
    statuses,
    errors,
  };
}

function filterRequestHeaders(headers, targetHost) {
  const filtered = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(lower)
    ) {
      continue;
    }
    filtered[key] = value;
  }
  filtered.host = targetHost;
  return filtered;
}

/**
 * In-process HTTP fault proxy. It forwards requests to a guarded target and
 * can add latency, return 5xx responses, or simulate a socket timeout.
 */
export class FaultProxy {
  constructor(targetUrl, { latencyMs = 0, jitterMs = 0, errorStatus = null, timeoutMs = null } = {}) {
    this.target = new URL(targetUrl);
    this.latencyMs = latencyMs;
    this.jitterMs = jitterMs;
    this.errorStatus = errorStatus;
    this.timeoutMs = timeoutMs;
    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.pendingTimers = new Set();
    this.stats = {
      requests: 0,
      proxied: 0,
      injected_errors: 0,
      timeouts: 0,
      forward_errors: 0,
      latencies_ms: [],
    };
  }

  get url() {
    return this.server ? `http://127.0.0.1:${this.port}` : null;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'fault_proxy_internal_error' }));
      });
    });

    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });

    return this;
  }

  #delayMs() {
    const jitter =
      this.jitterMs > 0 ? Math.floor(Math.random() * (this.jitterMs * 2 + 1)) - this.jitterMs : 0;
    return Math.max(0, this.latencyMs + jitter);
  }

  async #handle(req, res) {
    const started = performance.now();
    this.stats.requests += 1;

    if (this.timeoutMs !== null) {
      this.stats.timeouts += 1;
      const timer = setTimeout(() => {
        this.pendingTimers.delete(timer);
        req.destroy();
        res.destroy();
      }, this.timeoutMs);
      this.pendingTimers.add(timer);
      return;
    }

    const delay = this.#delayMs();
    if (delay > 0) await sleep(delay);

    if (this.errorStatus !== null) {
      this.stats.injected_errors += 1;
      const body = JSON.stringify({
        error: 'injected_fault',
        fault: 'http_error',
        status: this.errorStatus,
      });
      res.writeHead(this.errorStatus, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-chaos-fault': 'http_error',
      });
      res.end(body);
      this.#recordLatency(started);
      return;
    }

    await this.#forward(req, res, started);
  }

  #forward(req, res, started) {
    return new Promise((resolve) => {
      const client = this.target.protocol === 'https:' ? https : http;
      const upstream = client.request(
        {
          protocol: this.target.protocol,
          hostname: this.target.hostname,
          port: this.target.port || undefined,
          method: req.method,
          path: req.url,
          headers: filterRequestHeaders(req.headers, this.target.host),
        },
        (upstreamRes) => {
          this.stats.proxied += 1;
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          upstreamRes.on('end', () => this.#recordLatency(started));
        },
      );

      const upstreamTimeout = setTimeout(() => {
        upstream.destroy(new Error('upstream_timeout'));
      }, 5000);

      upstream.on('error', (err) => {
        this.stats.forward_errors += 1;
        if (!res.headersSent) {
          const body = JSON.stringify({ error: 'upstream_unreachable', message: err.message });
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(body);
        } else {
          res.destroy();
        }
        resolve();
      });

      upstream.on('close', () => {
        clearTimeout(upstreamTimeout);
        this.#recordLatency(started);
        resolve();
      });

      req.pipe(upstream);
    });
  }

  #recordLatency(started) {
    this.stats.latencies_ms.push(round(performance.now() - started));
    if (this.stats.latencies_ms.length > 1000) this.stats.latencies_ms.shift();
  }

  summary() {
    const { latencies_ms: latencies, ...counters } = this.stats;
    return { ...counters, ...summarizeLatencies(latencies) };
  }

  async close() {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    if (this.server) {
      const server = this.server;
      this.server = null;
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
}

/**
 * Starts a latency proxy, measures baseline vs injected latency, and closes it.
 * The returned object is safe to expose in the experiment journal.
 */
export async function injectHttpLatency({
  targetUrl,
  latencyMs = 100,
  jitterMs = 0,
  samples = 5,
  timeoutMs = 2500,
  fetchImpl = globalThis.fetch,
  allowedHosts = [],
} = {}) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error('http_latency requires a non-negative latency_ms value.');
  }
  if (!Number.isFinite(jitterMs) || jitterMs < 0) {
    throw new Error('http_latency jitter_ms must be a non-negative number.');
  }

  const guarded = assertLocalTarget(targetUrl, { allowedHosts });
  const target = guarded.url;
  const baseline = await probeEndpoint(target.href, { samples, timeoutMs, fetchImpl });
  if (baseline.errors.length === samples || !baseline.statuses.some((status) => status < 500)) {
    throw new Error(
      `http_latency baseline probe failed for ${target.href}: target must answer successfully before fault injection.`,
    );
  }

  const proxy = new FaultProxy(target.origin, { latencyMs, jitterMs });
  try {
    await proxy.start();
    const proxiedUrl = new URL(target.pathname + target.search, proxy.url);
    const injected = await probeEndpoint(proxiedUrl.href, {
      samples,
      timeoutMs: timeoutMs + latencyMs + jitterMs + 500,
      fetchImpl,
    });

    const delta =
      baseline.median_ms !== null && injected.median_ms !== null
        ? Math.round(injected.median_ms - baseline.median_ms)
        : null;

    return {
      injection: 'http_latency',
      target_url: target.href,
      target_host: guarded.host,
      target_guard: guarded.reason,
      proxy_url: proxy.url,
      configured_latency_ms: latencyMs,
      jitter_ms: jitterMs,
      baseline_latency_ms: baseline.median_ms,
      injected_latency_ms: injected.median_ms,
      latency_delta_ms: delta,
      baseline_samples: baseline.samples,
      injected_samples: injected.samples,
      statuses: injected.statuses,
      errors: injected.errors,
      proxy_stats: proxy.summary(),
      network_touched: true,
      observed_deviation: delta !== null && delta > 0,
    };
  } finally {
    await proxy.close();
  }
}

/**
 * Starts an HTTP fault proxy that returns 5xx responses or simulates timeouts.
 */
export async function injectHttpError({
  targetUrl,
  statusCode = 503,
  errorMode = 'status',
  timeoutMs = 300,
  samples = 5,
  fetchImpl = globalThis.fetch,
  allowedHosts = [],
} = {}) {
  if (!['status', 'timeout'].includes(errorMode)) {
    throw new Error("http_error error_mode must be 'status' or 'timeout'.");
  }
  if (errorMode === 'status' && (!Number.isInteger(statusCode) || statusCode < 500 || statusCode > 599)) {
    throw new Error('http_error status_code must be an integer in the 500-599 range.');
  }
  if (errorMode === 'timeout' && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('http_error timeout_ms must be a positive number for timeout mode.');
  }

  const guarded = assertLocalTarget(targetUrl, { allowedHosts });
  const target = guarded.url;
  const baseline = await probeEndpoint(target.href, {
    samples,
    timeoutMs: 2500,
    fetchImpl,
  });
  const baselineHealthy = baseline.statuses.some((status) => status < 500);
  if (baseline.errors.length === samples || !baselineHealthy) {
    throw new Error(
      `http_error baseline probe failed for ${target.href}: target must answer successfully before fault injection.`,
    );
  }

  const proxy = new FaultProxy(target.origin, {
    errorStatus: errorMode === 'status' ? statusCode : null,
    timeoutMs: errorMode === 'timeout' ? timeoutMs : null,
  });
  try {
    await proxy.start();
    const proxiedUrl = new URL(target.pathname + target.search, proxy.url);
    const injected = await probeEndpoint(proxiedUrl.href, {
      samples,
      timeoutMs: errorMode === 'timeout' ? timeoutMs + 250 : 2500,
      fetchImpl,
    });

    const failed =
      injected.statuses.filter((status) => status >= 500).length + injected.errors.length;
    const errorRate = samples > 0 ? failed / samples : 0;

    return {
      injection: 'http_error',
      target_url: target.href,
      target_host: guarded.host,
      target_guard: guarded.reason,
      proxy_url: proxy.url,
      error_mode: errorMode,
      status_code: errorMode === 'status' ? statusCode : null,
      timeout_ms: errorMode === 'timeout' ? timeoutMs : null,
      baseline_statuses: baseline.statuses,
      statuses: injected.statuses,
      errors: injected.errors,
      samples_injected: samples,
      failed_samples: failed,
      error_rate: round(errorRate, 3),
      proxy_stats: proxy.summary(),
      network_touched: true,
      observed_deviation: errorRate > 0,
    };
  } finally {
    await proxy.close();
  }
}

function resolveDemoScript(script, scriptRoots = DEFAULT_SCRIPT_ROOTS) {
  if (typeof script !== 'string' || script.trim() === '') {
    throw new ScriptGuardError('process_kill requires a relative script path.');
  }

  const absolute = path.isAbsolute(script) ? script : path.resolve(REPO_ROOT, script);
  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch {
    throw new ScriptGuardError(`process_kill script '${script}' does not exist.`);
  }

  for (const root of scriptRoots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    const relative = path.relative(realRoot, real);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return { real, relative_to_repo: path.relative(REPO_ROOT, real) };
    }
  }

  throw new ScriptGuardError(
    `process_kill script '${script}' is outside the allowed demo directories.`,
    { allowed_roots: scriptRoots.map((root) => path.relative(REPO_ROOT, root)) },
  );
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(null);
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function waitForMarker(getBuffer, marker, timeoutMs, isExited) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getBuffer().includes(marker)) return true;
    if (isExited()) return false;
    await sleep(25);
  }
  return getBuffer().includes(marker);
}

/**
 * Spawns a repository-local demo script and terminates it with SIGTERM
 * (SIGKILL fallback). It never signals processes it did not spawn.
 */
export async function killDemoProcess({
  script,
  args = [],
  graceMs = 2000,
  runMs = 250,
  waitForStdout = 'READY',
  startupTimeoutMs = 3000,
  scriptRoots = DEFAULT_SCRIPT_ROOTS,
} = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('process_kill args must be an array of strings.');
  }
  if (args.length > 32) {
    throw new Error('process_kill accepts at most 32 arguments.');
  }

  const resolved = resolveDemoScript(script, scriptRoots);
  const child = spawn(process.execPath, [resolved.real, ...args], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CHAOS_DEMO_PROCESS: '1' },
  });

  let stdout = '';
  let stderr = '';
  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  const append = (current, chunk) => {
    const next = current + chunk.toString('utf8');
    return next.length > 65536 ? next.slice(-65536) : next;
  };
  child.stdout?.on('data', (chunk) => {
    stdout = append(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = append(stderr, chunk);
  });

  const started = Date.now();
  let ready = false;
  try {
    if (waitForStdout) {
      ready = await waitForMarker(() => stdout, waitForStdout, startupTimeoutMs, () => exited);
      if (exited) {
        throw new Error(
          `process_kill demo process exited before injection: ${(stderr || stdout).trim().slice(-500)}`,
        );
      }
    } else {
      await sleep(runMs);
      if (exited) {
        throw new Error('process_kill demo process exited before injection.');
      }
    }

    const pid = child.pid;
    const signalSent = child.kill('SIGTERM');
    let exit = await Promise.race([exitPromise, sleep(graceMs).then(() => null)]);
    let forcedKill = false;

    if (exit === null) {
      forcedKill = child.kill('SIGKILL');
      exit = await Promise.race([exitPromise, sleep(1000).then(() => null)]);
    }
    if (exit === null) {
      throw new Error(`process_kill could not terminate demo process pid=${pid}.`);
    }

    return {
      injection: 'process_kill',
      script: resolved.relative_to_repo,
      args,
      pid,
      ready,
      signal: 'SIGTERM',
      signal_sent: signalSent,
      forced_kill: forcedKill,
      exited: true,
      exit_code: exit.code,
      exit_signal: exit.signal,
      lifetime_ms: Date.now() - started,
      stdout_tail: stdout.slice(-1000),
      stderr_tail: stderr.slice(-1000),
      process_touched: true,
      observed_deviation: true,
    };
  } finally {
    if (!exited) {
      child.kill('SIGKILL');
      await Promise.race([exitPromise, sleep(1000)]);
    }
  }
}

/**
 * Checks whether a real injection produced the metric deviation declared by
 * the experiment. Without this check an experiment could "pass" even when
 * the fault was a no-op.
 */
export function evaluateExpectedEffect(expected, output = {}) {
  if (!expected || !expected.metric) {
    return { verified: true, reason: 'no expected_effect declared' };
  }

  const actual = output[expected.metric];
  const missing = actual === undefined || actual === null;

  if (expected.equals !== undefined) {
    const verified = !missing && actual === expected.equals;
    return {
      verified,
      metric: expected.metric,
      actual,
      expected: expected.equals,
      reason: verified
        ? `${expected.metric} equals ${expected.equals}`
        : `${expected.metric} was ${actual}, expected ${expected.equals}`,
    };
  }

  if (expected.min !== undefined || expected.max !== undefined) {
    const numeric = Number(actual);
    const valid = !missing && Number.isFinite(numeric);
    const minOk = expected.min === undefined || numeric >= expected.min;
    const maxOk = expected.max === undefined || numeric <= expected.max;
    const verified = valid && minOk && maxOk;
    return {
      verified,
      metric: expected.metric,
      actual,
      min: expected.min,
      max: expected.max,
      reason: verified
        ? `${expected.metric}=${actual} within expected bounds`
        : `${expected.metric}=${actual} did not reach expected bounds [${expected.min ?? '-inf'}, ${expected.max ?? '+inf'}]`,
    };
  }

  const verified = !missing && Boolean(actual);
  return {
    verified,
    metric: expected.metric,
    actual,
    reason: verified
      ? `${expected.metric} is truthy`
      : `${expected.metric} was ${actual}, expected a truthy value`,
  };
}
