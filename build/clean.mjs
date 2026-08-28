// Empties the build's output directory.
//
// A script rather than a shell command in `package.json`, because npm runs
// scripts through `cmd.exe` on Windows and a POSIX `rm -rf` is not a command
// there. Node is the one interpreter every host this project builds on
// already has.
//
// `force` so a first build, with no `dist/` yet, is not an error.
import { rmSync } from 'node:fs';

const target = process.argv[2];
if (target === undefined) {
  throw new Error('usage: node build/clean.mjs <directory>');
}

rmSync(target, { recursive: true, force: true });
