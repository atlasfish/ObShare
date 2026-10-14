import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

await build({
    entryPoints: ['tests/preprocessor.test.ts', 'tests/document-sync.test.ts'],
    outdir: '.test-build',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [{ name: 'obsidian-mock', setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: fileURLToPath(new URL('../tests/obsidian-mock.ts', import.meta.url)) }));
    }}]
});
const result = spawnSync(process.execPath, ['--test', '.test-build/preprocessor.test.cjs', '.test-build/document-sync.test.cjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
