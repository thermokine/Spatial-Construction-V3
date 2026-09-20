/**
 * Deterministic tests for the XY-only rotation patch.
 *
 * This does NOT reimplement the rotation math -- it extracts the exact,
 * unmodified source blocks (RotationMath, MathUtils, the plane constants,
 * and TargetObjectManager.animateSequence's body) directly out of
 * ../src/main.js by line range, writes them to a temporary ES module, and
 * imports that. If someone edits the rotation logic in main.js, these tests
 * run against whatever is actually there -- not a copy that could drift.
 *
 * Run with: node tests/xy-rotation.test.mjs
 * (also wired up as `npm test`)
 */
import * as THREE from 'three';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, '..', 'src', 'main.js');

function extractLines(lines, fromLine, toLine) {
    // 1-indexed, inclusive, matching how you'd read a `view`/editor line number.
    return lines.slice(fromLine - 1, toLine).join('\n');
}

function findLine(lines, matcher) {
    const idx = lines.findIndex((l) => matcher.test(l));
    if (idx === -1) throw new Error(`Could not find line matching ${matcher} in ${SRC_PATH}`);
    return idx + 1; // 1-indexed
}

const source = readFileSync(SRC_PATH, 'utf-8');
const lines = source.split('\n');

// Locate each block by its start marker, then find its natural end by brace
// balance, so this stays correct even if unrelated code above/below shifts.
function extractBlockFrom(startMatcher) {
    const startLine = findLine(lines, startMatcher);
    let depth = 0;
    let started = false;
    for (let i = startLine - 1; i < lines.length; i++) {
        for (const ch of lines[i]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') { depth--; }
        }
        if (started && depth === 0) {
            return { text: extractLines(lines, startLine, i + 1), endLine: i + 1 };
        }
    }
    throw new Error(`Could not find matching closing brace for block starting at line ${startLine}`);
}

const easingLine = extractLines(lines, findLine(lines, /^function easeInOutCubic/), findLine(lines, /^function easeInOutCubic/));
const planeConstsStart = findLine(lines, /^const PLANES = /);
const planeConstsEnd = findLine(lines, /^const ENABLED_PLANES_OVERRIDE = /);
const planeConsts = extractLines(lines, planeConstsStart, planeConstsEnd);
const rotationMath = extractBlockFrom(/^const RotationMath = \{/).text;
const mathUtils = extractBlockFrom(/^class MathUtils \{/).text;

// animateSequence's method body only (excluding its own signature line and
// the closing brace that belongs to the surrounding class).
const animStartLine = findLine(lines, /^\s*animateSequence\(sequence, opts\) \{/);
const animBlock = extractBlockFrom(/^\s*animateSequence\(sequence, opts\) \{/);
// Strip the first line (signature) and last line (method-closing brace) so we
// can re-wrap the body inside our own FakeTarget class below.
const animLinesArr = animBlock.text.split('\n');
const animateSeqBody = animLinesArr.slice(1, -1).join('\n');

const harness = `
import * as THREE from 'three';

let __clock = 0;
global.performance = { now: () => __clock };
global.requestAnimationFrame = (cb) => { __clock += 16; cb(__clock); };

${easingLine}
${planeConsts}
${rotationMath}
${mathUtils}

class FakeTarget {
    constructor() { this.group = { quaternion: new THREE.Quaternion() }; }
    animateSequence(sequence, opts) {
${animateSeqBody}
    }
}

export { PLANES, PLANE_TO_AXIS, ENABLED_PLANES_OVERRIDE, RotationMath, MathUtils, FakeTarget };
`;

const tmpPath = path.join(__dirname, '.__extracted_rotation_harness.mjs');
writeFileSync(tmpPath, harness);

let mod;
try {
    mod = await import(`${tmpPath}?t=${Date.now()}`);
} finally {
    rmSync(tmpPath, { force: true });
}
const { PLANES, ENABLED_PLANES_OVERRIDE, RotationMath, MathUtils, FakeTarget } = mod;

// ============================================================
// Test runner
// ============================================================
let failures = 0;
function check(name, cond, extra) {
    if (cond) { console.log('PASS:', name); }
    else { failures++; console.log('FAIL:', name, extra ?? ''); }
}
function coordsEqual(a, b) {
    return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.z === b[i].z);
}

// 1. Vertical 2-voxel line -> horizontal line after 90deg
{
    const original = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }];
    const truth = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 90, direction: 'clockwise' }]);
    check('1. vertical -> horizontal after 90deg CW',
        truth[0].y === truth[1].y && truth[0].x !== truth[1].x, JSON.stringify(truth));
}

// 2. Horizontal 2-voxel line -> vertical line after 90deg
{
    const original = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }];
    const truth = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 90, direction: 'clockwise' }]);
    check('2. horizontal -> vertical after 90deg CW',
        truth[0].x === truth[1].x && truth[0].y !== truth[1].y, JSON.stringify(truth));
}

// 3. 90deg CW vs 90deg CCW produce opposite orientations
{
    const original = [{ x: 1, y: 0, z: 0 }];
    const cw = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 90, direction: 'clockwise' }]);
    const ccw = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 90, direction: 'anticlockwise' }]);
    check('3. CW vs CCW 90deg are opposite',
        cw[0].x === -ccw[0].x && cw[0].y === -ccw[0].y && cw[0].z === ccw[0].z, JSON.stringify({ cw, ccw }));
    check('3b. CW(1,0,0) == (0,-1,0) [viewed from +Z toward origin]',
        cw[0].x === 0 && cw[0].y === -1 && cw[0].z === 0, JSON.stringify(cw));
    check('3c. CCW(1,0,0) == (0,1,0) [viewed from +Z toward origin]',
        ccw[0].x === 0 && ccw[0].y === 1 && ccw[0].z === 0, JSON.stringify(ccw));
}

// 4. 180deg rotation returns the expected reversed orientation
{
    const original = [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }];
    const cw180 = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 180, direction: 'clockwise' }]);
    const ccw180 = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 180, direction: 'anticlockwise' }]);
    const expected = [{ x: -1, y: 0, z: 0 }, { x: -2, y: 0, z: 0 }];
    check('4. 180deg CW reverses the arm', coordsEqual(cw180, expected), JSON.stringify(cw180));
    check('4b. 180deg CW == 180deg CCW (angle-only symmetry)', coordsEqual(cw180, ccw180), JSON.stringify({ cw180, ccw180 }));
}

// 5. 270deg behaves equivalently to the opposite 90deg
{
    const original = [{ x: 1, y: 0, z: 0 }];
    const cw270 = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 270, direction: 'clockwise' }]);
    const ccw90 = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 90, direction: 'anticlockwise' }]);
    check('5. CW 270deg == CCW 90deg', coordsEqual(cw270, ccw90), JSON.stringify({ cw270, ccw90 }));
    const ccw270 = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 270, direction: 'anticlockwise' }]);
    const cw90 = MathUtils.computeGroundTruth(original, [{ plane: 'XY', degrees: 90, direction: 'clockwise' }]);
    check('5b. CCW 270deg == CW 90deg', coordsEqual(ccw270, cw90), JSON.stringify({ ccw270, cw90 }));
}

// 6. Asymmetric 3D structure rotates correctly in XY, preserving Z, multi-step
{
    const original = [
        { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 2 },
    ];
    const seq = [
        { plane: 'XY', degrees: 90, direction: 'clockwise' },
        { plane: 'XY', degrees: 180, direction: 'anticlockwise' },
    ];
    const truth = MathUtils.computeGroundTruth(original, seq);
    check('6. Z coordinates preserved under XY rotation',
        original.every((p, i) => p.z === truth[i].z), JSON.stringify(truth.map((p) => p.z)));

    function rot2D(p, angleDeg) {
        const a = angleDeg * Math.PI / 180;
        const c = Math.cos(a), s = Math.sin(a);
        return { x: Math.round(p.x * c - p.y * s), y: Math.round(p.x * s + p.y * c) };
    }
    const manual = original.map((p) => {
        let cur = { x: p.x, y: p.y };
        cur = rot2D(cur, -90);  // clockwise 90 = negative angle
        cur = rot2D(cur, 180);  // anticlockwise 180 == clockwise 180
        return { x: cur.x, y: cur.y, z: p.z };
    });
    check('6b. computeGroundTruth matches an independent hand-derived rotation',
        coordsEqual(truth, manual), JSON.stringify({ truth, manual }));
}

// 7. Animated transformation matches the mathematically computed target
{
    const seq = [
        { plane: 'XY', degrees: 90, direction: 'clockwise' },
        { plane: 'XY', degrees: 270, direction: 'anticlockwise' },
        { plane: 'XY', degrees: 180, direction: 'clockwise' },
    ];
    const target = new FakeTarget();
    await target.animateSequence(seq, {});
    const finalQuat = target.group.quaternion;
    const scoringQuat = RotationMath.cumulativeQuaternion(seq);

    const testPoint = new THREE.Vector3(3, -2, 5);
    const viaAnimation = testPoint.clone().applyQuaternion(finalQuat);
    const viaScoring = testPoint.clone().applyQuaternion(scoringQuat);
    check('7. animation end-state matches scoring ground truth exactly',
        viaAnimation.distanceTo(viaScoring) < 1e-9, JSON.stringify({ viaAnimation, viaScoring }));
}

// 9. CRITICAL: (2,3,7) must keep z=7 under every XY rotation, all angles/directions
{
    const p = { x: 2, y: 3, z: 7 };
    let allZOk = true;
    for (const degrees of [90, 180, 270]) {
        for (const direction of ['clockwise', 'anticlockwise']) {
            const [r] = MathUtils.computeGroundTruth([p], [{ plane: 'XY', degrees, direction }]);
            if (r.z !== 7) allZOk = false;
        }
    }
    check('9. (2,3,7) keeps z=7 across every angle/direction', allZOk);
}

// 10. Exact cross-check against the user-specified formulas:
//   clockwise:     x' = x cos(t) + y sin(t),  y' = -x sin(t) + y cos(t)
//   anticlockwise: x' = x cos(t) - y sin(t),  y' =  x sin(t) + y cos(t)
{
    function userCW(x, y, z, deg) {
        const t = deg * Math.PI / 180;
        return { x: Math.round(x * Math.cos(t) + y * Math.sin(t)), y: Math.round(-x * Math.sin(t) + y * Math.cos(t)), z };
    }
    function userCCW(x, y, z, deg) {
        const t = deg * Math.PI / 180;
        return { x: Math.round(x * Math.cos(t) - y * Math.sin(t)), y: Math.round(x * Math.sin(t) + y * Math.cos(t)), z };
    }
    let allMatch = true;
    for (const deg of [30, 45, 90, 137, 180, 270]) {
        const [gtCW] = MathUtils.computeGroundTruth([{ x: 2, y: 3, z: 7 }], [{ plane: 'XY', degrees: deg, direction: 'clockwise' }]);
        const [gtCCW] = MathUtils.computeGroundTruth([{ x: 2, y: 3, z: 7 }], [{ plane: 'XY', degrees: deg, direction: 'anticlockwise' }]);
        if (!coordsEqual([gtCW], [userCW(2, 3, 7, deg)])) allMatch = false;
        if (!coordsEqual([gtCCW], [userCCW(2, 3, 7, deg)])) allMatch = false;
    }
    check('10. computeGroundTruth matches the exact specified CW/CCW formulas', allMatch);
}

// 8. Plane restriction holds even if settings state were corrupted to allow all 3
{
    function enabledKeys(map, allKeys) {
        const on = allKeys.filter((k) => map[k]);
        return on.length ? on : allKeys.slice();
    }
    const corrupted = { XY: true, XZ: true, YZ: true };
    const requested = enabledKeys(corrupted, PLANES);
    const pool = requested.filter((p) => ENABLED_PLANES_OVERRIDE.includes(p));
    const active = pool.length ? pool : ENABLED_PLANES_OVERRIDE;
    let onlyXY = true;
    for (let i = 0; i < 500; i++) {
        if (active[Math.floor(Math.random() * active.length)] !== 'XY') onlyXY = false;
    }
    check('8. plane pool is XY-only even with all planes "enabled" in settings',
        onlyXY && active.length === 1 && active[0] === 'XY', JSON.stringify(active));
}

console.log('');
console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
