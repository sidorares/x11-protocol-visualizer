// Hot reload (React Fast Refresh) for the TypeScript UI — the dev loop is
//
//   node --import tsx --import ./scripts/hot-register.mjs src/cli.ts
//
// react-x11's stock entry (`react-x11/refresh/register`) reads matched files
// straight from disk and its babel pass only knows JSX, so it cannot sit
// behind the tsx loader for .tsx sources. This is the seam its docs name for
// that case (docs/ecosystem/dev-tooling.md#react-refresh): host our own
// module hooks and use `createTransformer` for the Fast Refresh half.
//
// Pipeline per .tsx module: esbuild strips types and compiles JSX to the
// automatic runtime (matching the files' `@jsxRuntime automatic` pragma; the
// transformer's own classic-JSX pass then has no JSX left to touch, which
// sidesteps the automatic-runtime line-rewrite hazard its validator guards
// against) → react-refresh instruments the components → hot-module-replacement
// (registered last, outermost) rewrites imports into live bindings and
// watches the files.
//
// Only .tsx is hot: the proxy/decoder core and the UI's .ts helpers stay
// outside the graph, so the capture store and X11 connection keep their
// identity across reloads.
import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { createTransformer } from 'react-x11/refresh/loader';

const transformer = await createTransformer({ extensions: ['.tsx'] });

// Hot graph = src/ui only. The proxy/decoder core stays out: its module
// scopes run real work against named imports (which HMR would defer to a
// microtask), and its identity — capture store, ring buffers, the X11
// connection — must survive reloads.
const hotIgnore = (path) =>
  path.includes('/node_modules/') || !path.replaceAll('\\', '/').includes('/src/ui/');

nodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const fileUrl = new URL(url);
    fileUrl.search = ''; // hot-module-replacement cache-busts with ?hmr=N
    if (!transformer.matches(fileUrl.pathname)) return nextLoad(url, context);
    const filename = fileURLToPath(fileUrl);
    if (hotIgnore(filename)) return nextLoad(url, context);
    const stripped = transformSync(readFileSync(filename, 'utf8'), {
      loader: 'tsx',
      jsx: 'automatic',
      format: 'esm',
      target: 'esnext',
      sourcefile: filename,
    }).code;
    const { code } = transformer.transform(stripped, filename);
    return { format: 'module', source: code, shortCircuit: true };
  },
});

// Same wiring as react-x11/refresh/register: HMR registered second so its
// hooks run outermost and see plain, already-instrumented JS.
globalThis.__HMR_OPTIONS__ = { ignore: hotIgnore };
await import('hot-module-replacement/register');

const { onReload } = await import('react-x11/refresh');
onReload(({ urls }) => {
  process.stderr.write(`[hot] reloaded ${urls.map((u) => u.split('/').pop()).join(', ')}\n`);
});
