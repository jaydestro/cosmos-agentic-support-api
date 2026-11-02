import { pathToFileURL } from 'node:url';
import { CliError, HELP, parseArgs } from './args.ts';
import { runJourney, type JourneyDependencies } from './journey.ts';
import { createDemoClient, type TransportDependencies } from './transport.ts';

export interface CliDependencies extends TransportDependencies {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly now?: JourneyDependencies['now'];
  readonly sleep?: JourneyDependencies['sleep'];
}

/** Only this top-level failure boundary catches unknown errors, never logging their potentially sensitive text. */
export async function runCli(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  try {
    const command = parseArgs(args);
    if (command.command === 'help') {
      dependencies.out(HELP);
      return 0;
    }
    return await runJourney(command, createDemoClient(command, dependencies), {
      emit: (value) => { dependencies.out(`${JSON.stringify(value)}\n`); },
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.sleep === undefined ? {} : { sleep: dependencies.sleep }),
    });
  } catch (error) {
    if (error instanceof CliError) {
      dependencies.err(`${JSON.stringify({ event: 'error', code: error.code, message: error.message })}\n`);
    } else {
      dependencies.err(`${JSON.stringify({
        event: 'error', code: 'request_failed',
        message: 'Authentication, network or response processing failed. Sensitive diagnostics omitted; inspect the existing case before retrying a mutation.',
      })}\n`);
    }
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    out: (text) => { process.stdout.write(text); },
    err: (text) => { process.stderr.write(text); },
  });
}
