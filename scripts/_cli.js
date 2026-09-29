// Shared CLI harness for script modules (zero third-party dependencies).
// Every script is dual-form: importable by index.js as
// main(argv) -> { exitCode, stdout, stderr }, and directly runnable via
// `node scripts/<name>.js`.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** True when the module identified by metaUrl is the CLI entry point. */
export function isMain(metaUrl) {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(metaUrl) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

/** Run main(argv) as a CLI: mirror stdout/stderr, set the exit code. */
export function runMain(main) {
  const { exitCode = 0, stdout = '', stderr = '' } = main(process.argv.slice(2))
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`)
  if (stderr) process.stderr.write(stderr.endsWith('\n') ? stderr : `${stderr}\n`)
  process.exitCode = exitCode
}
