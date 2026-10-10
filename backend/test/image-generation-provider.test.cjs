const assert = require('node:assert/strict');
const test = require('node:test');

const { createImageGenerationProvider, ImageGenerationError } =
    require('../dist/ai/ImageGenerationProvider');

const apiKey = 'image-generation-test-secret';

function pngBytes() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FyoAAAAASUVORK5CYII=',
        'base64'
    );
}

function createProvider(fetchImplementation, extraEnvironment = {}) {
    return createImageGenerationProvider(fetchImplementation, {
        OPENAI_API_KEY: apiKey,
        ...extraEnvironment
    });
}

test('missing provider configuration fails explicitly without generating fake output', async () => {
    let fetchCalled = false;
    const provider = createImageGenerationProvider(async () => {
        fetchCalled = true;
        throw new Error('unexpected request');
    }, {});

    await assert.rejects(
        provider.generate({ prompt: 'A sunrise over the ocean' }),
        (error) => error instanceof ImageGenerationError &&
            error.code === 'IMAGE_GENERATION_NOT_CONFIGURED'
    );
    assert.equal(fetchCalled, false);
});

test('OpenAI provider submits a bounded request and returns verified image bytes', async () => {
    const image = pngBytes();
    let request;
    const provider = createProvider(async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    });

    const result = await provider.generate({
        prompt: '  A sunrise over the ocean  ',
        size: '1536x1024',
        format: 'png',
        count: 1
    });

    assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
    assert.equal(request.options.headers.Authorization, `Bearer ${apiKey}`);
    assert.deepEqual(JSON.parse(request.options.body), {
        model: 'gpt-image-1',
        prompt: 'A sunrise over the ocean',
        size: '1536x1024',
        n: 1,
        output_format: 'png'
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(result[0].bytes), image);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
});

test('provider HTTP errors are surfaced without exposing backend credentials', async () => {
    const provider = createProvider(async () => new Response(JSON.stringify({
        error: { message: `Rejected request for ${apiKey}` }
    }), { status: 429, statusText: 'Too Many Requests' }));

    await assert.rejects(
        provider.generate({ prompt: 'A landscape' }),
        (error) => error instanceof ImageGenerationError &&
            error.code === 'IMAGE_GENERATION_PROVIDER_ERROR' &&
            /HTTP 429/.test(error.message) &&
            /Rejected request/.test(error.message) &&
            !error.message.includes(apiKey)
    );
});

test('provider output is rejected unless it contains valid bytes matching the requested format', async () => {
    const provider = createProvider(async () => new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('not an image').toString('base64') }]
    }), { status: 200 }));

    await assert.rejects(
        provider.generate({ prompt: 'A landscape' }),
        (error) => error.code === 'IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE'
    );
});

test('provider must return exactly the requested number of images', async () => {
    const image = pngBytes();
    const provider = createProvider(async () => new Response(JSON.stringify({
        data: [{ b64_json: image.toString('base64') }]
    }), { status: 200 }));

    await assert.rejects(
        provider.generate({ prompt: 'A landscape', count: 2 }),
        (error) => error.code === 'IMAGE_GENERATION_INVALID_PROVIDER_RESPONSE'
    );
});

test('prompt, size, format, and count limits are checked before making a provider request', async () => {
    let fetchCalls = 0;
    const provider = createProvider(async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
    });
    const invalidRequests = [
        { prompt: '   ' },
        { prompt: 'x'.repeat(4_001) },
        { prompt: 'A landscape', size: '4096x4096' },
        { prompt: 'A landscape', format: 'gif' },
        { prompt: 'A landscape', count: 0 },
        { prompt: 'A landscape', count: 5 },
        { prompt: 'A landscape', count: 1.5 }
    ];

    for (const request of invalidRequests) {
        await assert.rejects(
            provider.generate(request),
            (error) => error.code === 'IMAGE_GENERATION_INVALID_REQUEST'
        );
    }
    assert.equal(fetchCalls, 0);
});

test('provider can only be selected when configured as OpenAI with its backend key', async () => {
    let fetchCalls = 0;
    const fetchImplementation = async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
    };

    const unknownProvider = createImageGenerationProvider(fetchImplementation, {
        IMAGE_GENERATION_PROVIDER: 'other',
        OPENAI_API_KEY: apiKey
    });
    await assert.rejects(
        unknownProvider.generate({ prompt: 'A landscape' }),
        (error) => error.code === 'IMAGE_GENERATION_NOT_CONFIGURED'
    );
    assert.equal(fetchCalls, 0);
});
