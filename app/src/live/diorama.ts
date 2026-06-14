// ThroughNet live-view diorama — the paper-craft scene, ported from the approved
// prototype (app/prototypes/live-view.html). Pure three.js; no DOM/UI concerns
// beyond positioning the 3D-anchored labels it is handed. The owning Lit
// component (tn-live-view) drives it via setState / setAutoRotate.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import gsap from 'gsap';
import type { SensingState } from './types';

export interface DioramaLabels {
  tx: HTMLElement;
  rx2: HTMLElement;
  rx3: HTMLElement;
  presence: HTMLElement;
}

export interface DioramaHandle {
  setState(patch: Partial<SensingState>): void;
  setAutoRotate(on: boolean): void;
  dispose(): void;
}

// internal animated state (logical state + gsap-tweened render quantities)
interface RenderState extends SensingState {
  motion: number;
  baseScale: number;
  phase: number;
}

export function createDiorama(canvas: HTMLCanvasElement, labels: DioramaLabels): DioramaHandle {
  // ── palette ──────────────────────────────────────────────
  const INK = 0x2B2A26;
  const CLAY = 0xE7BFAE;   // presence gem — soft pastel coral-terracotta
  const SAND = 0xE4D3B4;   // TX illuminator crystal — pale amber
  const SLATE = 0xAFC0D2;  // RX node crystals — pastel dusty blue
  const STONE = 0xE0D6C4, STONE2 = 0xD7C8B0;   // the room platform / pavers

  // ── renderer / scene / camera ────────────────────────────
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const skyTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 256;
    const x = cv.getContext('2d')!; const g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#E9ECF0'); g.addColorStop(0.45, '#F3ECE6');
    g.addColorStop(0.78, '#F0DACE'); g.addColorStop(1.00, '#EAD7CC');
    x.fillStyle = g; x.fillRect(0, 0, 8, 256);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  scene.background = skyTex;
  // gentle haze so only the far meadow edge melts into the horizon
  scene.fog = new THREE.Fog(0xEDE3D9, 12.0, 30.0);

  const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 100);
  const CAM = new THREE.Vector3(0.12, 1.16, 4.55);
  camera.position.copy(CAM);
  const LOOK = new THREE.Vector3(0, 0.50, 0);
  camera.lookAt(LOOK);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(LOOK);
  controls.enableDamping = true; controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 2.4; controls.maxDistance = 8.0;
  controls.minPolarAngle = 0.35; controls.maxPolarAngle = 1.46;
  controls.autoRotate = true; controls.autoRotateSpeed = 0.35;
  controls.update();

  // ── lights ───────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xfff8ec, 1.05));
  scene.add(new THREE.HemisphereLight(0xffffff, 0xEDE6D9, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.05); key.position.set(3, 5, 2.5); scene.add(key);

  // light toon ramp => soft flat pastel fills; the ink outline does the drawing
  const toneMap = (() => {
    const d = new Uint8Array([196, 222, 244, 255]);
    const t = new THREE.DataTexture(d, d.length, 1, THREE.RedFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t;
  })();
  const toon = (color: number) => new THREE.MeshToonMaterial({ color, gradientMap: toneMap });

  // ── groups: outlined (edge pass) vs deco (colour only) ───
  const outlineGroup = new THREE.Group();
  const decoGroup = new THREE.Group();
  scene.add(outlineGroup, decoGroup);

  // ── ground: hand-drawn paper grass texture ───────────────
  const gridTex = (() => {
    const s = 1024, cv = document.createElement('canvas'); cv.width = cv.height = s;
    const x = cv.getContext('2d')!; x.fillStyle = '#E7E8DC'; x.fillRect(0, 0, s, s);
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.fillStyle = 'rgba(43,42,38,0.20)';
    for (let i = 0; i < 1500; i++) { x.beginPath(); x.arc(Math.random() * s, Math.random() * s, 0.5 + Math.random() * 0.8, 0, 6.283); x.fill(); }
    for (let i = 0; i < 560; i++) {
      const px = Math.random() * s, py = Math.random() * s, h = 4 + Math.random() * 7;
      x.strokeStyle = 'rgba(43,42,38,' + (0.32 + Math.random() * 0.2) + ')'; x.lineWidth = 0.8;
      for (let b = -1; b <= 1; b++) { x.beginPath(); x.moveTo(px, py); x.quadraticCurveTo(px + b * 2, py - h * 0.6, px + b * 3 + (Math.random() * 2 - 1), py - h); x.stroke(); }
    }
    x.strokeStyle = 'rgba(43,42,38,0.4)'; x.lineWidth = 0.9;
    for (let i = 0; i < 70; i++) {
      const px = Math.random() * s, py = Math.random() * s; x.beginPath(); x.moveTo(px, py);
      for (let a = 0; a < 3.0; a += 0.3) { const r = 1.4 + a * 1.5; x.lineTo(px + Math.cos(a * 2) * r, py - a * 3 - Math.sin(a * 2) * r); }
      x.stroke();
    }
    const t = new THREE.CanvasTexture(cv); t.anisotropy = 8; return t;
  })();
  gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping; gridTex.repeat.set(4.6, 4.6);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(11, 96), new THREE.MeshBasicMaterial({ map: gridTex, color: 0xF6F4EE }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = 0; decoGroup.add(ground);

  // soft radial contact-shadow texture
  const shadowTex = (() => {
    const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
    const x = cv.getContext('2d')!; const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(43,42,38,0.30)'); g.addColorStop(0.55, 'rgba(43,42,38,0.10)');
    g.addColorStop(1, 'rgba(43,42,38,0)'); x.fillStyle = g; x.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  })();
  const contactShadow = (r: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(r, r), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.004; decoGroup.add(m); return m;
  };

  // ── the "room": stone platform under the presence ────────
  const platform = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.78, 0.045, 56), toon(STONE));
  platform.position.y = 0.022; outlineGroup.add(platform);
  const inlay = new THREE.Mesh(new THREE.TorusGeometry(1.34, 0.016, 6, 72), toon(STONE2));
  inlay.rotation.x = -Math.PI / 2; inlay.position.y = 0.05; outlineGroup.add(inlay);
  const paver = (x: number, z: number, r: number, rot: number, col: number, sides: number) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, sides), toon(col));
    m.position.set(x, 0.05, z); m.rotation.y = rot; m.scale.set(1, 1, 0.66 + Math.random() * 0.3); outlineGroup.add(m); return m;
  };
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * 6.283 + (Math.random() - 0.5) * 0.2, rr = 1.46 + Math.random() * 0.18;
    paver(Math.cos(a) * rr, Math.sin(a) * rr, 0.16 + Math.random() * 0.07, a + Math.random() * 0.6, i % 2 ? STONE2 : STONE, 4 + ((Math.random() * 3) | 0));
  }
  for (let i = 0; i < 3; i++) paver((i % 2 ? 1 : -1) * (0.2 + i * 0.06), 2.15 + i * 0.66, 0.24 - i * 0.03, Math.random() * 6.28, STONE, 5);

  // ── nodes (the 3 ESP32 sensors) — bigger floating crystals ─
  const NODE_Y = 0.64;
  const nodeGeo = new THREE.OctahedronGeometry(0.18, 0);
  const nodeObjs: { mesh: THREE.Mesh; baseY: number; phase: number }[] = [];
  const mkNode = (pos: THREE.Vector3, mat: THREE.Material, rot: number) => {
    const m = new THREE.Mesh(nodeGeo, mat);
    m.position.set(pos.x, NODE_Y, pos.z); m.scale.set(1.12, 1.95, 1.12); m.rotation.y = rot; outlineGroup.add(m);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.04, 6), toon(STONE2));
    disc.position.set(pos.x, 0.085, pos.z); disc.rotation.y = rot; outlineGroup.add(disc);
    contactShadow(0.6).position.set(pos.x, 0.078, pos.z);
    nodeObjs.push({ mesh: m, baseY: NODE_Y, phase: Math.random() * 6.28 }); return m;
  };
  const P_TX = new THREE.Vector3(0.0, NODE_Y, -1.5);
  const P_RX2 = new THREE.Vector3(-1.5, NODE_Y, 0.98);
  const P_RX3 = new THREE.Vector3(1.5, NODE_Y, 0.98);
  mkNode(P_TX, toon(SAND), 0.3);
  mkNode(P_RX2, toon(SLATE), -0.6);
  mkNode(P_RX3, toon(SLATE), 0.9);
  const clearOfNodes = (x: number, z: number, pad: number) => [P_TX, P_RX2, P_RX3].every(p => Math.hypot(x - p.x, z - p.z) > pad);

  // ── presence: a floating faceted gem (not a blob) ────────
  const GEM_Y = 0.96, GEM_TALL = 1.4;
  const gem = new THREE.Mesh(new THREE.IcosahedronGeometry(0.46, 0), toon(CLAY));
  gem.position.set(0, GEM_Y, 0); gem.scale.set(0.9, GEM_TALL, 0.9); gem.rotation.set(0.13, 0.4, 0.06); outlineGroup.add(gem);
  const aura = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.02, 8, 60), toon(CLAY));
  aura.rotation.x = -Math.PI / 2; aura.position.y = 0.1; outlineGroup.add(aura);
  const stoneShadow = contactShadow(1.3); stoneShadow.position.set(0, 0.08, 0);

  // ── RF links (thin ink tubes; ripple when moving) ────────
  const linkMat = new THREE.MeshBasicMaterial({ color: INK });
  const SEG = 54;
  const mkLink = (a: THREE.Vector3, b: THREE.Vector3) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), linkMat); decoGroup.add(m); return { mesh: m, a: a.clone(), b: b.clone() };
  };
  const links = [mkLink(P_TX, P_RX2), mkLink(P_TX, P_RX3)];
  const _up = new THREE.Vector3(0, 1, 0);
  const updateLink = (L: typeof links[number], t: number) => {
    const dir = new THREE.Vector3().subVectors(L.b, L.a); const len = dir.length(); dir.normalize();
    let side = new THREE.Vector3().crossVectors(dir, _up); if (side.lengthSq() < 1e-4) side.set(1, 0, 0); side.normalize();
    const up2 = new THREE.Vector3().crossVectors(side, dir).normalize();
    const pts: THREE.Vector3[] = []; const amp = 0.085 * S.motion;
    for (let i = 0; i <= SEG; i++) {
      const s = i / SEG; const p = new THREE.Vector3().copy(L.a).addScaledVector(dir, len * s);
      const env = Math.sin(s * Math.PI); const ph = s * 9.0 - t * 7.0;
      p.addScaledVector(side, Math.sin(ph) * amp * env); p.addScaledVector(up2, Math.cos(ph * 0.8) * amp * 0.7 * env); pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    L.mesh.geometry.dispose(); L.mesh.geometry = new THREE.TubeGeometry(curve, SEG, 0.02, 6, false);
  };

  // ── ambient dressing: rocks + flora + trees + grass ──────
  const ROCK = 0xBCC8BC, ROCK2 = 0xD8BCAE;
  const LEAF = 0xB4C7B0, LEAF2 = 0xAAC2C6;
  const swayers: { pivot: THREE.Object3D; amp: number; speed: number; phase: number }[] = [];

  const rock = (x: number, z: number, r: number, color: number) => {
    const g = new THREE.IcosahedronGeometry(r, 1); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(p, i); v.y *= 0.7; v.multiplyScalar(0.88 + Math.random() * 0.24); p.setXYZ(i, v.x, v.y, v.z); }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, toon(color)); m.position.set(x, r * 0.55, z); m.rotation.y = Math.random() * 6.28; outlineGroup.add(m);
    contactShadow(r * 3.4).position.set(x, 0.004, z); return m;
  };

  const plant = (x: number, z: number, h: number, color: number) => {
    const pivot = new THREE.Object3D(); pivot.position.set(x, 0, z); outlineGroup.add(pivot);
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.02 * h, 0.45 * h, 0.01 * h), new THREE.Vector3(-0.03 * h, 0.8 * h, 0), new THREE.Vector3(0.04 * h, h, 0.02 * h)]);
    pivot.add(new THREE.Mesh(new THREE.TubeGeometry(c, 14, 0.016, 6, false), toon(color)));
    for (const u of [0.55, 0.8, 1.0]) {
      const pt = c.getPoint(u); const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.05 * h, 8, 6), toon(color));
      leaf.scale.set(1.7, 0.6, 1.0); leaf.position.copy(pt); leaf.position.x += 0.06 * h * ((u - 0.5) > 0 ? 1 : -1); leaf.rotation.z = u * 5.0; pivot.add(leaf);
    }
    contactShadow(h * 0.7).position.set(x, 0.004, z);
    swayers.push({ pivot, amp: 0.05 + Math.random() * 0.04, speed: 0.6 + Math.random() * 0.5, phase: Math.random() * 6.28 }); return pivot;
  };

  const tree = (x: number, z: number, s: number) => {
    const g = new THREE.Group(); g.position.set(x, 0, z);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * s, 0.06 * s, 0.5 * s, 6), toon(0xCBB59C)); trunk.position.y = 0.25 * s; g.add(trunk);
    const cm = toon(0xB0C2A6);
    for (const [cx, cy, cz, cr] of [[0, 0.66, 0, 0.36], [0.24, 0.58, 0.06, 0.26], [-0.22, 0.6, -0.05, 0.24], [0.05, 0.84, 0, 0.23]]) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(cr * s, 1), cm); m.position.set(cx * s, cy * s, cz * s); m.scale.y = 0.92; m.rotation.y = Math.random() * 6.28; g.add(m);
    }
    g.rotation.y = Math.random() * 6.28; outlineGroup.add(g); contactShadow(s * 1.25).position.set(x, 0.004, z); return g;
  };

  const bladeMat = toon(0xB6C9A8); bladeMat.side = THREE.DoubleSide;
  const tuftGeo = () => {
    const pos: number[] = []; const n = 4;
    for (let b = 0; b < n; b++) {
      const a = (b / n) * 6.283 + Math.random() * 0.5; const px = Math.cos(a + 1.57), pz = Math.sin(a + 1.57), w = 0.016, h = 0.13 + Math.random() * 0.08;
      pos.push(-px * w, 0, -pz * w, px * w, 0, pz * w, Math.cos(a) * 0.04, h, Math.sin(a) * 0.04);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.computeVertexNormals(); return g;
  };
  const tuftGeos = [tuftGeo(), tuftGeo(), tuftGeo(), tuftGeo(), tuftGeo()];
  const grassAt = (x: number, z: number, s: number) => {
    const m = new THREE.Mesh(tuftGeos[(Math.random() * tuftGeos.length) | 0], bladeMat);
    m.position.set(x, 0, z); m.scale.setScalar(s); m.rotation.y = Math.random() * 6.28; outlineGroup.add(m);
    swayers.push({ pivot: m, amp: 0.05 + Math.random() * 0.05, speed: 0.8 + Math.random() * 0.7, phase: Math.random() * 6.28 });
  };

  // ── placement ────────────────────────────────────────────
  const rocks: [number, number, number, number][] = [[-2.7, -1.1, 0.30, ROCK], [2.9, -0.8, 0.24, ROCK2], [2.4, 2.2, 0.20, ROCK],
    [-2.5, 2.2, 0.24, ROCK2], [3.6, 0.7, 0.16, ROCK], [-3.7, 0.3, 0.18, ROCK2], [0.9, -3.0, 0.17, ROCK],
    [-1.0, 3.4, 0.13, ROCK2], [3.9, -1.8, 0.15, ROCK], [-3.3, -2.0, 0.16, ROCK2], [2.4, -2.7, 0.12, ROCK],
    [-2.0, -2.9, 0.13, ROCK], [4.5, 1.7, 0.14, ROCK2], [-4.5, 1.5, 0.15, ROCK], [4.7, -0.6, 0.13, ROCK2]];
  for (const [x, z, r, c] of rocks) if (clearOfNodes(x, z, 0.7)) rock(x, z, r, c);
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * 6.283, rr = 2.4 + Math.random() * 4.6; const x = Math.cos(a) * rr, z = Math.sin(a) * rr * 0.9;
    if (clearOfNodes(x, z, 0.7)) rock(x, z, 0.06 + Math.random() * 0.05, i % 2 ? ROCK : ROCK2);
  }
  plant(-3.1, 1.4, 0.5, LEAF); plant(3.2, -1.5, 0.44, LEAF2); plant(-1.9, 3.1, 0.36, LEAF);
  plant(1.9, 3.1, 0.34, LEAF2); plant(-3.9, -0.7, 0.4, LEAF2); plant(3.0, 2.6, 0.3, LEAF);

  const grove = (cx: number, cz: number, n: number, sBase: number) => {
    for (let i = 0; i < n; i++) { const a = Math.random() * 6.283, rr = Math.random() * 1.4; tree(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr * 0.8, sBase * (0.78 + Math.random() * 0.5)); }
  };
  grove(-4.8, -3.7, 4, 1.05); grove(4.9, -3.1, 3, 1.1); grove(0.4, -5.8, 3, 0.95);

  for (let i = 0; i < 160; i++) {
    const a = Math.random() * 6.283, rr = 2.1 + Math.random() * 4.5; const x = Math.cos(a) * rr, z = Math.sin(a) * rr * 0.92;
    if (Math.hypot(x, z) < 2.05 || !clearOfNodes(x, z, 0.7)) continue; grassAt(x, z, 0.85 + Math.random() * 0.85);
  }
  for (let i = 0; i < 48; i++) { const a = Math.random() * 6.283, rr = 6.0 + Math.random() * 3.5; grassAt(Math.cos(a) * rr, Math.sin(a) * rr * 0.9, 1.6 + Math.random() * 1.2); }

  // soft outlined cloud puffs
  const cloud = (x: number, y: number, z: number, s: number) => {
    const g = new THREE.Group(); g.position.set(x, y, z); const cm = toon(0xFBF7F1);
    for (const [bx, by, br] of [[0, 0, 1], [0.72, 0.06, 0.7], [-0.72, 0.04, 0.66], [0.32, 0.32, 0.52], [-0.36, 0.28, 0.48]]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(br * s, 10, 8), cm); m.position.set(bx * s, by * s, 0); m.scale.y = 0.66; g.add(m);
    }
    outlineGroup.add(g); return g;
  };
  cloud(-2.9, 2.6, -5.0, 0.65); cloud(3.1, 3.1, -5.8, 0.85); cloud(0.3, 3.4, -6.8, 0.7); cloud(-4.8, 2.9, -6.2, 0.72);

  // ── post-process: normal+depth Sobel edge-detection ──────
  const dpr = renderer.getDrawingBufferSize(new THREE.Vector2());
  const normalRT = new THREE.WebGLRenderTarget(dpr.x, dpr.y);
  normalRT.depthTexture = new THREE.DepthTexture(dpr.x, dpr.y);
  normalRT.depthTexture.format = THREE.DepthFormat; normalRT.depthTexture.type = THREE.UnsignedShortType;
  const colorRT = new THREE.WebGLRenderTarget(dpr.x, dpr.y);
  const normalMat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide, fog: false });

  const grainTex = (() => {
    const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
    const x = cv.getContext('2d')!; const img = x.createImageData(s, s);
    for (let i = 0; i < s * s; i++) { const v = 200 + Math.random() * 55; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    x.putImageData(img, 0, 0); const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  })();

  const composite = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: colorRT.texture }, uNormal: { value: normalRT.texture }, uDepth: { value: normalRT.depthTexture },
      uTexel: { value: new THREE.Vector2(1 / dpr.x, 1 / dpr.y) },
      uNear: { value: camera.near }, uFar: { value: camera.far },
      uTime: { value: 0 }, uInk: { value: new THREE.Color(INK) }, uEdge: { value: 1.0 },
      uGrain: { value: grainTex }, uRes: { value: new THREE.Vector2(dpr.x, dpr.y) },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
    fragmentShader: `
      #include <packing>
      varying vec2 vUv;
      uniform sampler2D uColor, uNormal, uDepth, uGrain;
      uniform vec2 uTexel, uRes; uniform float uNear, uFar, uTime, uEdge; uniform vec3 uInk;
      float linDepth(vec2 uv){ float f=texture2D(uDepth,uv).x;
        float vz=perspectiveDepthToViewZ(f,uNear,uFar); return viewZToOrthographicDepth(vz,uNear,uFar); }
      float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
      void main(){
        vec2 e=uTexel*1.3; vec3 col=texture2D(uColor,vUv).rgb;
        vec3 nC=texture2D(uNormal,vUv).rgb;
        vec3 nL=texture2D(uNormal,vUv-vec2(e.x,0.)).rgb, nR=texture2D(uNormal,vUv+vec2(e.x,0.)).rgb;
        vec3 nU=texture2D(uNormal,vUv+vec2(0.,e.y)).rgb, nD=texture2D(uNormal,vUv-vec2(0.,e.y)).rgb;
        float ne=length(nC-nL)+length(nC-nR)+length(nC-nU)+length(nC-nD);
        float dC=linDepth(vUv);
        float de=abs(dC-linDepth(vUv-vec2(e.x,0.)))+abs(dC-linDepth(vUv+vec2(e.x,0.)))
                +abs(dC-linDepth(vUv+vec2(0.,e.y)))+abs(dC-linDepth(vUv-vec2(0.,e.y)));
        float edge=max( smoothstep(0.055,0.20,ne), smoothstep(0.015,0.08,de) ) * uEdge;
        vec2 guv = vUv * uRes / 256.0;
        float paper = texture2D(uGrain, guv).r;
        float hg = hash(vUv*uRes*0.5 + uTime);
        float grain = mix(paper, hg, 0.35);
        float lum = dot(col, vec3(0.299,0.587,0.114));
        float tooth = mix(0.05, 0.22, smoothstep(0.45,1.0,lum));
        col *= 1.0 - tooth*(1.0 - grain);
        float vig=smoothstep(1.4,0.35,length(vUv-0.5)); col=mix(col*0.985,col,vig);
        gl_FragColor=vec4(mix(col,uInk,clamp(edge,0.,1.)),1.0);
      }`,
  });
  const quadScene = new THREE.Scene();
  quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), composite));
  const quadCam = new THREE.Camera();

  // ── state ────────────────────────────────────────────────
  const S: RenderState = { present: true, moving: false, breathing: true, bpm: 15, motion: 0, baseScale: 1, phase: 0 };

  // ── 3D-anchored labels ───────────────────────────────────
  const _v = new THREE.Vector3();
  const place = (el: HTMLElement, world: THREE.Vector3, dy = 0) => {
    _v.copy(world); _v.y += dy; _v.project(camera);
    const x = (_v.x * 0.5 + 0.5) * window.innerWidth, y = (-_v.y * 0.5 + 0.5) * window.innerHeight;
    el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px)`; el.style.opacity = (_v.z < 1) ? '1' : '0';
  };
  const updateLabels = () => {
    place(labels.tx, P_TX, 0.34); place(labels.rx2, P_RX2, 0.34); place(labels.rx3, P_RX3, 0.34);
    const show = S.baseScale > 0.15 && S.present; labels.presence.style.opacity = show ? '1' : '0';
    if (show) { labels.presence.innerHTML = '<span class="dot"></span>PRESENCE'; place(labels.presence, new THREE.Vector3(0, GEM_Y, 0), 0.55); }
  };

  // ── resize ───────────────────────────────────────────────
  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    const d = renderer.getDrawingBufferSize(new THREE.Vector2());
    normalRT.setSize(d.x, d.y); colorRT.setSize(d.x, d.y);
    composite.uniforms.uTexel.value.set(1 / d.x, 1 / d.y); composite.uniforms.uRes.value.set(d.x, d.y);
  };
  window.addEventListener('resize', onResize);

  // ── frame loop ───────────────────────────────────────────
  const clock = new THREE.Clock(); let t = 0; let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05); t += dt;

    if (S.present && !S.moving && S.breathing) S.phase += dt * (S.bpm / 60) * Math.PI * 2;
    const breathScale = (S.present && !S.moving && S.breathing) ? (1 + 0.05 * Math.sin(S.phase)) : 1;

    links.forEach(L => updateLink(L, t));
    const sc = Math.max(0.0001, S.baseScale * breathScale);
    gem.scale.set(0.9 * sc, GEM_TALL * sc, 0.9 * sc);
    gem.position.y = GEM_Y + Math.sin(t * 0.7) * 0.03;
    gem.rotation.y += dt * (0.22 + 0.7 * S.motion);
    gem.visible = S.baseScale > 0.002;
    const ap = 0.55 + 0.45 * Math.sin(S.phase);
    aura.visible = S.baseScale > 0.01;
    aura.scale.setScalar((0.85 + 0.22 * ap) * (0.55 + 0.45 * S.baseScale));
    (stoneShadow.material as THREE.MeshBasicMaterial).opacity = 0.85 * Math.min(1, S.baseScale);
    stoneShadow.scale.setScalar(0.7 + 0.4 * S.baseScale);
    for (const nd of nodeObjs) nd.mesh.position.y = nd.baseY + Math.sin(t * 0.9 + nd.phase) * 0.035;

    for (const s of swayers) s.pivot.rotation.z = Math.sin(t * s.speed + s.phase) * s.amp;
    controls.update();
    composite.uniforms.uTime.value = t;

    // pass 1 — view-space normals + depth (outlined objects only)
    scene.background = null; decoGroup.visible = false; scene.overrideMaterial = normalMat;
    renderer.setClearColor(0x000000, 1); renderer.setRenderTarget(normalRT); renderer.render(scene, camera);
    scene.overrideMaterial = null; decoGroup.visible = true;
    // pass 2 — toon colour over the gradient sky
    scene.background = skyTex; renderer.setRenderTarget(colorRT); renderer.render(scene, camera);
    // pass 3 — composite edges over colour
    renderer.setRenderTarget(null); renderer.render(quadScene, quadCam);
    updateLabels();
  };
  frame();

  // ── public handle ────────────────────────────────────────
  return {
    setState(patch: Partial<SensingState>) {
      if (patch.present !== undefined && patch.present !== S.present) {
        S.present = patch.present;
        gsap.to(S, { baseScale: S.present ? 1 : 0, duration: S.present ? 1.05 : 0.6, ease: S.present ? 'elastic.out(1,0.55)' : 'power2.in' });
      }
      if (patch.moving !== undefined && patch.moving !== S.moving) {
        S.moving = patch.moving;
        gsap.to(S, { motion: S.moving ? 1 : 0, duration: 0.85, ease: 'power2.inOut' });
      }
      if (patch.breathing !== undefined) S.breathing = patch.breathing;
      if (patch.bpm !== undefined) S.bpm = patch.bpm;
    },
    setAutoRotate(on: boolean) { controls.autoRotate = on; },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      renderer.dispose();
    },
  };
}
