#!/usr/bin/env node
import { ChaosRunner } from './runner.js';

function usage() {
  console.error(
    [
      'Usage: node src/cli.js --experiment <id> [--dry-run]',
      '       node src/cli.js --list',
      '',
      'Real fault injection is the default. --dry-run restores the legacy',
      'simulated behaviour and never touches the network.',
      '',
      'Safety: injection targets must be loopback or listed in CHAOS_ALLOWED_HOSTS.',
    ].join('\n'),
  );
}

function readFlag(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : true;
}

const args = process.argv.slice(2);
const runner = new ChaosRunner();

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (args.includes('--list')) {
  console.log(JSON.stringify(runner.listExperiments(), null, 2));
  process.exit(0);
}

const experimentId = readFlag(args, '--experiment') || readFlag(args, '-e');
if (!experimentId || experimentId === true) {
  usage();
  process.exit(2);
}

const mode = args.includes('--dry-run') ? 'dry_run' : 'live_probe';

try {
  const report = await runner.runExperiment({ experimentId, mode });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.launchgate_report.recommendation === 'PASS' ? 0 : 1;
} catch (err) {
  console.error(`chaos run failed: ${err.message}`);
  process.exitCode = 1;
}
