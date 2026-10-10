const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadBackendEnvironment } = require('../dist/config/BackendEnvironment');
const { createImageGenerationProvider } = require('../dist/ai/ImageGenerationProvider');

test('loads backend .env by explicit backend path and reports key presence only', async t => {
    const originalDirectory = process.cwd();
    const originalApiKey = process.env.OPENAI_API_KEY;
    const originalProvider = process.env.IMAGE_GENERATION_PROVIDER;
    const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cliro-backend-env-'));
    const backendDirectory = path.join(temporaryRoot, 'backend');
    const unrelatedDirectory = path.join(temporaryRoot, 'unrelated-working-directory');
    await fs.promises.mkdir(backendDirectory);
    await fs.promises.mkdir(unrelatedDirectory);
    await fs.promises.writeFile(
        path.join(backendDirectory, '.env'),
        'OPENAI_API_KEY=backend-environment-test-value\nIMAGE_GENERATION_PROVIDER=openai\n'
    );

    t.after(async () => {
        process.chdir(originalDirectory);
        if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = originalApiKey;
        if (originalProvider === undefined) delete process.env.IMAGE_GENERATION_PROVIDER;
        else process.env.IMAGE_GENERATION_PROVIDER = originalProvider;
        await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
    });

    delete process.env.OPENAI_API_KEY;
    delete process.env.IMAGE_GENERATION_PROVIDER;
    process.chdir(unrelatedDirectory);

    const configured = loadBackendEnvironment(backendDirectory);
    assert.equal(configured.envFilePath, path.join(backendDirectory, '.env'));
    assert.equal(configured.openAIKeyConfigured, true);
    assert.equal(configured.imageGenerationProviderConfigured, true);
    assert.equal(createImageGenerationProvider(async () => {
        throw new Error('Provider should not be contacted by this configuration test.');
    }).status, 'CONFIGURED');

    await fs.promises.writeFile(
        path.join(backendDirectory, '.env'),
        'IMAGE_GENERATION_PROVIDER=openai\n'
    );
    delete process.env.OPENAI_API_KEY;
    delete process.env.IMAGE_GENERATION_PROVIDER;
    const missingKey = loadBackendEnvironment(backendDirectory);
    assert.equal(missingKey.openAIKeyConfigured, false);
    assert.equal(missingKey.imageGenerationProviderConfigured, true);
    assert.equal(createImageGenerationProvider(async () => {
        throw new Error('Provider should not be contacted by this configuration test.');
    }).status, 'NOT_CONFIGURED');
});
