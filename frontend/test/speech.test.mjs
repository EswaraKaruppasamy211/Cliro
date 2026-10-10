import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/speech.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const {
  DEFAULT_SPEECH_PREFERENCES,
  classifyVoiceCommand,
  LocalSpeechQueue,
  sanitizeSpeechText,
  selectSpeechVoice,
  splitSpeechChunks
} = await import(moduleUrl);

test('prefers a female English voice and honors a saved voice selection', () => {
  const voices = [
    { name: 'English system voice', lang: 'en-US', default: true, voiceURI: 'default' },
    { name: 'Microsoft Zira Desktop', lang: 'en-US', default: false, voiceURI: 'zira' }
  ];
  assert.equal(selectSpeechVoice(voices).voiceURI, 'zira');
  assert.equal(selectSpeechVoice(voices, 'default').voiceURI, 'default');
  assert.equal(selectSpeechVoice([{ name: 'System voice', lang: 'fr-FR', default: true }]).lang, 'fr-FR');
  assert.equal(selectSpeechVoice([]), null);
});

test('speech sanitization removes code, links, citations, metadata, and markdown', () => {
  const cleaned = sanitizeSpeechText(
    "## Result: **Ready.** See [docs](https://example.test). [1]\nSource: private\n```ts\nsecret()\n```\n`do not speak`"
  );
  assert.match(cleaned, /Result: Ready\. See docs\./);
  assert.doesNotMatch(cleaned, /https?:|private|secret|citation|\[1\]|do not speak/i);
  assert.equal(
    sanitizeSpeechText('{"type":"AI_RESPONSE","answer":"Hello **there**. Visit https://example.test"}'),
    'Hello there. Visit'
  );
});

test('voice stop and repeat phrases normalize without changing ordinary commands', () => {
  for (const phrase of ['Stop!', 'stop talking', 'Stop speaking.', 'Be quiet', 'silence', 'quiet', 'enough', 'cancel speech']) {
    assert.deepEqual(classifyVoiceCommand(phrase), { type: 'stop', remainingCommand: '' });
  }
  assert.deepEqual(classifyVoiceCommand('Stop. Open Notepad.'), {
    type: 'stop',
    remainingCommand: 'open notepad'
  });
  assert.deepEqual(classifyVoiceCommand('Be quiet and open Notepad'), {
    type: 'stop',
    remainingCommand: 'open notepad'
  });
  for (const phrase of ['repeat', 'repeat that', 'say that again', 'what did you say?']) {
    assert.deepEqual(classifyVoiceCommand(phrase), { type: 'repeat' });
  }
  assert.equal(classifyVoiceCommand('open notepad'), null);
});

test('speech chunks respect the limit while preserving word boundaries', () => {
  const chunks = splitSpeechChunks('One short sentence. '.repeat(20), 50);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 50));
  assert.deepEqual(splitSpeechChunks('  '), []);
});

test('speech queue deduplicates response ids and advances chunks to completion', () => {
  const utterances = [];
  const speaking = [];
  const synthesis = {
    cancel() {},
    speak(utterance) { utterances.push(utterance); }
  };
  const queue = new LocalSpeechQueue(
    synthesis,
    text => ({ text, onend: null, onerror: null }),
    () => null,
    value => speaking.push(value)
  );
  const response = 'A sentence. '.repeat(30);
  assert.equal(queue.speak(response, 'response-1', DEFAULT_SPEECH_PREFERENCES), true);
  assert.equal(queue.speak(response, 'response-1', DEFAULT_SPEECH_PREFERENCES), false);

  const firstEnd = utterances[0].onend;
  firstEnd();
  const countAfterFirstEnd = utterances.length;
  firstEnd();
  assert.equal(utterances.length, countAfterFirstEnd);
  for (let index = 1; index < utterances.length; index += 1) utterances[index].onend();
  assert.ok(utterances.length > 1);
  assert.equal(speaking.at(-1), 'IDLE');
});

test('stopping speech cancels queued chunks and ignores stale callbacks', () => {
  const utterances = [];
  let cancelCount = 0;
  const synthesis = {
    cancel() { cancelCount += 1; },
    speak(utterance) { utterances.push(utterance); }
  };
  const queue = new LocalSpeechQueue(synthesis, text => ({ text, onend: null, onerror: null }), () => null, () => {});
  queue.speak('A sentence. '.repeat(30), 'response-2', DEFAULT_SPEECH_PREFERENCES);
  const staleEnd = utterances[0].onend;
  queue.stop();
  staleEnd();
  assert.equal(utterances.length, 1);
  assert.equal(cancelCount, 2);
});

test('interrupting speech clears the queue and reports interrupted state', () => {
  const utterances = [];
  const states = [];
  let cancelCount = 0;
  const synthesis = {
    cancel() { cancelCount += 1; },
    speak(utterance) { utterances.push(utterance); }
  };
  const queue = new LocalSpeechQueue(
    synthesis,
    text => ({ text, onend: null, onerror: null }),
    () => null,
    state => states.push(state)
  );
  queue.speak('First sentence. '.repeat(30), 'response-3', DEFAULT_SPEECH_PREFERENCES);
  const staleEnd = utterances[0].onend;
  assert.equal(queue.interrupt(), true);
  staleEnd();
  assert.equal(utterances.length, 1);
  assert.equal(cancelCount, 2);
  assert.deepEqual(states.slice(-1), ['INTERRUPTED']);
  queue.stop();
  assert.deepEqual(states.slice(-1), ['IDLE']);
});

test('speech synthesis errors clear remaining chunks and expose the error state', () => {
  const utterances = [];
  const states = [];
  const queue = new LocalSpeechQueue(
    { cancel() {}, speak(utterance) { utterances.push(utterance); } },
    text => ({ text, onend: null, onerror: null }),
    () => null,
    state => states.push(state)
  );
  queue.speak('First sentence. '.repeat(30), 'response-4', DEFAULT_SPEECH_PREFERENCES);
  assert.equal(states.at(-1), 'SPEAKING');
  utterances[0].onerror();
  assert.equal(states.at(-1), 'ERROR');
  assert.equal(utterances.length, 1);
});
