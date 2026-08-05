/**
 * `/core` must stay free of runtime dependencies: importing a typed error should not
 * load the Anthropic SDK. Walks the built module graph and fails on any bare specifier
 * that is not a node: builtin.
 */
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

const ENTRY = resolve('dist/core/index.js');

// esbuild emits one import per line, so anchoring keeps string literals out of the match.
const FROM = /^\s*(?:import|export)\b.*?\bfrom\s*['"]([^'"]+)['"];?\s*$/gm;
const SIDE_EFFECT = /^\s*import\s*['"]([^'"]+)['"];?\s*$/gm;
// Any line carrying a module specifier. If the two patterns above do not account for
// every one of these, the walk is skipping imports and a green result means nothing.
const SPECIFIER = /\bfrom\s*['"]|^\s*import\s*['"]/;

const visited = new Set();
const offenders = [];

async function walk(file) {
  if (visited.has(file)) return;
  visited.add(file);

  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    console.error(`cannot read ${relative(process.cwd(), file)}; run \`pnpm build\` first`);
    process.exit(1);
  }

  let matched = 0;
  for (const pattern of [FROM, SIDE_EFFECT]) {
    for (const [, spec] of source.matchAll(pattern)) {
      matched += 1;
      if (spec.startsWith('.')) await walk(resolve(dirname(file), spec));
      else if (!spec.startsWith('node:')) offenders.push({ spec, file });
    }
  }

  const carrying = source.split('\n').filter((line) => SPECIFIER.test(line)).length;
  if (carrying !== matched) {
    console.error(
      `cannot parse ${relative(process.cwd(), file)}: ${carrying} lines carry a module ` +
        `specifier but ${matched} matched, so ${carrying - matched} would go unchecked.`,
    );
    process.exit(1);
  }
}

await walk(ENTRY);

if (offenders.length > 0) {
  const listed = offenders
    .map(({ spec, file }) => `  ${spec}  (imported by ${relative(process.cwd(), file)})`)
    .join('\n');
  console.error(
    `/core reaches ${offenders.length} runtime dependency/dependencies:\n${listed}\n\n` +
      'Everything /core re-exports is evaluated by every consumer that imports a typed\n' +
      'error. Move the symbol to the subpath that already owns the dependency (/runner),\n' +
      'or into a dependency-free module such as src/core/errors.ts.',
  );
  process.exit(1);
}

console.log(`/core is dependency-free (${visited.size} modules checked)`);
