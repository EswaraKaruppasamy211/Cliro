const assert = require('node:assert/strict');
const test = require('node:test');

test('OpenAI provider requires only backend environment configuration and parses the response', async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    const previousModel = process.env.OPENAI_MODEL;
    const originalFetch = global.fetch;
    process.env.OPENAI_API_KEY = 'test-secret-key';
    process.env.OPENAI_MODEL = 'test-model';

    try {
        const { OpenAIProvider } = require('../dist/ai/OpenAIProvider');
        let request;
        global.fetch = async (url, options) => {
            request = { url: String(url), options };
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'A class defines a type; inheritance reuses behavior.' } }]
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        const provider = new OpenAIProvider();
        assert.equal(provider.configured, true);
        assert.equal(provider.configuredModel, 'test-model');
        assert.match(await provider.chat('Explain inheritance'), /inheritance/);
        assert.equal(request.url, 'https://api.openai.com/v1/chat/completions');
        assert.equal(request.options.headers.Authorization, 'Bearer test-secret-key');
        assert.doesNotMatch(JSON.stringify({ provider: 'OPENAI', configured: provider.configured }), /test-secret-key/);
    } finally {
        global.fetch = originalFetch;
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
        if (previousModel === undefined) delete process.env.OPENAI_MODEL;
        else process.env.OPENAI_MODEL = previousModel;
    }
});

test('provider router never selects an unconfigured OpenAI provider', () => {
    const { selectLanguageProvider } = require('../dist/ai/ProviderRouter');
    assert.equal(selectLanguageProvider('OPENAI', false, 'OPENAI'), 'OLLAMA');
    assert.equal(selectLanguageProvider(undefined, false, 'OPENAI'), 'OLLAMA');
    assert.equal(selectLanguageProvider('OPENAI', true, 'OLLAMA'), 'OPENAI');
    assert.equal(selectLanguageProvider(undefined, true, 'OPENAI'), 'OPENAI');
    assert.equal(selectLanguageProvider('OLLAMA', true, 'OPENAI'), 'OLLAMA');
});
