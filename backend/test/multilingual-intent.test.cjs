const assert = require('node:assert/strict');
const test = require('node:test');
const { understandCommand } = require('../dist/ai/MultilingualIntent');

test('English, Tamil, Tanglish, and mixed project creation produce the same structured intent', () => {
    const prompts = [
        'Create a React project and open it in VS Code',
        'ஒரு React project create பண்ணி VS Codeல open பண்ணு',
        'ஒரு React project create பண்ணி VS Code-ல திற',
        'React project create பண்ணி VS Codeல open பண்ணு',
        'oru React project JarvisTamil nu create panni VS Code la open pannu'
    ];
    const results = prompts.map(understandCommand);
    for (const result of results) {
        assert.equal(result.intent, 'PROJECT_CREATE');
        assert.equal(result.template, 'react');
        assert.equal(result.openInVSCode, true);
    }
    assert.equal(results.at(-1).projectName, 'JarvisTamil');
});

test('build, run, test, and stop commands are recognized across supported language forms', () => {
    assert.deepEqual(
        (({ intent, build, run }) => ({ intent, build, run }))(understandCommand('இந்த project-ஐ build பண்ணி run பண்ணு')),
        { intent: 'PROJECT_BUILD', build: true, run: true }
    );
    assert.equal(understandCommand('indha project run pannu').intent, 'PROJECT_RUN');
    assert.equal(understandCommand('project test pannu').intent, 'PROJECT_TEST');
    assert.equal(understandCommand('project stop pannu').intent, 'PROJECT_STOP');
});

test('selected-project modification preserves the requested feature', () => {
    assert.deepEqual(understandCommand('இந்த projectல login add பண்ணு'), {
        intent: 'PROJECT_MODIFY',
        confidence: 0.9,
        feature: 'login'
    });
    assert.deepEqual(understandCommand('login add pannu'), {
        intent: 'PROJECT_MODIFY',
        confidence: 0.9,
        feature: 'login'
    });
});

test('extracts project names when Tamil name markers are attached or separated', () => {
    assert.equal(
        understandCommand('ஒரு React project MyPortfolioன்னு create பண்ணி VS Codeல open பண்ணு').projectName,
        'MyPortfolio'
    );
    assert.equal(
        understandCommand('oru React project MyPortfolio nu create panni VS Code la open pannu').projectName,
        'MyPortfolio'
    );
});

test('RAM, application opening, VS Code opening, and cancel map to structured intents', () => {
    assert.deepEqual(understandCommand('RAM எவ்வளவு use ஆகுது?').intent, 'SYSTEM_QUERY');
    assert.deepEqual(understandCommand('Chrome open பண்ணு').applicationName, 'chrome');
    assert.equal(understandCommand('VS Codeல திற').applicationName, 'VS Code');
    assert.equal(understandCommand('cancel pannu').intent, 'CANCEL');
    assert.equal(understandCommand('வேண்டாம்').intent, 'CANCEL');
});

test('code, dependency, current-fact, web-lookup, and chat intents are recognized', () => {
    assert.equal(understandCommand('Generate code for a login component').intent, 'CODE_GENERATION');
    assert.equal(understandCommand('Fix the code error').intent, 'CODE_FIX');
    assert.equal(understandCommand('package install pannu').intent, 'DEPENDENCY_INSTALL');
    assert.equal(understandCommand('இன்றைய weather').intent, 'CURRENT_FACT');
    assert.equal(understandCommand('web search React docs').intent, 'WEB_LOOKUP');
    assert.equal(understandCommand('Hello CLIRO').intent, 'CHAT');
});

test('multilingual image generation, editing, variations, and project integration are structured', () => {
    const tamil = understandCommand('ஒரு futuristic AI hero image generate பண்ணு');
    assert.equal(tamil.intent, 'IMAGE_GENERATION');
    assert.equal(tamil.imagePurpose, 'hero image');

    const tanglish = understandCommand('oru futuristic image generate pannu');
    assert.equal(tanglish.intent, 'IMAGE_GENERATION');
    assert.match(tanglish.imagePrompt, /futuristic/i);

    const mixed = understandCommand('இந்த websiteக்கு AI background image create பண்ணு');
    assert.equal(mixed.intent, 'IMAGE_ADD_TO_PROJECT');
    assert.equal(mixed.imagePurpose, 'background image');

    const variants = understandCommand('Generate 3 illustrations for the landing page');
    assert.equal(variants.intent, 'IMAGE_VARIATIONS');
    assert.equal(variants.imageCount, 3);

    assert.equal(understandCommand('indha image ah edit pannu').intent, 'IMAGE_EDIT');
    assert.equal(understandCommand('Regenerate the hero image').intent, 'IMAGE_REGENERATE');
});

test('explicit image-generation phrasing is deterministic while educational image questions stay chat', () => {
    const prompts = [
        'create one image based on how in future',
        'generate an image',
        'Create one image based on how the future looks: a futuristic AI-powered world with holographic interfaces, intelligent robots, advanced cities, blue/cyan technology lighting, cinematic realistic style, 16:9.',
        'create a picture of a futuristic city',
        'ஒரு படம் உருவாக்கு',
        'oru futuristic image create panni kudu'
    ];
    for (const prompt of prompts) {
        assert.equal(understandCommand(prompt).intent, 'IMAGE_GENERATION', prompt);
    }
    assert.equal(understandCommand('How does image recognition work?').intent, 'CHAT');
    assert.equal(understandCommand('Explain what an image is in computer vision.').intent, 'CHAT');
});

test('project names can be identified from open requests or a bare project mention', () => {
    assert.deepEqual(understandCommand('Open my JarvisTodo project'), {
        intent: 'PROJECT_OPEN',
        confidence: 0.88,
        openInVSCode: false,
        projectName: 'JarvisTodo'
    });
    assert.equal(understandCommand('JarvisTodo').intent, 'PROJECT_SELECT');
    assert.equal(understandCommand('JarvisTodo').projectName, 'JarvisTodo');
});

test('ambiguous project requests ask for clarification rather than returning an executable intent', () => {
    const result = understandCommand('இந்த projectல ஏதாவது பண்ணு');
    assert.equal(result.intent, undefined);
    assert.ok(result.confidence < 0.5);
    assert.match(result.clarification, /Build.*run.*code/);
});
