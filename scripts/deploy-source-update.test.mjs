import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'web/package.json'));
const { parseDocument } = require('yaml');
const script = readFileSync(path.join(root, 'scripts/deploy-source-update.sh'), 'utf8');
const updater = script.split('cat > "$YAML_TMP" <<\'YAML\'\n')[1].split('\nYAML\n')[0].replace("require('/yaml')", `require(${JSON.stringify(require.resolve('yaml'))})`);

for (const foreign of [false, true]) test(foreign ? 'refuses to replace an unmanaged Python mount without changing Compose' : 'updates only listed Python mounts and preserves earlier runtime fixes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dreamyo-source-mounts-'));
    try {
        const compose = path.join(dir, 'compose.yml');
        const originalMount = `${foreign ? '/foreign' : '/fixture/.source-update/releases/old'}/app.py:/app/services/chatgpt-api/api/app.py:ro`;
        const retainedMount = '/fixture/.source-update/releases/old/account_service.py:/app/services/chatgpt-api/services/account_service.py:ro';
        const dataMount = '/fixture/data:/app/web/.data';
        const original = JSON.stringify({ services: {
            app: { environment: { DREAMYO_DATABASE_PROVIDER: 'postgres', DATABASE_URL: '${DATABASE_URL}' }, volumes: [dataMount, '/fixture/magic:/app/web/.magic-proxy-runtime', '/fixture/.source-update/releases/old/web:/app/web:ro'] },
            'generation-worker': { volumes: ['/fixture/.source-update/releases/old/web:/app/web:ro'] },
            'chatgpt-api': { volumes: [originalMount, retainedMount, dataMount] },
        } });
        writeFileSync(compose, original);
        const entry = path.join(dir, 'update.mjs'); writeFileSync(entry, updater);
        const list = path.join(dir, 'python.txt'); writeFileSync(list, 'services/chatgpt-api/api/app.py\n');
        const result = spawnSync(process.execPath, [entry, compose, '/fixture/.source-update/releases/new/web', '/fixture/.source-update/releases/new/web', list], { encoding: 'utf8', env: { ...process.env, SOURCE_UPDATE_EXPECTED_COMPOSE_HASH: '', APP_SERVICE: 'app', WORKER_SERVICE: 'generation-worker', GPTAPI_SERVICE: 'chatgpt-api', RELEASE_DIR: '/fixture/.source-update/releases/new', CACHE_DIR: '/fixture/cache' } });
        if (foreign) {
            assert.notEqual(result.status, 0); assert.match(result.stderr, /拒绝覆盖非本脚本管理的 mount/); assert.equal(readFileSync(compose, 'utf8'), original);
        } else {
            assert.equal(result.status, 0, result.stderr);
            const doc = parseDocument(readFileSync(compose, 'utf8')).toJSON();
            const mounts = doc.services['chatgpt-api'].volumes;
            assert.ok(mounts.includes(retainedMount)); assert.ok(mounts.includes(dataMount));
            assert.ok(!mounts.includes(originalMount));
            assert.deepEqual(mounts.find(item => item.target === '/app/services/chatgpt-api/api/app.py'), { type: 'bind', source: '/fixture/.source-update/releases/new/python/services/chatgpt-api/api/app.py', target: '/app/services/chatgpt-api/api/app.py', read_only: true });
            assert.equal(mounts.length, 3);
        }
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
