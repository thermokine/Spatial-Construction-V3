import * as THREE from 'three';
import './style.css';

/**
 * 1. CONFIGURATION & STATE
 */
const CONFIG = {
    minCubes: 8,
    maxCubes: 12,
    depthLevel: 2,           // 1 = compact, 2 = balanced, 3 = sprawling -- see DEPTH_LEVELS
    explorationTime: 5,
    rotationsEnabled: true,
    rotationSteps: 2,
    // XZ/YZ are temporarily disabled -- see ENABLED_PLANES_OVERRIDE below.
    allowedPlanes: { XY: true, XZ: false, YZ: false },
    allowedAngles: { 90: true, 180: true, 270: false },
    allowedDirections: { clockwise: true, anticlockwise: true },
};

/* Difficulty presets bundle every underlying control into one click.
   Values are starting points, not hard limits -- every field remains
   individually adjustable afterward (that's "Custom"). */
const PRESETS = {
    easy: {
        minCubes: 5, maxCubes: 7, depthLevel: 1,
        explorationTime: 6, rotationsEnabled: true, rotationSteps: 1,
        allowedPlanes: { XY: true, XZ: false, YZ: false },
        allowedAngles: { 90: true, 180: false, 270: false },
        allowedDirections: { clockwise: true, anticlockwise: true },
    },
    medium: {
        minCubes: 8, maxCubes: 12, depthLevel: 2,
        explorationTime: 5, rotationsEnabled: true, rotationSteps: 2,
        allowedPlanes: { XY: true, XZ: false, YZ: false },
        allowedAngles: { 90: true, 180: true, 270: false },
        allowedDirections: { clockwise: true, anticlockwise: true },
    },
    hard: {
        minCubes: 12, maxCubes: 18, depthLevel: 3,
        explorationTime: 4, rotationsEnabled: true, rotationSteps: 3,
        allowedPlanes: { XY: true, XZ: false, YZ: false },
        allowedAngles: { 90: true, 180: true, 270: true },
        allowedDirections: { clockwise: true, anticlockwise: true },
    },
};

const STATES = {
    INIT: 'INIT',
    EXPLORE: 'Exploring \u00B7 free camera',
    CANONICAL: 'Establishing orientation',
    MENTAL: 'Mental transformation \u00B7 blind',
    RECONSTRUCT: 'Reconstruction workspace',
    FEEDBACK: 'Scoring',
    REVEAL: 'Ground truth animation',
};

/* User-facing rotations are specified by PLANE (XY/XZ/YZ), never by axis --
   see RotationMath below for the fixed mapping to the axis that actually
   gets rotated. This is a display/selection change only: for a given axis
   the rotation math is byte-for-byte identical to before. */
const PLANES = ['XY', 'XZ', 'YZ'];
const PLANE_TO_AXIS = { XY: 'Z', XZ: 'Y', YZ: 'X' };

/* TEMPORARY RESTRICTION: XZ and YZ are being fixed separately and must not
   be selectable or generated for now. Their math (PLANE_TO_AXIS, RotationMath,
   the settings chips, CONFIG.allowedPlanes) is untouched and still fully
   present -- this is the single place generation is clamped to XY-only.
   To re-enable a plane later, add it back here; nothing else needs to change. */
const ENABLED_PLANES_OVERRIDE = ['XY'];

/* TEMPORARY: rotation is disabled entirely while it's being reworked.
   Nothing about RotationMath, PLANE_TO_AXIS, animateSequence, or the
   settings data model is touched -- this single flag is the only thing
   gating whether startRound() ever generates a non-empty sequence. Every
   round behaves as pure memorize-and-reconstruct until this is flipped
   back on. */
const ROTATION_FEATURE_ENABLED = false;

const ANGLE_OPTIONS = [90, 180, 270];
const DIRECTIONS = ['clockwise', 'anticlockwise'];
const DEPTH_LEVELS = { 1: 1, 2: 2, 3: 3 };            // depthLevel -> minimum span enforced per axis
const DEPTH_LABELS = { 1: 'Compact', 2: 'Balanced', 3: 'Sprawling' };

const COLOR = {
    ok: 0x6E9B6B,
    danger: 0xC1554B,
    amber: 0xE8A33D,
    userBuild: 0x5B84A6,
    target: 0xD9D3C7,
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function setToggle(node, on) { node.classList.toggle('on', on); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
/* Keys of an { key: boolean } map whose value is true, e.g. enabled planes.
   Falls back to every key if the user disabled all of them, so a round can
   never fail to generate just because a settings group was emptied out. */
function enabledKeys(map, allKeys) {
    const on = allKeys.filter((k) => map[k]);
    return on.length ? on : allKeys.slice();
}

/**
 * 2. ROTATION MATH -- single source of truth.
 * Every place that needs "what does step X do mathematically" (ground-truth
 * calculation, the reveal animation) reads it from here, so the two can
 * never drift apart the way they had in the previous version.
 *
 * Steps are specified by PLANE (XY/XZ/YZ) rather than by axis, purely for
 * user-facing clarity -- axisLetterForStep() is the single fixed lookup
 * (XY->Z, XZ->Y, YZ->X) that resolves a plane to the axis that actually
 * rotates. The per-axis math itself (axisVectorFor/signedAngleRad) is
 * unchanged from before this relabeling.
 *
 * "Clockwise" is defined as the negative right-hand-rule direction, viewed
 * looking from the positive end of the rotation axis back toward the
 * origin. This is a fixed world-space convention -- the camera's orbit
 * position is never consulted anywhere in this file, so no view angle can
 * change what a given step actually does.
 */
const RotationMath = {
    axisVectorFor(axisLetter) {
        return axisLetter === 'X' ? new THREE.Vector3(1, 0, 0)
             : axisLetter === 'Y' ? new THREE.Vector3(0, 1, 0)
             : new THREE.Vector3(0, 0, 1);
    },
    /* The ONLY place the plane name is resolved to an axis. A step is
       specified as { plane: 'XY'|'XZ'|'YZ', degrees, direction }; the actual
       rotation always happens about the corresponding fixed world axis
       (XY->Z, XZ->Y, YZ->X), so this is purely a lookup, not new math. */
    axisLetterForStep(step) { return PLANE_TO_AXIS[step.plane]; },
    signedAngleRad(step) {
        const dirMul = step.direction === 'clockwise' ? -1 : 1;
        return dirMul * (step.degrees * Math.PI / 180);
    },
    /* Cumulative quaternion for the full sequence, built by pre-multiplying
       each step's delta (world-axis rotation) onto the running total. */
    cumulativeQuaternion(sequence, uptoIndexExclusive) {
        const q = new THREE.Quaternion();
        const n = uptoIndexExclusive == null ? sequence.length : uptoIndexExclusive;
        for (let i = 0; i < n; i++) {
            const step = sequence[i];
            const delta = new THREE.Quaternion().setFromAxisAngle(
                RotationMath.axisVectorFor(RotationMath.axisLetterForStep(step)),
                RotationMath.signedAngleRad(step)
            );
            q.multiplyQuaternions(delta, q);
        }
        return q;
    },
};

/**
 * 3. MATH UTILITIES -- ground truth + scoring
 * IMPORTANT: comparisons happen in the fixed world/reconstruction coordinate
 * system with NO translation or rotation normalization. Two structures only
 * count as matching where they occupy literally the same integer cell.
 */
class MathUtils {
    static computeGroundTruth(originalCoords, sequence) {
        const q = RotationMath.cumulativeQuaternion(sequence);
        return originalCoords.map((c) => {
            const v = new THREE.Vector3(c.x, c.y, c.z).applyQuaternion(q);
            return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) };
        });
    }

    static cellKey(c) { return Math.round(c.x) + ',' + Math.round(c.y) + ',' + Math.round(c.z); }

    /* Deliberately NOT normalized: no re-centering, no best-fit rotation
       search. A voxel only counts as correct if it sits in the exact same
       world cell as the mathematically transformed original. */
    static compareStructures(truthCoords, userCoords) {
        const setTruth = new Set(truthCoords.map(MathUtils.cellKey));
        const setUser = new Set(userCoords.map(MathUtils.cellKey));

        let correct = 0, extra = 0, missing = 0;
        setUser.forEach((k) => { if (setTruth.has(k)) correct++; else extra++; });
        setTruth.forEach((k) => { if (!setUser.has(k)) missing++; });

        const totalTruth = setTruth.size;
        const accuracy = Math.round((correct / Math.max(totalTruth, 1)) * 100);
        return { accuracy, correct, missing, extra, totalTruth, setTruth, setUser };
    }
}

/* Tight integer bounding box of a coordinate set, in the SAME (unshifted)
   coordinate system the coordinates already live in. This is what the
   reconstruction grid gets sized/positioned to -- no padding, no
   re-centering. */
function boundingBoxOf(coords) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    coords.forEach((c) => {
        if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
        if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;
    });
    return { minX, maxX, minY, maxY, minZ, maxZ };
}

/**
 * 4. VOXEL OBJECT GENERATION
 * Builds a connected, genuinely-3D, asymmetric voxel structure for a given
 * target cube count. A low count grows a smaller structure from scratch
 * (fewer growth steps) rather than deleting cubes from a bigger one, so
 * "simpler" objects are simpler by construction, not by mutilation.
 */
const DIRS6 = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
];
function voxelKey(p) { return p[0] + ',' + p[1] + ',' + p[2]; }

/* Mostly extends the most recently placed cube (reads as one coherent
   structure), but occasionally branches off a random existing cube so the
   result has protrusions/depth rather than being a single snake-like path. */
function growVoxels(count, branchChance) {
    const cells = new Set();
    const positions = [[0, 0, 0]];
    cells.add(voxelKey([0, 0, 0]));
    let guard = 0;
    while (positions.length < count && guard < count * 60) {
        guard++;
        const useBranch = positions.length === 1 || Math.random() < branchChance;
        const base = useBranch
            ? positions[Math.floor(Math.random() * positions.length)]
            : positions[positions.length - 1];
        const options = DIRS6
            .map((d) => [base[0] + d[0], base[1] + d[1], base[2] + d[2]])
            .filter((p) => !cells.has(voxelKey(p)));
        if (!options.length) continue;
        const choice = options[Math.floor(Math.random() * options.length)];
        cells.add(voxelKey(choice));
        positions.push(choice);
    }
    return positions;
}

function extendWithOneCube(positions) {
    const cells = new Set(positions.map(voxelKey));
    for (let attempt = 0; attempt < 300; attempt++) {
        const base = positions[Math.floor(Math.random() * positions.length)];
        const options = DIRS6
            .map((d) => [base[0] + d[0], base[1] + d[1], base[2] + d[2]])
            .filter((p) => !cells.has(voxelKey(p)));
        if (options.length) return positions.concat([options[Math.floor(Math.random() * options.length)]]);
    }
    return positions;
}

function rangeOnAxis(positions, axis) {
    let mn = Infinity, mx = -Infinity;
    for (const p of positions) { if (p[axis] < mn) mn = p[axis]; if (p[axis] > mx) mx = p[axis]; }
    return mx - mn;
}

function ensureGenuineDepth(positions, minRange) {
    minRange = minRange || 1;
    for (let i = 0; i < 10; i++) {
        if (rangeOnAxis(positions, 0) >= minRange && rangeOnAxis(positions, 1) >= minRange && rangeOnAxis(positions, 2) >= minRange) break;
        positions = extendWithOneCube(positions);
    }
    return positions;
}

/* The 24 proper (rotation-only) symmetries of a cube -- used only to detect
   and break accidental symmetry so a shape can't be inferred from a single
   distinctive feature plus an assumption of regularity. */
const PROPER_ROTATIONS = (() => {
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const signs = [1, -1];
    const out = [];
    for (const p of perms) {
        for (const sx of signs) for (const sy of signs) for (const sz of signs) {
            const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
            m[0][p[0]] = sx; m[1][p[1]] = sy; m[2][p[2]] = sz;
            const det =
                m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
                m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
                m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            if (det === 1) out.push(m);
        }
    }
    return out;
})();
const IDENTITY_MATRIX_KEY = JSON.stringify([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);

function applyIntMatrix(positions, m) {
    return positions.map(([x, y, z]) => [
        m[0][0] * x + m[0][1] * y + m[0][2] * z,
        m[1][0] * x + m[1][1] * y + m[1][2] * z,
        m[2][0] * x + m[2][1] * y + m[2][2] * z,
    ]);
}
function normalizeShape(positions) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    for (const p of positions) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[2] < minZ) minZ = p[2];
    }
    return positions
        .map((p) => [p[0] - minX, p[1] - minY, p[2] - minZ])
        .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}
function shapeKey(positions) { return positions.map((p) => p.join(',')).join('|'); }

function hasNontrivialSymmetry(positions) {
    const selfKey = shapeKey(normalizeShape(positions));
    for (const m of PROPER_ROTATIONS) {
        if (JSON.stringify(m) === IDENTITY_MATRIX_KEY) continue;
        if (shapeKey(normalizeShape(applyIntMatrix(positions, m))) === selfKey) return true;
    }
    return false;
}

function branchChanceFor(count) { return Math.min(0.46, 0.20 + count * 0.02); }

function generateVoxelPositions(count, minDepthRange) {
    let positions = growVoxels(Math.max(1, count), branchChanceFor(count));
    positions = ensureGenuineDepth(positions, minDepthRange);
    let guard = 0;
    while (hasNontrivialSymmetry(positions) && guard < 8) {
        positions = extendWithOneCube(positions);
        guard++;
    }
    return positions;
}

/**
 * 5. STARTING FACE MARKER
 * A real Object3D living directly in the scene -- never parented under the
 * target object or the workspace, and never touched by the camera controls.
 * Camera orbiting can never move or reinterpret it: it is simply a fixed
 * landmark in world space that both the original object and the
 * reconstruction grid sit in front of, so "the starting face" means the
 * same physical place throughout the whole round.
 */
function buildStartingFaceMarker() {
    const group = new THREE.Group();
    const Z = 9;

    const planeGeo = new THREE.PlaneGeometry(12, 10);
    const planeMat = new THREE.MeshBasicMaterial({
        color: COLOR.danger, transparent: true, opacity: 0.055,
        side: THREE.DoubleSide, depthWrite: false,
    });
    const plane = new THREE.Mesh(planeGeo, planeMat);
    plane.position.set(0, 2, Z);
    group.add(plane);

    const edges = new THREE.EdgesGeometry(planeGeo);
    const frame = new THREE.LineSegments(edges, new THREE.LineDashedMaterial({
        color: COLOR.danger, dashSize: 0.35, gapSize: 0.2, transparent: true, opacity: 0.85,
    }));
    frame.position.copy(plane.position);
    frame.computeLineDistances();
    group.add(frame);

    const label = makeLabelSprite('STARTING FACE', '#C1554B');
    label.position.set(0, 7.6, Z);
    label.scale.set(3.6, 0.9, 1);
    group.add(label);

    const tick = new THREE.Mesh(
        new THREE.ConeGeometry(0.28, 0.5, 4),
        new THREE.MeshBasicMaterial({ color: COLOR.danger })
    );
    tick.position.set(0, 6.7, Z);
    tick.rotation.x = Math.PI;
    tick.rotation.y = Math.PI / 4;
    group.add(tick);

    return group;
}

function makeLabelSprite(text, cssColor) {
    const w = 512, h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.font = '700 58px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = cssColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 4);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    return new THREE.Sprite(mat);
}

/**
 * 5. TARGET OBJECT MANAGER (the original, procedurally generated object)
 */
class TargetObjectManager {
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();
        this.scene.add(this.group);

        this.baseMaterial = new THREE.MeshLambertMaterial({ color: COLOR.target });
        this.edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        this.lineMat = new THREE.LineBasicMaterial({ color: 0x14110B, transparent: true, opacity: 0.55 });
        this.originalCoords = [];
    }

    generateNew(cubeCount, minDepthRange) {
        this.clear();
        this.group.quaternion.identity();

        const positions = generateVoxelPositions(cubeCount, minDepthRange);
        positions.forEach(([x, y, z]) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.baseMaterial.clone());
            mesh.position.set(x, y, z);
            const edges = new THREE.LineSegments(this.edgesGeo, this.lineMat);
            mesh.add(edges);
            this.group.add(mesh);
        });

        // Center dynamically so the rotation axis passes through the object's
        // own middle rather than an arbitrary corner.
        const box = new THREE.Box3().setFromObject(this.group);
        const center = box.getCenter(new THREE.Vector3()).round();
        this.group.children.forEach((c) => c.position.sub(center));
        this.originalCoords = this.group.children.map((c) => ({ x: c.position.x, y: c.position.y, z: c.position.z }));
    }

    setVisible(v) { this.group.visible = v; }

    clear() {
        while (this.group.children.length > 0) this.group.remove(this.group.children[0]);
    }

    resetMaterials() {
        this.group.children.forEach((mesh) => {
            mesh.material.color.set(COLOR.target);
            mesh.material.transparent = false;
            mesh.material.opacity = 1;
        });
    }

    /* After the reveal animation settles, tint each cube by whether the
       user's reconstruction had a matching voxel in that exact final cell. */
    applyRevealColoring(userCellSet, truthCoords) {
        this.group.children.forEach((mesh, i) => {
            const cell = truthCoords[i];
            const matched = userCellSet.has(MathUtils.cellKey(cell));
            mesh.material.color.set(matched ? COLOR.ok : COLOR.target);
            mesh.material.transparent = !matched;
            mesh.material.opacity = matched ? 1 : 0.4;
        });
    }

    /* Plays the sequence as one continuous animation using the exact same
       axis/angle definitions as computeGroundTruth (see RotationMath). */
    animateSequence(sequence, opts) {
        opts = opts || {};
        const PAUSE_MS = 420;
        const STEP_MS = 950;
        return new Promise((resolve) => {
            let stepIndex = 0;
            let mode = 'rotating';
            let elapsed = 0;
            let last = performance.now();
            let stepStartQuat = this.group.quaternion.clone();

            const tick = (now) => {
                const dt = Math.min(50, now - last);
                last = now;

                if (stepIndex >= sequence.length) { resolve(); return; }
                const step = sequence[stepIndex];

                if (mode === 'rotating') {
                    elapsed += dt;
                    const t = Math.min(1, elapsed / STEP_MS);
                    const eased = easeInOutCubic(t);
                    const delta = new THREE.Quaternion().setFromAxisAngle(
                        RotationMath.axisVectorFor(RotationMath.axisLetterForStep(step)),
                        RotationMath.signedAngleRad(step) * eased
                    );
                    this.group.quaternion.copy(delta.multiply(stepStartQuat));

                    if (t >= 1) {
                        mode = 'pausing';
                        elapsed = 0;
                        stepStartQuat = this.group.quaternion.clone();
                        if (opts.onStepDone) opts.onStepDone(stepIndex);
                    }
                } else {
                    elapsed += dt;
                    if (elapsed >= PAUSE_MS) {
                        stepIndex += 1;
                        mode = 'rotating';
                        elapsed = 0;
                        if (stepIndex < sequence.length && opts.onStepStart) opts.onStepStart(stepIndex);
                    }
                }
                requestAnimationFrame(tick);
            };

            if (opts.onStepStart) opts.onStepStart(0);
            requestAnimationFrame(tick);
        });
    }
}

/**
 * 6. BUILDER WORKSPACE
 * Renders the empty fixed-frame grid and handles voxel add/remove.
 *
 * Fix summary vs. the previous version:
 *  - raycasts with recursive=false against ONLY top-level meshes (the floor
 *    plane and each built voxel), so a ray can never land on a child edge
 *    LineSegments and blow up on a missing `.face` property.
 *  - every click re-raycasts at the exact pointer position instead of
 *    trusting a possibly-stale hover state from an earlier mousemove.
 *  - target cells are resolved with exact integer math (existing voxel's
 *    stored grid cell + its exact axis-aligned face normal), never by
 *    rounding a floating-point world-space hit point, which is what made
 *    placement unreliable at grazing camera angles.
 *  - a Map keyed by "x,y,z" is the single source of truth for which cells
 *    are occupied, used for add/remove/hover so they can never disagree.
 *  - the buildable volume is constrained to the exact bounding box of the
 *    ground truth (see configureBounds) instead of an oversized sandbox, so
 *    a correctly-shaped structure placed one cell off cannot even be built.
 */

/* A rectangular grid of lines exactly (width x depth) cells -- no square
   padding the way THREE.GridHelper forces. Built in LOCAL space with one
   corner at the origin; the caller positions it so that local (0,0,0) lands
   on the true minX-0.5/minZ-0.5 corner of the allowed volume. */
function buildRectFloorGrid(width, depth, color) {
    const points = [];
    for (let i = 0; i <= width; i++) points.push(i, 0, 0, i, 0, depth);
    for (let j = 0; j <= depth; j++) points.push(0, 0, j, width, 0, j);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.45 }));
}

class BuilderWorkspace {
    constructor(scene, camera, renderer) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;

        this.isActive = false;
        this.builtVoxels = [];
        this.cellMap = new Map();
        this.maxCubes = Infinity;
        this.onCountChange = null;
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();

        // The exact allowed region, in the SAME fixed world coordinates the
        // ground truth lives in -- set per round via configureBounds(). No
        // padding, no re-centering: the grid IS this box, nothing more.
        this.bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

        this.workspaceGroup = new THREE.Group();
        this.workspaceGroup.visible = false;
        this.scene.add(this.workspaceGroup);

        this.gridMesh = null; // (re)built to fit the exact footprint each round

        this.raycastPlane = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ visible: false })
        );
        this.raycastPlane.geometry.rotateX(-Math.PI / 2);
        this.workspaceGroup.add(this.raycastPlane);

        this.buildMat = new THREE.MeshLambertMaterial({ color: COLOR.userBuild });
        this.edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        this.lineMat = new THREE.LineBasicMaterial({ color: 0x0A1016, transparent: true, opacity: 0.6 });

        this.ghostMesh = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.35, transparent: true })
        );
        this.ghostMesh.visible = false;
        this.workspaceGroup.add(this.ghostMesh);

        this.removeHighlight = new THREE.Mesh(
            new THREE.BoxGeometry(1.05, 1.05, 1.05),
            new THREE.MeshBasicMaterial({ color: COLOR.danger, opacity: 0.4, transparent: true })
        );
        this.removeHighlight.visible = false;
        this.workspaceGroup.add(this.removeHighlight);

        this._bindEvents();
    }

    /* Sizes and positions the buildable volume to EXACTLY the given
       inclusive integer range -- the tightest possible bounding box of the
       ground truth, in the same unshifted world coordinates it already
       lives in. There is deliberately no margin: since the box has zero
       slack in every direction, translating a correctly-shaped structure
       by even one cell necessarily pushes a voxel outside it.

       This also fixes the old "floor at a fixed y=-0.5" bug: that floor
       was geometrically coincident with the bottom face of any y=0 voxel,
       so a ray aimed at that bottom face (to build downward) could tie
       with -- and lose to -- the floor plane, silently resolving to y=0
       instead of y=-1 and making it look like you "couldn't place a cube"
       below the object. The floor now sits at the volume's true minY-0.5,
       so the lowest required layer is simply the floor itself. */
    configureBounds(minX, maxX, minY, maxY, minZ, maxZ) {
        this.bounds = { minX, maxX, minY, maxY, minZ, maxZ };
        const width = maxX - minX + 1;
        const depth = maxZ - minZ + 1;

        if (this.gridMesh) {
            this.workspaceGroup.remove(this.gridMesh);
            this.gridMesh.geometry.dispose();
        }
        this.gridMesh = buildRectFloorGrid(width, depth, 0x3a3f45);
        this.gridMesh.position.set(minX - 0.5, minY - 0.5, minZ - 0.5);
        this.workspaceGroup.add(this.gridMesh);

        this.raycastPlane.geometry.dispose();
        const geo = new THREE.PlaneGeometry(width, depth);
        geo.rotateX(-Math.PI / 2);
        this.raycastPlane.geometry = geo;
        this.raycastPlane.position.set((minX + maxX) / 2, minY - 0.5, (minZ + maxZ) / 2);
    }

    _inBounds(cell) {
        const b = this.bounds;
        return cell.x >= b.minX && cell.x <= b.maxX &&
               cell.y >= b.minY && cell.y <= b.maxY &&
               cell.z >= b.minZ && cell.z <= b.maxZ;
    }

    _bindEvents() {
        this.renderer.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e));
        this.renderer.domElement.addEventListener('mousedown', (e) => this.onMouseDown(e));
    }

    setActive(active) { this.isActive = active; }
    setVisible(v) { this.workspaceGroup.visible = v; if (!v) { this.ghostMesh.visible = false; this.removeHighlight.visible = false; } }

    setMaxCubes(n) { this.maxCubes = n; this._notifyCountChange(); }
    _notifyCountChange() { if (this.onCountChange) this.onCountChange(this.builtVoxels.length, this.maxCubes); }
    atCapacity() { return this.builtVoxels.length >= this.maxCubes; }

    clear() {
        this.builtVoxels.forEach((v) => this.workspaceGroup.remove(v));
        this.builtVoxels = [];
        this.cellMap.clear();
        this.ghostMesh.visible = false;
        this.removeHighlight.visible = false;
        this._notifyCountChange();
    }

    _key(c) { return c.x + ',' + c.y + ',' + c.z; }

    /* Casts a ray for the given screen point and resolves it to an exact
       integer target cell -- either the floor cell (for the base layer) or
       an existing voxel's cell plus its exact face normal. Never rounds a
       floating-point hit point for the coordinates that matter. */
    _resolveHit(clientX, clientY) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        this.raycaster.setFromCamera(this.mouse, this.camera);

        const targets = [this.raycastPlane, ...this.builtVoxels];
        const hits = this.raycaster.intersectObjects(targets, false); // never recurse into edge children
        if (!hits.length) return null;

        const hit = hits[0];
        if (hit.object === this.raycastPlane) {
            return {
                kind: 'floor',
                existingCell: null,
                targetCell: { x: Math.round(hit.point.x), y: this.bounds.minY, z: Math.round(hit.point.z) },
            };
        }

        const cell = hit.object.userData.cell;
        const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).round();
        return {
            kind: 'voxel',
            existingCell: cell,
            targetCell: { x: cell.x + n.x, y: cell.y + n.y, z: cell.z + n.z },
        };
    }

    onMouseMove(e) {
        if (!this.isActive) return;
        const hit = this._resolveHit(e.clientX, e.clientY);
        if (!hit) { this.ghostMesh.visible = false; this.removeHighlight.visible = false; return; }

        if (e.shiftKey && hit.kind === 'voxel') {
            this.ghostMesh.visible = false;
            this.removeHighlight.position.set(hit.existingCell.x, hit.existingCell.y, hit.existingCell.z);
            this.removeHighlight.visible = true;
        } else {
            this.removeHighlight.visible = false;
            const occupied = this.cellMap.has(this._key(hit.targetCell));
            const blocked = occupied || this.atCapacity() || !this._inBounds(hit.targetCell);
            this.ghostMesh.position.set(hit.targetCell.x, hit.targetCell.y, hit.targetCell.z);
            this.ghostMesh.visible = !blocked;
        }
    }

    onMouseDown(e) {
        if (!this.isActive || e.button !== 0) return; // left click only; right stays free for orbit
        e.preventDefault();
        const hit = this._resolveHit(e.clientX, e.clientY);
        if (!hit) return;

        if (e.shiftKey) {
            if (hit.kind === 'voxel') this._removeCell(hit.existingCell);
            return;
        }
        this._addCell(hit.targetCell);
    }

    _addCell(cell) {
        const key = this._key(cell);
        if (this.cellMap.has(key)) return;
        if (this.atCapacity()) return; // hard cap at the target's own cube count -- see setMaxCubes
        if (!this._inBounds(cell)) return; // outside the fixed reconstruction volume -- see configureBounds
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.buildMat.clone());
        mesh.position.set(cell.x, cell.y, cell.z);
        mesh.userData.cell = { x: cell.x, y: cell.y, z: cell.z };
        const edges = new THREE.LineSegments(this.edgesGeo, this.lineMat);
        mesh.add(edges);
        this.workspaceGroup.add(mesh);
        this.builtVoxels.push(mesh);
        this.cellMap.set(key, mesh);
        this.ghostMesh.visible = false;
        this._notifyCountChange();
    }

    _removeCell(cell) {
        const key = this._key(cell);
        const mesh = this.cellMap.get(key);
        if (!mesh) return;
        this.workspaceGroup.remove(mesh);
        this.builtVoxels = this.builtVoxels.filter((v) => v !== mesh);
        this.cellMap.delete(key);
        this.removeHighlight.visible = false;
        this._notifyCountChange();
    }

    getUserCoords() {
        return this.builtVoxels.map((m) => ({ x: m.position.x, y: m.position.y, z: m.position.z }));
    }

    /* Tint each built voxel green/red depending on whether it matches a
       cell in the ground truth -- immediate, per-voxel submit feedback. */
    applyResultColoring(truthCellSet) {
        this.builtVoxels.forEach((mesh) => {
            const correct = truthCellSet.has(this._key(mesh.userData.cell));
            mesh.material.color.set(correct ? COLOR.ok : COLOR.danger);
        });
    }
}

/**
 * 7. HAND-ROLLED ORBIT CAMERA
 * Replaces the external OrbitControls/tween.js dependencies (which also
 * meant one less CDN round-trip that could fail). Supports per-phase
 * remapping of which mouse button orbits, an idle auto-rotate for the
 * explore phase, and a spherical (theta/phi/radius) tween used for the
 * canonical-orientation transition.
 */
class SimpleOrbit {
    constructor(camera, dom) {
        this.camera = camera;
        this.dom = dom;
        this.target = new THREE.Vector3(0, 0, 0);
        this.theta = Math.PI / 4;
        this.phi = Math.PI / 2.6;
        this.radius = 14;
        this.minRadius = 4;
        this.maxRadius = 40;
        this.enabled = true;
        this.autoRotate = false;
        this.autoRotateSpeed = 0.18;
        this.rotateButton = 0;
        this._dragging = false;
        this._lastX = 0; this._lastY = 0;
        this._bind();
        this._apply();
    }

    _bind() {
        this.dom.addEventListener('mousedown', (e) => {
            if (!this.enabled || e.button !== this.rotateButton) return;
            this._dragging = true;
            this._lastX = e.clientX; this._lastY = e.clientY;
        });
        window.addEventListener('mousemove', (e) => {
            if (!this._dragging) return;
            const dx = e.clientX - this._lastX, dy = e.clientY - this._lastY;
            this._lastX = e.clientX; this._lastY = e.clientY;
            this.theta -= dx * 0.0072;
            this.phi = clamp(this.phi - dy * 0.0072, 0.12, Math.PI - 0.12);
            this._apply();
        });
        window.addEventListener('mouseup', () => { this._dragging = false; });
        this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
        this.dom.addEventListener('wheel', (e) => {
            if (!this.enabled) return;
            e.preventDefault();
            this.radius = clamp(this.radius * (1 + e.deltaY * 0.001), this.minRadius, this.maxRadius);
            this._apply();
        }, { passive: false });
    }

    _apply() {
        const s = Math.sin(this.phi);
        this.camera.position.set(
            this.target.x + this.radius * s * Math.sin(this.theta),
            this.target.y + this.radius * Math.cos(this.phi),
            this.target.z + this.radius * s * Math.cos(this.theta)
        );
        this.camera.lookAt(this.target);
    }

    set(theta, phi, radius) { this.theta = theta; this.phi = phi; this.radius = radius; this._apply(); }

    update(dt) {
        if (this.autoRotate && this.enabled && !this._dragging) {
            this.theta += this.autoRotateSpeed * dt;
            this._apply();
        }
    }

    tweenTo(theta, phi, radius, seconds) {
        return new Promise((resolve) => {
            const fromTheta = this.theta, fromPhi = this.phi, fromRadius = this.radius;
            let d = (theta - fromTheta) % (Math.PI * 2);
            if (d > Math.PI) d -= Math.PI * 2;
            if (d < -Math.PI) d += Math.PI * 2;
            const start = performance.now();
            const step = (now) => {
                const t = clamp((now - start) / (seconds * 1000), 0, 1);
                const eased = easeInOutCubic(t);
                this.theta = fromTheta + d * eased;
                this.phi = fromPhi + (phi - fromPhi) * eased;
                this.radius = fromRadius + (radius - fromRadius) * eased;
                this._apply();
                if (t < 1) requestAnimationFrame(step); else resolve();
            };
            requestAnimationFrame(step);
        });
    }
}

/**
 * 8. CORE SCENE & APP CONTROLLER
 */
class SpatialRotationApp {
    constructor() {
        this.initScene();
        this.bindUI();

        this.targetObj = new TargetObjectManager(this.scene);
        this.workspace = new BuilderWorkspace(this.scene, this.camera, this.renderer);
        this.scene.add(buildStartingFaceMarker());

        this.currentState = STATES.INIT;
        this.currentSequence = [];
        this.timerInterval = null;
        this.lastTruthCoords = null;
        this.lastResults = null;

        let last = performance.now();
        const animate = (now) => {
            requestAnimationFrame(animate);
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            this.controls.update(dt);
            this.renderer.render(this.scene, this.camera);
        };
        animate(last);

        this.startRound();
    }

    initScene() {
        this.container = document.getElementById('canvas-container');
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0B0D0F);

        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.container.appendChild(this.renderer.domElement);

        this.controls = new SimpleOrbit(this.camera, this.renderer.domElement);

        this.scene.add(new THREE.HemisphereLight(0x3a3f45, 0x08090a, 0.5));
        this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
        const key = new THREE.DirectionalLight(0xfff2df, 0.9);
        key.position.set(10, 20, 10);
        this.scene.add(key);
        const fill = new THREE.DirectionalLight(0x6f8fae, 0.35);
        fill.position.set(-10, -6, -8);
        this.scene.add(fill);

        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    bindUI() {
        this.els = {
            status: document.getElementById('status-text'),
            timer: document.getElementById('timer-text'),
            instructionsBox: document.getElementById('msg-instructions'),
            instructionsHeading: document.getElementById('instructions-heading'),
            instructionsLead: document.getElementById('instructions-lead'),
            instructionList: document.getElementById('instruction-list'),
            feedbackBox: document.getElementById('msg-feedback'),
            resultsContainer: document.getElementById('results-container'),
            builderControls: document.getElementById('builder-controls'),
            cubeCounter: document.getElementById('cube-counter'),
            cubeCounterText: document.getElementById('cube-counter-text'),
            cubeCounterFill: document.getElementById('cube-counter-fill'),
            settingsModal: document.getElementById('settings-modal'),
            seedTag: document.getElementById('seed-tag'),

            btnStartRecon: document.getElementById('btn-start-reconstruct'),
            btnSubmit: document.getElementById('btn-submit'),
            btnShowTruth: document.getElementById('btn-show-truth'),
            btnNext: document.getElementById('btn-next'),
            btnSettings: document.getElementById('settings-btn'),
            btnCloseSettings: document.getElementById('close-settings'),

            presetChips: document.getElementById('preset-chips'),
            minCubesSlider: document.getElementById('min-cubes-slider'),
            minCubesValue: document.getElementById('min-cubes-value'),
            maxCubesSlider: document.getElementById('max-cubes-slider'),
            maxCubesValue: document.getElementById('max-cubes-value'),
            depthChips: document.getElementById('depth-chips'),
            exposureChips: document.getElementById('exposure-chips'),
            setTime: document.getElementById('set-time'),
        };

        this.els.btnStartRecon.addEventListener('click', () => this.enterReconstructionPhase());
        this.els.btnSubmit.addEventListener('click', () => this.submitReconstruction());
        this.els.btnShowTruth.addEventListener('click', () => this.revealTruth());
        this.els.btnNext.addEventListener('click', () => this.startRound());

        this.els.btnSettings.addEventListener('click', () => { this.els.settingsModal.style.display = 'flex'; });
        this.els.btnCloseSettings.addEventListener('click', () => {
            this.els.settingsModal.style.display = 'none';
            this.startRound();
        });

        const clearPresetHighlight = () => {
            Array.from(this.els.presetChips.children).forEach((c) => c.classList.remove('active'));
        };
        const markCustom = () => {
            clearPresetHighlight();
            const customChip = Array.from(this.els.presetChips.children).find((c) => c.dataset.preset === 'custom');
            if (customChip) customChip.classList.add('active');
        };

        Array.from(this.els.presetChips.children).forEach((chip) => {
            chip.addEventListener('click', () => {
                if (chip.dataset.preset === 'custom') {
                    clearPresetHighlight();
                    chip.classList.add('active');
                    return; // Custom has no values of its own -- just marks the state
                }
                const preset = PRESETS[chip.dataset.preset];
                if (!preset) return;
                CONFIG.minCubes = preset.minCubes;
                CONFIG.maxCubes = preset.maxCubes;
                CONFIG.depthLevel = preset.depthLevel;
                CONFIG.explorationTime = preset.explorationTime;
                this.syncSettingsUI();
                Array.from(this.els.presetChips.children).forEach((c) => c.classList.toggle('active', c === chip));
            });
        });

        this.els.minCubesSlider.addEventListener('input', () => {
            CONFIG.minCubes = parseInt(this.els.minCubesSlider.value, 10);
            if (CONFIG.minCubes > CONFIG.maxCubes) {
                CONFIG.maxCubes = CONFIG.minCubes;
                this.els.maxCubesSlider.value = CONFIG.maxCubes;
                this.els.maxCubesValue.textContent = CONFIG.maxCubes;
            }
            this.els.minCubesValue.textContent = CONFIG.minCubes;
            markCustom();
        });
        this.els.maxCubesSlider.addEventListener('input', () => {
            CONFIG.maxCubes = parseInt(this.els.maxCubesSlider.value, 10);
            if (CONFIG.maxCubes < CONFIG.minCubes) {
                CONFIG.minCubes = CONFIG.maxCubes;
                this.els.minCubesSlider.value = CONFIG.minCubes;
                this.els.minCubesValue.textContent = CONFIG.minCubes;
            }
            this.els.maxCubesValue.textContent = CONFIG.maxCubes;
            markCustom();
        });

        Array.from(this.els.depthChips.children).forEach((chip) => {
            chip.addEventListener('click', () => {
                CONFIG.depthLevel = parseInt(chip.dataset.depth, 10);
                Array.from(this.els.depthChips.children).forEach((c) => c.classList.toggle('active', c === chip));
                markCustom();
            });
        });

        Array.from(this.els.exposureChips.children).forEach((chip) => {
            chip.addEventListener('click', () => {
                CONFIG.explorationTime = parseInt(chip.dataset.time, 10);
                this.els.setTime.value = CONFIG.explorationTime;
                Array.from(this.els.exposureChips.children).forEach((c) => c.classList.toggle('active', c === chip));
                markCustom();
            });
        });
        this.els.setTime.addEventListener('input', () => {
            const v = parseInt(this.els.setTime.value, 10);
            if (!Number.isNaN(v) && v > 0) CONFIG.explorationTime = v;
            Array.from(this.els.exposureChips.children).forEach((c) => c.classList.toggle('active', parseInt(c.dataset.time, 10) === CONFIG.explorationTime));
            markCustom();
        });

        this.syncSettingsUI();
    }

    /* Pushes CONFIG's current values into every settings control -- used on
       boot and whenever a preset is applied, so manual controls always
       reflect reality regardless of how they were last changed. */
    syncSettingsUI() {
        this.els.minCubesSlider.value = CONFIG.minCubes;
        this.els.minCubesValue.textContent = CONFIG.minCubes;
        this.els.maxCubesSlider.value = CONFIG.maxCubes;
        this.els.maxCubesValue.textContent = CONFIG.maxCubes;

        Array.from(this.els.depthChips.children).forEach((c) => c.classList.toggle('active', parseInt(c.dataset.depth, 10) === CONFIG.depthLevel));

        this.els.setTime.value = CONFIG.explorationTime;
        Array.from(this.els.exposureChips.children).forEach((c) => c.classList.toggle('active', parseInt(c.dataset.time, 10) === CONFIG.explorationTime));
    }

    updateState(state) {
        this.currentState = state;
        this.els.status.innerText = state;
        this.els.timer.innerText = '';
        this.els.instructionsBox.style.display = 'none';
        this.els.feedbackBox.style.display = 'none';
        this.els.builderControls.style.display = 'none';
        this.els.btnNext.style.display = 'none';
    }

    startRound() {
        clearInterval(this.timerInterval);
        this.updateState(STATES.EXPLORE);

        this.seed = Date.now() ^ Math.floor(Math.random() * 0xffffffff);
        this.els.seedTag.textContent = 'seed ' + (this.seed >>> 0);

        const cubeCount = randInt(Math.min(CONFIG.minCubes, CONFIG.maxCubes), Math.max(CONFIG.minCubes, CONFIG.maxCubes));
        const minDepthRange = DEPTH_LEVELS[CONFIG.depthLevel] || 1;
        this.targetObj.generateNew(cubeCount, minDepthRange);
        this.targetObj.resetMaterials();
        this.targetObj.setVisible(true);

        this.workspace.setActive(false);
        this.workspace.clear();
        this.workspace.setVisible(false);

        this.controls.enabled = true;
        this.controls.rotateButton = 0;
        this.controls.autoRotate = true;
        this.controls.target.set(0, 0, 0); // fresh object is centered at world origin
        this.controls.set(Math.PI / 4, Math.PI / 2.6, 12);

        this.currentSequence = [];
        if (ROTATION_FEATURE_ENABLED && CONFIG.rotationsEnabled) {
            // Intersect with the temporary override so XZ/YZ can never be
            // generated even if CONFIG.allowedPlanes ever says otherwise
            // (stale settings, a future preset, etc). See the override's
            // definition above for how to lift this later.
            const requestedPlanes = enabledKeys(CONFIG.allowedPlanes, PLANES);
            const planePool = requestedPlanes.filter((p) => ENABLED_PLANES_OVERRIDE.includes(p));
            const activePlanePool = planePool.length ? planePool : ENABLED_PLANES_OVERRIDE;
            const anglePool = enabledKeys(CONFIG.allowedAngles, ANGLE_OPTIONS);
            const directionPool = enabledKeys(CONFIG.allowedDirections, DIRECTIONS);
            for (let i = 0; i < CONFIG.rotationSteps; i++) {
                this.currentSequence.push({
                    plane: pickRandom(activePlanePool),
                    degrees: pickRandom(anglePool),
                    direction: pickRandom(directionPool),
                });
            }
        }

        // Computed once per round and reused everywhere (grid bounds, scoring,
        // reveal) so the buildable volume and the scored ground truth can
        // never drift apart.
        this.currentGroundTruth = MathUtils.computeGroundTruth(this.targetObj.originalCoords, this.currentSequence);

        let timeLeft = CONFIG.explorationTime;
        this.els.timer.innerText = `${timeLeft}s`;
        this.timerInterval = setInterval(() => {
            timeLeft--;
            this.els.timer.innerText = `${timeLeft}s`;
            if (timeLeft <= 0) {
                clearInterval(this.timerInterval);
                this.enterCanonicalPhase();
            }
        }, 1000);
    }

    async enterCanonicalPhase() {
        this.updateState(STATES.CANONICAL);
        this.controls.autoRotate = false;
        this.controls.enabled = false;
        await this.controls.tweenTo(0, Math.PI / 2, 12, 1.0);
        await delay(1200); // hold the canonical view so the "starting face" reads clearly
        this.enterMentalPhase();
    }

    enterMentalPhase() {
        this.updateState(STATES.MENTAL);
        this.targetObj.setVisible(false); // fully blind -- no ghost, no wireframe, no hint

        if (this.currentSequence.length) {
            this.els.instructionsHeading.textContent = 'Mental rotation';
            this.els.instructionsLead.textContent = 'Mentally apply these transformations to the object you just studied.';
            this.els.instructionList.innerHTML = this.currentSequence.map((step, i) => `
                <div class="instruction-step">
                    <span class="step-num">Step ${i + 1}</span>
                    <span class="step-detail">${step.degrees}\u00B0 ${step.direction}</span>
                    <span class="step-sep">&mdash;</span>
                    <span class="step-plane">${step.plane}</span>
                </div>
            `).join('');
        } else {
            this.els.instructionsHeading.textContent = 'Memorize & reconstruct';
            this.els.instructionsLead.textContent = 'No rotation this round -- rebuild the object exactly as you saw it, relative to the starting face.';
            this.els.instructionList.innerHTML = '';
        }
        this.els.instructionsBox.style.display = 'block';
    }

    enterReconstructionPhase() {
        this.updateState(STATES.RECONSTRUCT);

        const b = boundingBoxOf(this.currentGroundTruth);
        this.workspace.configureBounds(b.minX, b.maxX, b.minY, b.maxY, b.minZ, b.maxZ);

        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        const spanX = b.maxX - b.minX + 1, spanY = b.maxY - b.minY + 1, spanZ = b.maxZ - b.minZ + 1;
        const diag = Math.sqrt(spanX * spanX + spanY * spanY + spanZ * spanZ);

        this.controls.enabled = true;
        this.controls.rotateButton = 2; // right-drag orbits; left click is reserved for building
        this.controls.target.set(cx, cy, cz);
        this.controls.set(Math.PI / 5, Math.PI / 2.4, clamp(diag * 1.7, 8, 30));

        this.workspace.onCountChange = (count, max) => {
            this.els.cubeCounterText.textContent = `Cubes: ${count} / ${max}`;
            this.els.cubeCounterFill.style.width = `${max > 0 ? Math.min(100, (count / max) * 100) : 0}%`;
        };
        this.workspace.setMaxCubes(this.targetObj.originalCoords.length);
        this.workspace.setActive(true);
        this.workspace.setVisible(true);
        this.els.builderControls.style.display = 'flex';
    }

    submitReconstruction() {
        this.updateState(STATES.FEEDBACK);
        this.workspace.setActive(false); // locks editing; workspace stays visible for comparison
        this.controls.enabled = true;
        this.controls.rotateButton = 2;

        const userCoords = this.workspace.getUserCoords();
        this.lastTruthCoords = this.currentGroundTruth;
        const results = MathUtils.compareStructures(this.lastTruthCoords, userCoords);
        this.lastResults = results;

        this.workspace.applyResultColoring(results.setTruth);

        const colorClass = results.accuracy === 100 ? 'res-good' : (results.accuracy >= 50 ? 'res-accent' : 'res-bad');
        this.els.resultsContainer.innerHTML = `
            <div class="accuracy-cell ${colorClass}">Reconstruction accuracy<span class="num">${results.accuracy}%</span></div>
            <div class="res-good">Correct voxels<span class="num">${results.correct}</span></div>
            <div class="res-bad">Missing voxels<span class="num">${results.missing}</span></div>
            <div class="res-bad">Extra voxels<span class="num">${results.extra}</span></div>
            <div>Target voxels<span class="num">${results.totalTruth}</span></div>
        `;
        this.els.feedbackBox.style.display = 'block';
    }

    async revealTruth() {
        this.updateState(STATES.REVEAL);
        this.els.feedbackBox.style.display = 'block'; // keep the score panel up while the truth plays

        this.targetObj.resetMaterials();
        this.targetObj.setVisible(true);
        this.targetObj.group.quaternion.identity();
        // Workspace is intentionally left visible: the point is to compare
        // the user's own reconstruction against the correct transformed
        // object settling into the same fixed coordinate frame.

        this.controls.enabled = true;
        this.controls.rotateButton = 0;
        // Canonical "+Z looking toward the origin" -- the exact viewpoint
        // clockwise/anticlockwise are mathematically defined from (see
        // RotationMath, and the identical angle used in enterCanonicalPhase).
        // An oblique angle here was the actual bug: XY rotation is proven
        // correct (Z is untouched -- see the test suite), but X and Y DO
        // change, and viewing that change from off-axis creates parallax
        // that reads as the object tipping toward/away from the viewer even
        // though no coordinate ever leaves the XY plane. Watching from the
        // same axis the rotation is defined against removes that illusion.
        this.controls.set(0, Math.PI / 2, 16);

        await delay(500);
        await this.targetObj.animateSequence(this.currentSequence);
        this.targetObj.applyRevealColoring(this.lastResults.setUser, this.lastTruthCoords);

        this.els.btnNext.style.display = 'block';
    }
}

window.onload = () => { new SpatialRotationApp(); };
