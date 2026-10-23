// Preloaded with `node --import` by the CLI tests. Replaces the global fetch so
// a CLI run can never reach a real network, and reports every attempt on
// stderr so the tests can prove whether the gate let a request through.
globalThis.fetch = async (url) => {
  process.stderr.write(`STUB_FETCH_CALLED ${url}\n`);
  return { status: 200 };
};
