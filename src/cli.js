#!/usr/bin/env node
import { ChaosRunner } from './runner.js';

function usage() {
  console.error(
    [
      'Usage: node src/cli.js --experiment <id> [--dry-run | --live]',
      '       node src/cli.js --list',
      '',
      'Dry-run is the default: the experiment is simulated and never touches the',
      'network or a child process. --live requests real fault injection and is',
      'refused (exit 3) unless CHAOS_LIVE_ENABLED=true is set in the environment.',
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

if (args.includes('--dry-run') && args.includes('--live')) {
  console.error('--dry-run and --live are mutually exclusive.');
  usage();
  process.exit(2);
}

// Simulation unless --live is passed; the runner then enforces CHAOS_LIVE_ENABLED.
const mode = args.includes('--live') ? 'live_probe' : 'dry_run';

try {
  const report = await runner.runExperiment({ experimentId, mode });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.launchgate_report.recommendation === 'PASS' ? 0 : 1;
} catch (err) {
  if (err.code === 'LIVE_MODE_DISABLED') {
    console.error(`chaos run refused [${err.code}]: ${err.message}`);
    process.exitCode = 3;
  } else {
    console.error(`chaos run failed: ${err.message}`);
    process.exitCode = 1;
  }
}
