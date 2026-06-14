// The onboarding cover as a draggable WebGL paper tear. The cover (aged
// parchment + Allura wordmark + emblem) is baked to a CanvasTexture and torn by
// a shader: a noise-displaced white→black edge texture cuts an organic rip
// (strictly complementary about one boundary, confined to the seam zone), the
// vertex shader peels each half in 3D with front/back shading. The renderer is
// transparent and draws only the sheet, so the torn gaps reveal the DOM wizard
// behind with no cross-fade. Adapted from app/prototypes/onboarding-tear.html.
import * as THREE from 'three';
import gsap from 'gsap';

export interface TearHandle {
  begin(): void;     // trigger the tear (click fallback)
  dispose(): void;
}

interface TearOpts {
  onFirstInteract?: () => void;
  onComplete?: () => void;
}

const ripVertexShader = `
  uniform float uTearAmount, uTearWidth, uTearXAngle, uTearYAngle, uTearZAngle, uTearXOffset, uXDirection;
  varying vec2 vUv; varying float vAmount;
  mat4 rotX(float a){ return mat4(1.,0.,0.,0., 0.,cos(a),-sin(a),0., 0.,sin(a),cos(a),0., 0.,0.,0.,1.); }
  mat4 rotY(float a){ return mat4(cos(a),0.,sin(a),0., 0.,1.,0.,0., -sin(a),0.,cos(a),0., 0.,0.,0.,1.); }
  mat4 rotZ(float a){ return mat4(cos(a),-sin(a),0.,0., sin(a),cos(a),0.,0., 0.,0.,1.,0., 0.,0.,0.,1.); }
  void main(){
    float yAmount = max(0.0, (uTearAmount - (1.0 - uv.y)));
    vec3 rot = vec3(uTearXAngle*yAmount, uTearYAngle*yAmount, uTearZAngle*yAmount) * yAmount;
    float halfHeight = float(HEIGHT) * 0.5;
    float halfWidth = (float(WIDTH) - uTearWidth * 0.5) * 0.5;
    vec4 v = vec4(position.x + (halfWidth*uXDirection) - halfWidth, position.y + halfHeight, position.z, 1.0);
    v = v * rotY(rot.y) * rotX(rot.x) * rotZ(rot.z);
    v.x += uTearXOffset*yAmount + halfWidth; v.y -= halfHeight;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * v;
    vUv = uv; vAmount = yAmount;
  }`;

const ripFragmentShader = `
  uniform sampler2D uMap, uRip; uniform vec3 uShadeColor;
  uniform float uUvOffset, uRipSide, uShadeAmount, uTearWidth, uWhiteThreshold, uTearOffset;
  varying vec2 vUv; varying float vAmount;
  void main(){
    bool rightSide = uRipSide == 1.0;
    float width = float(WIDTH); float widthOverlap = (uTearWidth*0.5) + width;
    float xScale = widthOverlap / float(FULL_WIDTH);
    vec4 col = texture2D(uMap, vec2(vUv.x*xScale + uUvOffset, vUv.y));
    float ripRange = uTearWidth / widthOverlap;
    float ripStart = rightSide ? 0.0 : 1.0 - ripRange;
    float alpha = 1.0;
    float ripX = (vUv.x - ripStart)/ripRange;
    if(ripX >= 0.0 && ripX <= 1.0){
      float ripY = vUv.y*0.5 + 0.5*uTearOffset;
      float w = dot(vec4(1.0), texture2D(uRip, vec2(ripX, ripY)))/4.0;
      if(!rightSide && w < uWhiteThreshold) alpha = 0.0;     // strictly complementary: no gap, no overlap
      if(rightSide && w >= uWhiteThreshold) alpha = 0.0;
    }
    gl_FragColor = mix(vec4(col.rgb, alpha), vec4(uShadeColor, alpha), vAmount*uShadeAmount);
  }`;

export async function createTear(canvas: HTMLCanvasElement, opts: TearOpts = {}): Promise<TearHandle> {
  await document.fonts.ready;
  await Promise.all([document.fonts.load('400 120px "Allura"'), document.fonts.load('400 14px "Space Mono"')]).catch(() => {});

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.z = 6; scene.add(camera);

  // ── bake the cover (parchment + Allura wordmark + emblem) ──
  const drawSpaced = (x: CanvasRenderingContext2D, text: string, cx: number, cy: number, ls: number) => {
    const ws = text.split('').map((c) => x.measureText(c).width + ls);
    const tot = ws.reduce((a, b) => a + b, 0) - ls; let px = cx - tot / 2;
    for (let i = 0; i < text.length; i++) { x.fillText(text[i], px + (ws[i] - ls) / 2, cy); px += ws[i]; }
  };
  const emblem = (x: CanvasRenderingContext2D, cx: number, cy: number, r: number) => {
    x.strokeStyle = '#2B2A26'; x.lineWidth = r * 0.045;
    x.beginPath(); x.moveTo(cx, cy - r); x.lineTo(cx - r, cy + r * 0.62); x.lineTo(cx + r, cy + r * 0.62); x.closePath(); x.stroke();
    const dot = (dx: number, dy: number, fill: string) => { x.beginPath(); x.arc(cx + dx, cy + dy, r * 0.13, 0, 6.283); x.fillStyle = fill; x.fill(); x.lineWidth = r * 0.05; x.strokeStyle = '#2B2A26'; x.stroke(); };
    dot(0, -r, '#D8C09A'); dot(-r, r * 0.62, '#93A7BE'); dot(r, r * 0.62, '#93A7BE');
    x.save(); x.translate(cx, cy + r * 0.04); x.rotate(Math.PI / 4); x.fillStyle = '#D89A85'; x.lineWidth = r * 0.05; x.strokeStyle = '#2B2A26';
    x.fillRect(-r * 0.13, -r * 0.13, r * 0.26, r * 0.26); x.strokeRect(-r * 0.13, -r * 0.13, r * 0.26, r * 0.26); x.restore();
  };
  let coverTex: THREE.CanvasTexture | undefined;
  const bakeCover = () => {
    const W = Math.round(window.innerWidth), H = Math.round(window.innerHeight);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = cv.getContext('2d')!;
    x.fillStyle = '#E7DDC9'; x.fillRect(0, 0, W, H);
    let g = x.createRadialGradient(W / 2, H * 0.30, 0, W / 2, H * 0.30, H * 0.95); g.addColorStop(0, 'rgba(255,252,244,0.6)'); g.addColorStop(0.55, 'rgba(255,252,244,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    g = x.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.85); g.addColorStop(0, 'rgba(66,50,28,0)'); g.addColorStop(1, 'rgba(66,50,28,0.30)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < W * H / 700; i++) { x.fillStyle = 'rgba(43,42,38,' + (Math.random() * 0.05) + ')'; x.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    emblem(x, W / 2, H * 0.345, H * 0.066);
    x.fillStyle = '#2B2A26'; x.font = `400 ${Math.round(H * 0.17)}px "Allura"`; x.fillText('Throughnet', W / 2, H * 0.49);
    x.fillStyle = '#2B2A26'; x.fillRect(W / 2 - 27, Math.round(H * 0.60), 54, 2);
    x.fillStyle = '#56524A'; x.font = `400 ${Math.round(H * 0.0165)}px "Space Mono"`;
    drawSpaced(x, 'CAMERA-FREE PRESENCE · MOTION · BREATHING', W / 2, H * 0.645, H * 0.0125);
    if (coverTex) coverTex.dispose();
    coverTex = new THREE.CanvasTexture(cv); coverTex.colorSpace = THREE.SRGBColorSpace; coverTex.needsUpdate = true;
  };

  // ── rip edge: white→black with a turbulence-displaced jagged boundary ──
  const ripTex = new THREE.Texture();
  await new Promise<void>((res, rej) => {
    const img = new Image();
    img.onload = () => { ripTex.image = img; ripTex.needsUpdate = true; res(); };
    img.onerror = () => rej(new Error('rip texture failed'));
    img.src = 'data:image/svg+xml,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='0'><stop offset='0.30' stop-color='white'/><stop offset='0.46' stop-color='white'/><stop offset='0.54' stop-color='black'/><stop offset='0.70' stop-color='black'/></linearGradient><filter id='d' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='0.007 0.03' numOctaves='2' seed='7' result='n'/><feDisplacementMap in='SourceGraphic' in2='n' scale='150' xChannelSelector='R' yChannelSelector='G'/></filter></defs><rect width='512' height='512' fill='url(#g)' filter='url(#d)'/></svg>");
  });

  // ── the sheet (two interlocking halves) ──
  const group = new THREE.Group(); scene.add(group);
  const S = {
    width: 3, height: 2, tearWidth: 0.4, tearAmount: 0, tearOffset: Math.random(), whiteThreshold: 0.62,
    left: { uvOffset: 0, ripSide: 0, xAngle: -0.01, yAngle: -0.1, zAngle: 0.05, xOffset: 0, dir: -1, shade: new THREE.Color('white'), shadeAmt: 0.18 },
    right: { uvOffset: 0, ripSide: 1, xAngle: 0.2, yAngle: 0.1, zAngle: -0.1, xOffset: 0, dir: 1, shade: new THREE.Color('black'), shadeAmt: 0.4 },
  };
  type Side = { id: 'left' | 'right'; mesh: THREE.Mesh };
  let sides: Side[] = [];
  const buildSheet = () => {
    const fH = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    S.height = fH * 1.06; S.width = fH * camera.aspect * 1.06; S.tearWidth = S.width * 0.12;
    S.right.uvOffset = ((S.width - S.tearWidth) / S.width) * 0.5;
    sides.forEach((s) => { s.mesh.geometry.dispose(); (s.mesh.material as THREE.Material).dispose(); group.remove(s.mesh); }); sides = [];
    const geo = new THREE.PlaneGeometry(S.width / 2 + S.tearWidth / 2, S.height, 30, 50);
    (['left', 'right'] as const).forEach((id) => {
      const p = S[id];
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        defines: { HEIGHT: S.height.toFixed(4), WIDTH: (S.width / 2).toFixed(4), FULL_WIDTH: S.width.toFixed(4) },
        uniforms: {
          uMap: { value: coverTex }, uRip: { value: ripTex }, uRipSide: { value: p.ripSide },
          uTearWidth: { value: S.tearWidth }, uWhiteThreshold: { value: S.whiteThreshold },
          uTearAmount: { value: S.tearAmount }, uTearOffset: { value: S.tearOffset }, uUvOffset: { value: p.uvOffset },
          uTearXAngle: { value: p.xAngle }, uTearYAngle: { value: p.yAngle }, uTearZAngle: { value: p.zAngle },
          uTearXOffset: { value: p.xOffset }, uXDirection: { value: p.dir }, uShadeColor: { value: p.shade }, uShadeAmount: { value: p.shadeAmt },
        },
        vertexShader: ripVertexShader, fragmentShader: ripFragmentShader,
      });
      const mesh = new THREE.Mesh(geo, mat); if (p.xAngle > 0) mesh.position.z += 0.0001; group.add(mesh);
      sides.push({ id, mesh });
    });
  };
  const syncUniforms = () => sides.forEach((s) => {
    const u = (s.mesh.material as THREE.ShaderMaterial).uniforms;
    u.uTearAmount.value = S.tearAmount; u.uTearOffset.value = S.tearOffset;
  });

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    bakeCover(); sides.forEach((s) => ((s.mesh.material as THREE.ShaderMaterial).uniforms.uMap.value = coverTex)); buildSheet();
  };
  bakeCover(); resize();
  window.addEventListener('resize', resize);

  // ── interaction: drag to tear ──
  let removed = false, interacted = false, down = false, startY = 0;
  const py = (y: number) => -(y / window.innerHeight) * 2 + 1;
  const firstInteract = () => { if (!interacted) { interacted = true; opts.onFirstInteract?.(); } };
  const onDown = (y: number) => { if (removed) return; firstInteract(); down = true; startY = py(y); };
  const onMove = (y: number) => { if (!down || removed) return; S.tearAmount = Math.min(Math.max(2 * (startY - py(y)), 0), 1.15); syncUniforms(); };
  const onUp = () => { if (!down || removed) return; down = false; if (S.tearAmount >= 0.55) complete(); else gsap.to(S, { tearAmount: 0, duration: 0.5, ease: 'power3.out', onUpdate: syncUniforms }); };
  const md = (e: MouseEvent) => onDown(e.clientY), mm = (e: MouseEvent) => onMove(e.clientY);
  const ts = (e: TouchEvent) => onDown(e.touches[0].clientY), tm = (e: TouchEvent) => onMove(e.touches[0].clientY);
  window.addEventListener('mousedown', md); window.addEventListener('mousemove', mm); window.addEventListener('mouseup', onUp);
  window.addEventListener('touchstart', ts, { passive: true }); window.addEventListener('touchmove', tm, { passive: true }); window.addEventListener('touchend', onUp);

  function complete() {
    if (removed) return; removed = true;
    const tl = gsap.timeline({ defaults: { duration: 1.0, ease: 'power2.in' }, onComplete: () => opts.onComplete?.() });
    tl.to(S, { tearAmount: 1.15, ease: 'power2.out', onUpdate: syncUniforms }, 0);
    tl.to(group.position, { z: 1 }, 0);
    sides.forEach((s) => {
      const sign = (S[s.id].ripSide - 0.5);
      tl.to(s.mesh.position, { y: -3 - Math.random() * 3, x: (2 + Math.random() * 3) * sign }, 0);
      tl.to(s.mesh.rotation, { z: (-2 - Math.random() * 3) * sign }, 0);
    });
    tl.to(canvas, { opacity: 0, duration: 0.4, ease: 'power2.in' }, 0.7);
  }

  let raf = 0;
  const tick = () => { raf = requestAnimationFrame(tick); renderer.render(scene, camera); };
  tick();

  return {
    begin() { firstInteract(); complete(); },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousedown', md); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchstart', ts); window.removeEventListener('touchmove', tm); window.removeEventListener('touchend', onUp);
      renderer.dispose();
    },
  };
}
