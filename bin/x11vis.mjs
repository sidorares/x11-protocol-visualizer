#!/usr/bin/env node
// Thin launcher: run the compiled CLI in this process.
//
// It used to spawn `node_modules/.bin/tsx` against `src/cli.ts`, which cannot
// work from a published tarball — `tsx` is a devDependency, so nothing
// installs it for a consumer, and npm would hoist it to a *sibling* of this
// package anyway rather than the `../node_modules` this path assumed. The
// package now ships `dist/`, so there is nothing to transpile and no child
// process to forward signals and exit codes through.
import '../dist/cli.js';
