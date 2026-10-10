const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyQuery } = require('../dist/ai/QueryRouter');
const { verifyCurrentFact } = require('../dist/ai/CurrentFactService');
const { WikipediaFactsProvider } = require('../dist/ai/VerifiedFactsProvider');

const query = 'Who is the current Chief Minister of Tamil Nadu?';
const extract = 'Since 1950, Tamil Nadu has had 14 chief ministers. C. Joseph Vijay is the incumbent Chief Minister since 10 May 2026.';

function mockWikipediaFetch() {
    let calls = 0;
    const fetchImpl = async input => {
        calls += 1;
        const url = new URL(input);
        if (url.searchParams.get('list') === 'search') {
            return new Response(JSON.stringify({
                query: {
                    search: [{ pageid: 594077, title: 'Chief Minister of Tamil Nadu' }]
                }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            query: {
                pages: {
                    '594077': { pageid: 594077, title: 'Chief Minister of Tamil Nadu', extract }
                }
            }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fetchImpl, getCalls: () => calls };
}

test('routes deterministic computer commands before current facts', () => {
    assert.equal(classifyQuery('Show CPU', 'getSystemInfo'), 'SYSTEM_INFO');
    assert.equal(classifyQuery('Open Notepad', 'openApplication'), 'APPLICATION_CONTROL');
    assert.equal(classifyQuery('List the files in my CLIRO project', 'listProjectFiles'), 'FILESYSTEM');
    assert.equal(classifyQuery('Check my code', 'analyzeCode'), 'CODE_ANALYSIS');
    assert.equal(classifyQuery('Create one image based on how in future', 'generateImage'), 'IMAGE_GENERATION');
});

test('keeps educational questions on Ollama and detects current office holders', () => {
    assert.equal(classifyQuery('What is an operating system?'), 'GENERAL_KNOWLEDGE');
    assert.equal(classifyQuery('Explain RAM in simple terms.'), 'GENERAL_KNOWLEDGE');
    for (const prompt of [
        'Who is the current Chief Minister of Tamil Nadu?',
        'Who is currently the Chief Minister of Tamil Nadu?',
        'Current CM of Tamil Nadu?',
        'Who is the CM of Tamil Nadu right now?',
        'who is the current cm of tamil nadu'
    ]) {
        assert.equal(classifyQuery(prompt), 'CURRENT_FACT', prompt);
    }
    assert.equal(classifyQuery('Who is the current CEO of Microsoft?'), 'CURRENT_FACT');
    assert.equal(classifyQuery('Who is the current Prime Minister of India?'), 'CURRENT_FACT');
    assert.equal(classifyQuery('Who is the current President of India?'), 'CURRENT_FACT');
    assert.equal(classifyQuery("What's the latest version of Node.js?"), 'CURRENT_FACT');
    for (const prompt of [
        'What is the current price of silver?',
        'Weather in Chennai today',
        "What's the latest news about space?",
        'What are the current laws about data protection?',
        'What are the latest product specifications?',
        'Current league standings'
    ]) {
        assert.equal(classifyQuery(prompt), 'CURRENT_FACT', prompt);
    }
    assert.equal(classifyQuery('What is a Chief Minister?'), 'GENERAL_KNOWLEDGE');
    assert.equal(classifyQuery('Who was the first CM of Tamil Nadu?'), 'GENERAL_KNOWLEDGE');
    assert.equal(classifyQuery('Who founded OpenAI?'), 'VERIFIED_FACT');
    assert.equal(classifyQuery('Was Elon Musk the sole founder of OpenAI?'), 'VERIFIED_FACT');
});

test('normalizes Tamilnadu office-holder queries so they resolve to the same verified current fact', async () => {
    const provider = new WikipediaFactsProvider(async input => {
        const url = new URL(input);
        if (url.searchParams.get('list') === 'search') {
            return new Response(JSON.stringify({
                query: {
                    search: [{ pageid: 594077, title: 'Chief Minister of Tamil Nadu' }]
                }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            query: {
                pages: {
                    '594077': { pageid: 594077, title: 'Chief Minister of Tamil Nadu', extract }
                }
            }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await provider.answer('who is the CM of Tamilnadu');
    assert.equal(result.type, 'VERIFIED_FACT');
    assert.match(result.answer, /C\. Joseph Vijay/i);
});

test('returns a cited current fact and reuses its normalized-query cache', async () => {
    const { fetchImpl, getCalls } = mockWikipediaFetch();
    let now = Date.parse('2026-10-04T00:00:00.000Z');
    const provider = new WikipediaFactsProvider(fetchImpl, () => now);

    const first = await provider.answer(query);
    const second = await provider.answer('Who is the current Chief Minister of Tamil Nadu? Verify it from a trusted current source and give me the source.');

    assert.equal(first.type, 'VERIFIED_FACT');
    assert.match(first.answer, /C\. Joseph Vijay.*incumbent Chief Minister/i);
    assert.equal(first.source.url, 'https://en.wikipedia.org/?curid=594077');
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.answer, first.answer);
    assert.equal(getCalls(), 2);

    now += 5 * 60 * 1000 + 1;
    const refreshed = await provider.answer(query);
    assert.equal(refreshed.cached, false);
    assert.equal(getCalls(), 4);
});

test('rejects historical CEO changes and office-staff claims as current office-holder answers', async () => {
    const cases = [
        {
            query: 'Who is the current CEO of Microsoft?',
            title: 'Microsoft',
            extract: 'Since Satya Nadella became CEO in 2014, Microsoft has continued to grow.'
        },
        {
            query: 'Who is the current Prime Minister of India?',
            title: "Prime Minister's Office (India)",
            extract: "The Prime Minister's Office is headed by a Principal Secretary to the Prime Minister of India."
        },
        {
            query: 'Who is the current Prime Minister of India?',
            title: 'Prime Minister of India',
            extract: 'Executive authority is vested in the prime minister and his chosen Council of Ministers.'
        },
        {
            query: 'Who is the current President of India?',
            title: 'President of India',
            extract: 'The president of India is the head of state of the Republic of India.'
        }
    ];

    for (const item of cases) {
        const provider = new WikipediaFactsProvider(async input => {
            const url = new URL(input);
            if (url.searchParams.get('list') === 'search') {
                return new Response(JSON.stringify({
                    query: { search: [{ pageid: 500, title: item.title }] }
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            return new Response(JSON.stringify({
                query: {
                    pages: {
                        '500': { pageid: 500, title: item.title, extract: item.extract }
                    }
                }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        const result = await verifyCurrentFact(item.query, provider);
        assert.equal(result.type, 'CURRENT_FACT_UNAVAILABLE', item.query);
        assert.equal(result.verified, false, item.query);
        assert.equal(result.source, null, item.query);
    }
});

test('returns current-fact unavailable instead of falling back when provider is disabled', async () => {
    const disabledProvider = {
        canHandle: () => false,
        answer: async () => {
            throw new Error('Must not be called when disabled.');
        }
    };
    const result = await verifyCurrentFact(query, disabledProvider, () => Date.parse('2026-10-04T00:00:00.000Z'));
    assert.equal(result.type, 'CURRENT_FACT_UNAVAILABLE');
    assert.equal(result.verified, false);
    assert.equal(result.source, null);
    assert.match(result.message, /could not be verified/i);
});

test('fails closed when the verification network is unavailable', async () => {
    const provider = new WikipediaFactsProvider(async () => {
        throw new Error('Network disabled for test.');
    });
    const result = await verifyCurrentFact(query, provider);
    assert.equal(result.type, 'CURRENT_FACT_UNAVAILABLE');
    assert.equal(result.verified, false);
    assert.equal(result.source, null);
});

test('uses the official Node.js release index for latest-version queries', async () => {
    let requestedUrl = '';
    const provider = new WikipediaFactsProvider(async input => {
        requestedUrl = String(input);
        return new Response(JSON.stringify([
            { version: 'v99.2.1', date: '2026-10-01', lts: false },
            { version: 'v99.1.0', date: '2026-09-15', lts: false }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await provider.answer("What's the latest version of Node.js?");
    assert.equal(result.type, 'VERIFIED_FACT');
    assert.match(result.answer, /v99\.2\.1/);
    assert.equal(result.source.provider, 'Node.js official distribution index');
    assert.equal(requestedUrl, 'https://nodejs.org/dist/index.json');
});

test('answers OpenAI founder questions from the cited historical source excerpt', async () => {
    let sourceSearchQuery = '';
    const provider = new WikipediaFactsProvider(async input => {
        const url = new URL(input);
        if (url.searchParams.get('list') === 'search') {
            sourceSearchQuery = url.searchParams.get('srsearch');
            return new Response(JSON.stringify({
                query: { search: [{ pageid: 100, title: 'OpenAI' }] }
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            query: {
                pages: {
                    '100': {
                        pageid: 100,
                        title: 'OpenAI',
                        extract: '== Founding and early history ==\nIn December 2015, OpenAI was founded as the nonprofit organization OpenAI, Inc., by Elon Musk, Sam Altman, Ilya Sutskever, Greg Brockman, Trevor Blackwell, Vicki Cheung, Andrej Karpathy, Durk Kingma, John Schulman, Pamela Vagata, and Wojciech Zaremba, with Musk and Altman as the co-chairs.'
                    }
                }
            }
        }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const soleFounderAnswer = await provider.answer('Was Elon Musk the sole founder of OpenAI?');
    assert.equal(soleFounderAnswer.type, 'VERIFIED_FACT');
    assert.match(soleFounderAnswer.answer, /^No\./);
    assert.match(soleFounderAnswer.answer, /Sam Altman/);
    assert.equal(soleFounderAnswer.source.title, 'Wikipedia: OpenAI');
    assert.equal(sourceSearchQuery, 'OpenAI');

    const founderAnswer = await provider.answer('Who founded OpenAI?');
    assert.equal(founderAnswer.type, 'VERIFIED_FACT');
    assert.match(founderAnswer.answer, /Elon Musk, Sam Altman/);
});
