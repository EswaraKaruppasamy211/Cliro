import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/vision/GestureRecognizer.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { GestureRecognizer, classifyHandLandmarks } = await import(moduleUrl);

function makeHand({ extended, curled, thumb = 'uncertain', thumbDirection = 'up' }) {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6, z: 0 }));
  points[0] = { x: 0.5, y: 0.9, z: 0 };
  points[5] = { x: 0.34, y: 0.58, z: 0 };
  points[9] = { x: 0.45, y: 0.58, z: 0 };
  points[13] = { x: 0.55, y: 0.58, z: 0 };
  points[17] = { x: 0.66, y: 0.58, z: 0 };

  const chains = [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  const xs = [0.34, 0.45, 0.55, 0.66];
  for (let finger = 0; finger < chains.length; finger += 1) {
    const [mcp, pip, dip, tip] = chains[finger];
    points[mcp] = { x: xs[finger], y: 0.58, z: 0 };
    if (extended.includes(finger)) {
      points[pip] = { x: xs[finger], y: 0.44, z: 0 };
      points[dip] = { x: xs[finger], y: 0.30, z: 0 };
      points[tip] = { x: xs[finger], y: 0.16, z: 0 };
    } else if (curled.includes(finger)) {
      points[pip] = { x: xs[finger], y: 0.44, z: 0 };
      points[dip] = { x: xs[finger], y: 0.53, z: 0 };
      points[tip] = { x: xs[finger], y: 0.65, z: 0 };
    } else {
      points[pip] = { x: xs[finger], y: 0.48, z: 0 };
      points[dip] = { x: xs[finger], y: 0.43, z: 0 };
      points[tip] = { x: xs[finger], y: 0.48, z: 0 };
    }
  }

  points[1] = { x: 0.39, y: 0.77, z: 0 };
  points[2] = { x: 0.34, y: 0.70, z: 0 };
  points[3] = { x: thumb === 'extended' ? 0.18 : 0.37, y: thumb === 'extended' ? 0.62 : 0.66, z: 0 };
  points[4] = {
    x: thumb === 'extended' ? 0.04 : 0.40,
    y: thumb === 'extended' ? thumbDirection === 'down' ? 0.92 : 0.50 : 0.65,
    z: 0
  };
  return points;
}

const openHand = makeHand({ extended: [0, 1, 2, 3], curled: [], thumb: 'extended' });
const closedHand = makeHand({ extended: [], curled: [0, 1, 2, 3], thumb: 'curled' });
const partialHand = makeHand({ extended: [0, 1, 2], curled: [3] });
const thumbsUp = makeHand({ extended: [], curled: [0, 1, 2, 3], thumb: 'extended' });
const thumbsDown = makeHand({ extended: [], curled: [0, 1, 2, 3], thumb: 'extended', thumbDirection: 'down' });
const pointingHand = makeHand({ extended: [0], curled: [1, 2, 3] });
const pointRightHand = rotateAndMirror(pointingHand, 90);
const pointLeftHand = rotateAndMirror(pointingHand, -90);
const vSign = makeHand({ extended: [0, 1], curled: [2, 3] });
const reverseVSign = vSign.map(point => ({ ...point, y: 1 - point.y }));
const pinchHand = openHand.map(point => ({ ...point }));
pinchHand[4] = { ...pinchHand[8] };

function rotateAndMirror(points, degrees, mirror = false) {
  const angle = degrees * Math.PI / 180;
  const origin = points[0];
  return points.map(point => {
    const x = point.x - origin.x;
    const y = point.y - origin.y;
    const rotatedX = x * Math.cos(angle) - y * Math.sin(angle);
    const rotatedY = x * Math.sin(angle) + y * Math.cos(angle);
    return {
      x: origin.x + (mirror ? -rotatedX : rotatedX),
      y: origin.y + rotatedY,
      z: point.z
    };
  });
}

function feed(recognizer, hand, count, startAt, confidence = 0.95, interval = 180) {
  return Array.from({ length: count }, (_, index) =>
    recognizer.update(hand ? [hand] : [], confidence, startAt + index * interval)
  );
}

test('missing, uncertain, and multiple hands never trigger', () => {
  const recognizer = new GestureRecognizer();
  assert.equal(recognizer.update([], null, 0).phase, 'NO_HAND');
  assert.equal(recognizer.update([closedHand, closedHand], 0.95, 200).gesture, 'UNKNOWN');
  assert.equal(classifyHandLandmarks(closedHand, 0.5).gesture, 'UNKNOWN');
  assert.equal(classifyHandLandmarks(openHand, 0.79).gesture, 'UNKNOWN');
  assert.equal(feed(recognizer, closedHand, 8, 1_000, 0.5).some(result => result.triggerUiAction), false);
});

test('open palm, turns, and partial poses classify distinctly', () => {
  const rotatedOpenHand = rotateAndMirror(openHand, 34, true);
  assert.equal(classifyHandLandmarks(openHand, 0.95).gesture, 'OPEN_PALM');
  assert.equal(classifyHandLandmarks(openHand, 0.95).action, 'TOGGLE_VOICE_LISTENING');
  assert.equal(classifyHandLandmarks(rotateAndMirror(openHand, 34), 0.95).gesture, 'TURN_RIGHT');
  assert.equal(classifyHandLandmarks(rotateAndMirror(openHand, -34), 0.95).gesture, 'TURN_LEFT');
  assert.equal(classifyHandLandmarks(rotatedOpenHand, 0.95).gesture, 'OPEN_PALM');
  assert.equal(classifyHandLandmarks(partialHand, 0.95).gesture, 'PARTIAL');
  assert.equal(feed(new GestureRecognizer(), rotatedOpenHand, 8, 0).some(result => result.action === 'CLOSE_CHROME_TAB'), false);
  assert.equal(feed(new GestureRecognizer(), partialHand, 8, 2_000).some(result => result.triggerUiAction), false);
});

test('a single closed frame and a short closed hold never trigger', () => {
  const recognizer = new GestureRecognizer();
  assert.equal(classifyHandLandmarks(closedHand, 0.95).gesture, 'CLOSED_FIST');
  assert.equal(classifyHandLandmarks(closedHand, 0.95).action, 'CLOSE_CHROME_TAB');
  assert.equal(recognizer.update([closedHand], 0.95, 0).triggerUiAction, false);
  const shortHold = feed(recognizer, closedHand, 3, 200);
  assert.equal(shortHold.some(result => result.triggerUiAction), false);
  assert.equal(shortHold.at(-1).phase, 'CLOSED_CONFIRMED');
});

test('a stale camera-frame gap resets gesture hold stability before it can trigger', () => {
  const recognizer = new GestureRecognizer();
  feed(recognizer, closedHand, 3, 0);
  const afterGap = recognizer.update([closedHand], 0.95, 1_000);
  assert.equal(afterGap.stabilityMs, 0);
  assert.equal(afterGap.triggerUiAction, false);
  const resumedHold = feed(recognizer, closedHand, 5, 1_200);
  assert.equal(resumedHold.filter(result => result.triggerUiAction).length, 1);
});

test('a stable closed hand triggers once and continued closure remains rearm-safe', () => {
  const recognizer = new GestureRecognizer();
  const results = feed(recognizer, rotateAndMirror(closedHand, -22), 5, 0);
  assert.equal(results.filter(result => result.triggerUiAction).length, 1);
  assert.equal(results.at(-1).phase, 'ACTION_TRIGGERED');
  assert.equal(results.at(-1).action, 'CLOSE_CHROME_TAB');
  assert.equal(results.at(-1).curledFingers, 4);

  const continuedClosure = feed(recognizer, closedHand, 14, 900);
  assert.equal(continuedClosure.some(result => result.triggerUiAction), false);
  assert.ok(continuedClosure.some(result => result.phase === 'COOLDOWN'));
  assert.equal(continuedClosure.at(-1).phase, 'WAITING_FOR_OPEN');
});

test('thumbs, pointing, and V-sign poses map to safe UI actions after stable confirmation', () => {
  for (const [hand, gesture, action] of [
    [thumbsUp, 'THUMBS_UP', 'APPROVE'],
    [thumbsDown, 'THUMBS_DOWN', 'CANCEL'],
    [pointingHand, 'POINT', 'SELECT'],
    [pointRightHand, 'POINT_RIGHT', 'NEXT_CHROME_TAB'],
    [pointLeftHand, 'POINT_LEFT', 'PREVIOUS_CHROME_TAB'],
    [vSign, 'V_SIGN', 'TOGGLE_VOICE_OUTPUT'],
    [reverseVSign, 'V_SIGN', 'TOGGLE_VOICE_OUTPUT'],
    [pinchHand, 'PINCH', 'SELECT']
  ]) {
    const recognizer = new GestureRecognizer();
    assert.equal(classifyHandLandmarks(hand, 0.95).gesture, gesture);
    const results = feed(recognizer, hand, 5, 0);
    assert.equal(results.filter(result => result.triggerUiAction).length, 1);
    assert.equal(results.at(-1).action, action);
  }
});

test('holding one action gesture cannot repeat it until a neutral pause rearms it', () => {
  const recognizer = new GestureRecognizer();
  const first = feed(recognizer, thumbsUp, 5, 0);
  const held = feed(recognizer, thumbsUp, 20, 1_000);
  assert.equal(first.filter(result => result.triggerUiAction).length, 1);
  assert.equal(held.some(result => result.triggerUiAction), false);
  assert.equal(feed(recognizer, null, 4, 3_000, null).at(-1).phase, 'NO_HAND');
  assert.equal(feed(recognizer, openHand, 5, 4_000).filter(result => result.triggerUiAction).length, 1);
});

test('a neutral hand-free pause after cooldown rearms a later gesture', () => {
  const recognizer = new GestureRecognizer();
  assert.equal(feed(recognizer, closedHand, 5, 0).filter(result => result.triggerUiAction).length, 1);
  feed(recognizer, null, 4, 1_000, null);
  assert.equal(feed(recognizer, closedHand, 5, 2_000).filter(result => result.triggerUiAction).length, 1);
});

test('movement and interrupted closed candidates reset the stability timer', () => {
  const recognizer = new GestureRecognizer();
  const sequence = [
    recognizer.update([closedHand], 0.95, 0),
    recognizer.update([openHand], 0.95, 180),
    recognizer.update([closedHand], 0.95, 360),
    recognizer.update([partialHand], 0.95, 540),
    ...feed(recognizer, closedHand, 3, 720)
  ];
  assert.equal(sequence.some(result => result.triggerUiAction), false);
});
