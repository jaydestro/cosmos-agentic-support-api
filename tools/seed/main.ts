import { runSeedCommand } from './command.ts';

process.exitCode = await runSeedCommand(process.argv.slice(2), process.env, {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
});
