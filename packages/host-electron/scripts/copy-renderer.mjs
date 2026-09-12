// Copy the built web bundle next to the compiled main process so the packaged
// app carries its own UI. Node's fs.cp keeps this working on Windows runners.
import { cp, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../ui/dist');
const target = resolve(here, '../renderer');

try {
  await stat(source);
} catch {
  console.error(
    `Web bundle not found at ${source}\nRun: pnpm --filter @dfh/ui build`,
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`Copied renderer bundle -> ${target}`);
