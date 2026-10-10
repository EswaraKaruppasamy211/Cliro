const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { ImageGenerationService } = require('../dist/ai/ImageGenerationService');
const { createImageGenerationProvider, ImageGenerationError } = require('../dist/ai/ImageGenerationProvider');
const { ProjectWorkspace } = require('../dist/projects/ProjectWorkspace');

function pngBytes() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FyoAAAAASUVORK5CYII=',
        'base64'
    );
}

async function fixture(t, provider) {
    const base = path.join(__dirname, '.image-generation-fixtures', randomUUID());
    const projectsRoot = path.join(base, 'CLIROProjects');
    const projectPath = path.join(projectsRoot, 'FixtureProject');
    const workspace = new ProjectWorkspace(path.join(base, 'registry.json'), projectsRoot);
    await fs.promises.mkdir(projectPath, { recursive: true });
    const opened = await workspace.openProject(projectPath);
    t.after(async () => {
        await fs.promises.rm(base, { recursive: true, force: true });
    });
    return {
        base,
        projectPath,
        workspace,
        projectId: opened.project.id,
        service: new ImageGenerationService(workspace, provider)
    };
}

test('image generation cancellation makes no provider request and creates no files', async t => {
    let calls = 0;
    const provider = {
        name: 'TestProvider',
        status: 'CONFIGURED',
        async generate() {
            calls += 1;
            return [{ bytes: pngBytes(), format: 'png', mimeType: 'image/png' }];
        }
    };
    const fx = await fixture(t, provider);
    const approval = fx.service.createApproval('request-1', fx.projectId, 'make a logo', 'blue logo', 'logo', 1, false);
    assert.equal(approval.plan.outputPaths[0], 'public/images/logo.png');

    const result = await fx.service.generateApproved({
        approvalRequestId: approval.approvalRequestId,
        projectId: fx.projectId,
        sourcePrompt: 'make a logo',
        approve: false
    });
    assert.equal(result.type, 'IMAGE_GENERATION_CANCELLED');
    assert.equal(calls, 0);
    await assert.rejects(fs.promises.access(path.join(fx.projectPath, 'public')));
});

test('approved project image is written without overwrite and verified from disk', async t => {
    const image = pngBytes();
    const provider = {
        name: 'TestProvider',
        status: 'CONFIGURED',
        async generate() {
            return [{ bytes: image, format: 'png', mimeType: 'image/png' }];
        }
    };
    const fx = await fixture(t, provider);
    const approval = fx.service.createApproval('request-2', fx.projectId, 'make a logo', 'blue logo', 'logo', 1, false);
    assert.equal(approval.plan.outputPaths[0], 'public/images/logo.png');
    await assert.rejects(fs.promises.access(path.join(fx.projectPath, 'public')));

    const result = await fx.service.generateApproved({
        approvalRequestId: approval.approvalRequestId,
        projectId: fx.projectId,
        sourcePrompt: 'make a logo',
        approve: true
    });
    assert.equal(result.type, 'IMAGE_GENERATED');
    assert.equal(result.verified, true);
    assert.equal(result.provider, 'TestProvider');
    assert.equal(result.images[0].path, 'public/images/logo.png');
    assert.equal(result.images[0].verified, true);
    assert.equal(result.projectId, fx.projectId);
    assert.equal(result.imagePath, path.join(fx.projectPath, 'public', 'images', 'logo.png'));
    assert.deepEqual(result.imagePaths, [result.imagePath]);
    assert.deepEqual(
        await fs.promises.readFile(path.join(fx.projectPath, 'public', 'images', 'logo.png')),
        image
    );
    const preview = await fx.service.readGeneratedImage(fx.projectId, result.images[0].path);
    assert.equal(preview.mimeType, 'image/png');
    assert.deepEqual(preview.bytes, image);
    await assert.rejects(
        fx.service.generateApproved({
            approvalRequestId: approval.approvalRequestId,
            projectId: fx.projectId,
            sourcePrompt: 'make a logo',
            approve: true
        })
    );
});

test('approval binds the original prompt and project and cannot overwrite existing assets', async t => {
    let calls = 0;
    const provider = {
        name: 'TestProvider',
        status: 'CONFIGURED',
        async generate() {
            calls += 1;
            return [{ bytes: pngBytes(), format: 'png', mimeType: 'image/png' }];
        }
    };
    const fx = await fixture(t, provider);
    await fs.promises.mkdir(path.join(fx.projectPath, 'public', 'images'), { recursive: true });
    await fs.promises.writeFile(path.join(fx.projectPath, 'public', 'images', 'logo.png'), 'existing');
    const approval = fx.service.createApproval('request-3', fx.projectId, 'make a logo', 'blue logo', 'logo', 1, false);
    assert.equal(approval.plan.outputPaths[0], 'public/images/logo-v2.png');

    await assert.rejects(
        fx.service.generateApproved({
            approvalRequestId: approval.approvalRequestId,
            projectId: 'another-project',
            sourcePrompt: 'make a logo',
            approve: true
        })
    );
    await assert.rejects(
        fx.service.generateApproved({
            approvalRequestId: approval.approvalRequestId,
            projectId: fx.projectId,
            sourcePrompt: 'make a different logo',
            approve: true
        })
    );
    assert.equal(calls, 0);
    assert.equal(await fs.promises.readFile(path.join(fx.projectPath, 'public', 'images', 'logo.png'), 'utf8'), 'existing');
});

test('project output must remain inside the trusted CLIRO projects root', async t => {
    const provider = {
        name: 'TestProvider',
        status: 'CONFIGURED',
        async generate() {
            return [{ bytes: pngBytes(), format: 'png', mimeType: 'image/png' }];
        }
    };
    const fx = await fixture(t, provider);
    const outside = path.join(fx.base, 'OutsideProject');
    await fs.promises.mkdir(outside);
    const registeredOutside = await fx.workspace.openProject(outside);
    assert.throws(() => fx.service.createApproval(
        'request-4',
        registeredOutside.project.id,
        'make a logo',
        'blue logo',
        'logo',
        1,
        false
    ), /trusted CLIRO projects root/i);
});

test('configured image provider is called and its actual response bytes are saved and verified', async t => {
    const actualImageBytes = pngBytes();
    let providerRequest;
    const provider = createImageGenerationProvider(async (url, options) => {
        providerRequest = { url, options };
        return new Response(JSON.stringify({
            data: [{ b64_json: actualImageBytes.toString('base64') }]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    }, {
        OPENAI_API_KEY: 'test-only-image-provider-key',
        IMAGE_GENERATION_PROVIDER: 'openai'
    });
    const fx = await fixture(t, provider);
    const prompt = 'Create one image based on how the future looks';
    const approval = fx.service.createApproval('request-5', fx.projectId, prompt, prompt, 'future image', 1, false);
    const result = await fx.service.generateApproved({
        approvalRequestId: approval.approvalRequestId,
        projectId: fx.projectId,
        sourcePrompt: prompt,
        approve: true
    });

    assert.equal(providerRequest.url, 'https://api.openai.com/v1/images/generations');
    assert.equal(providerRequest.options.method, 'POST');
    assert.equal(providerRequest.options.headers.Authorization, 'Bearer test-only-image-provider-key');
    assert.equal(result.type, 'IMAGE_GENERATED');
    assert.equal(result.verified, true);
    assert.equal(result.imagePath, path.join(fx.projectPath, 'public', 'images', 'future-image.png'));
    const saved = await fs.promises.readFile(result.imagePath);
    assert.deepEqual(saved, actualImageBytes);
    assert.ok(saved.length > 0);
    assert.deepEqual(
        (await fx.service.readGeneratedImage(fx.projectId, 'public/images/future-image.png')).bytes,
        actualImageBytes
    );
});

test('missing provider fails explicitly and cannot return IMAGE_GENERATED or create a file', async t => {
    let fetchCalls = 0;
    const provider = createImageGenerationProvider(async () => {
        fetchCalls += 1;
        throw new Error('provider should not be contacted');
    }, {});
    const fx = await fixture(t, provider);
    const prompt = 'Generate an image';
    const approval = fx.service.createApproval('request-6', fx.projectId, prompt, prompt, 'generated image', 1, false);

    await assert.rejects(
        fx.service.generateApproved({
            approvalRequestId: approval.approvalRequestId,
            projectId: fx.projectId,
            sourcePrompt: prompt,
            approve: true
        }),
        error => error instanceof ImageGenerationError && error.code === 'IMAGE_GENERATION_NOT_CONFIGURED'
    );
    assert.equal(fetchCalls, 0);
    await assert.rejects(fs.promises.access(path.join(fx.projectPath, 'public')));
});
