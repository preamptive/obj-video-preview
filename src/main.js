import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

// ---------- DOM refs ----------
const canvas = document.getElementById('scene-canvas');
const emptyState = document.getElementById('empty-state');
const emptyHint = document.getElementById('empty-hint');
const statusChip = document.getElementById('status-chip');
const statusText = document.getElementById('status-text');
const statusClear = document.getElementById('status-clear');
const toolbar = document.getElementById('toolbar');
const toast = document.getElementById('toast');

const dropObj = document.getElementById('drop-obj');
const dropMp4 = document.getElementById('drop-mp4');
const nameObjEl = document.getElementById('name-obj');
const nameMp4El = document.getElementById('name-mp4');
const fileObjInput = document.getElementById('file-obj');
const fileMp4Input = document.getElementById('file-mp4');

const ndiToggleBtn = document.getElementById('ndi-toggle');
const ndiPanel = document.getElementById('ndi-panel');
const ndiSelect = document.getElementById('ndi-select');
const ndiRefreshBtn = document.getElementById('ndi-refresh');
const ndiConnectBtn = document.getElementById('ndi-connect');

let toastTimer = null;
function showToast(message, duration = 4200) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ---------- Renderer / Scene / Camera ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a0c);
const FOG_NEAR_DEFAULT = 26;
const FOG_FAR_DEFAULT = 110;
scene.fog = new THREE.Fog(0x0a0a0c, FOG_NEAR_DEFAULT, FOG_FAR_DEFAULT);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(4, 3, 6);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
if ('outputColorSpace' in renderer) renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.5, 0);
controls.minDistance = 1;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.96; // allow low-angle views, short of flipping past the pole
controls.update();

// ---------- Lighting ----------
const hemi = new THREE.HemisphereLight(0x8fb8ff, 0x1a1a1a, 0.65);
scene.add(hemi);

// The key light rides along with the camera (updated in the render loop) rather than
// sitting at a fixed world position. A world-fixed light looks great by luck on some
// models and lights the wrong side on others, since the "front" of a loaded model can
// face any direction — a camera-relative light guarantees whatever's on screen is lit.
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.target = new THREE.Object3D();
scene.add(key);
scene.add(key.target);

const fill = new THREE.AmbientLight(0xffffff, 0.25);
scene.add(fill);

const keyLocalOffset = new THREE.Vector3(0.5, 0.85, 0.35).normalize();
function updateKeyLight() {
  const dist = Math.max(camera.position.distanceTo(controls.target), 1);
  const worldOffset = keyLocalOffset.clone().applyQuaternion(camera.quaternion).multiplyScalar(dist * 0.6);
  key.position.copy(camera.position).add(worldOffset);
  key.target.position.copy(controls.target);
}

// ---------- Grid floor ----------
function buildGrid() {
  const group = new THREE.Group();

  const minor = new THREE.GridHelper(200, 200, 0x3c4147, 0x2a2e33);
  minor.material.transparent = true;
  minor.material.opacity = 0.16;
  minor.material.depthWrite = false;
  group.add(minor);

  const major = new THREE.GridHelper(200, 40, 0x626b73, 0x626b73);
  major.material.transparent = true;
  major.material.opacity = 0.32;
  major.material.depthWrite = false;
  major.position.y = 0.001;
  group.add(major);

  return group;
}
const gridGroup = buildGrid();
scene.add(gridGroup);

// ---------- Fake contact shadow ----------
function createShadowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
const shadowTexture = createShadowTexture();
const shadowMat = new THREE.MeshBasicMaterial({
  map: shadowTexture,
  transparent: true,
  depthWrite: false,
  toneMapped: false,
});
const shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
shadowMesh.rotation.x = -Math.PI / 2;
shadowMesh.position.y = 0.002;
shadowMesh.visible = false;
scene.add(shadowMesh);

// ---------- State ----------
let currentObject = null;
let objFile = null;
let mediaFile = null;
let mediaLabel = null; // display name for the status chip, across all media kinds
let objURL = null;
let mediaURL = null;
let mediaTexture = null;
let mediaKind = null; // 'video' | 'image' | 'ndi' | null
let objLoaded = false;
let mediaReady = false;
let initialCameraPos = new THREE.Vector3();
let initialTarget = new THREE.Vector3();

let ndiSocket = null;
let ndiPollTimer = null;
const ndiCanvas = document.createElement('canvas');
const ndiCtx = ndiCanvas.getContext('2d');

const video = document.createElement('video');
video.loop = true;
video.muted = true;
video.playsInline = true;
video.crossOrigin = 'anonymous';

function disposeMediaTexture() {
  if (mediaTexture) {
    mediaTexture.dispose();
    mediaTexture = null;
  }
}

video.addEventListener('error', () => {
  if (mediaKind === 'video') showToast('Unsupported video format or codec — try an H.264 encoded .mp4');
});

video.addEventListener('loadeddata', () => {
  if (mediaKind !== 'video') return;
  mediaReady = true;
  updatePlayIcon();
  updateMuteIcon();
  disposeMediaTexture();
  mediaTexture = new THREE.VideoTexture(video);
  if ('colorSpace' in mediaTexture) mediaTexture.colorSpace = THREE.SRGBColorSpace;
  mediaTexture.minFilter = THREE.LinearFilter;
  mediaTexture.magFilter = THREE.LinearFilter;
  tryApplyTexture();
  video.play().catch(() => {
    /* autoplay may be blocked until user interacts; play button still works */
  });
});

// ---------- Loading OBJ ----------
function disposeObject(obj) {
  obj.traverse((child) => {
    if (child.isMesh) {
      child.geometry?.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => m && m.dispose && m.dispose());
    }
  });
}

function loadObjFile(file) {
  if (!file) return;
  if (!/\.obj$/i.test(file.name)) {
    showToast('Please choose a .obj file');
    return;
  }
  objFile = file;
  if (objURL) URL.revokeObjectURL(objURL);
  objURL = URL.createObjectURL(file);

  const loader = new OBJLoader();
  loader.load(
    objURL,
    (obj) => {
      if (currentObject) {
        scene.remove(currentObject);
        disposeObject(currentObject);
      }

      // Give any material-less meshes a sane default before the texture is applied.
      let hasUV = false;
      const meshes = [];
      obj.traverse((child) => {
        if (child.isMesh) {
          meshes.push(child);
          if (child.geometry?.attributes?.uv) hasUV = true;
        }
      });

      if (meshes.length === 0) {
        showToast('No mesh geometry found in this .obj file');
        return;
      }
      if (!hasUV) {
        showToast('This model has no UV coordinates — the texture may not map correctly');
      }

      // Front faces get the real material (grey fallback, later the video texture).
      // Back faces (interior surfaces, or a model with inverted winding) get a plain
      // grey plate instead, sharing the same geometry, rather than showing the texture
      // mirrored/inside-out or being invisible entirely.
      meshes.forEach((mesh) => {
        if (!mesh.material || (Array.isArray(mesh.material) && mesh.material.length === 0)) {
          mesh.material = new THREE.MeshStandardMaterial({ color: 0x888888 });
        }
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          m.side = THREE.FrontSide;
        });

        const backPlate = new THREE.Mesh(
          mesh.geometry,
          new THREE.MeshStandardMaterial({ color: 0x4a4d52, side: THREE.BackSide, roughness: 1 })
        );
        backPlate.userData.isBackfacePlate = true;
        mesh.add(backPlate);
      });

      currentObject = obj;
      scene.add(obj);
      objLoaded = true;
      nameObjEl.textContent = file.name;
      dropObj.classList.add('loaded');

      frameObject();
      tryApplyTexture();
      updateUIState();
    },
    undefined,
    () => {
      showToast('Failed to load .obj model — the file may be malformed');
    }
  );
}

const VIDEO_EXT_RE = /\.mp4$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png)$/i;

function isVideoFile(file) {
  return VIDEO_EXT_RE.test(file.name) || file.type === 'video/mp4';
}

function isImageFile(file) {
  return IMAGE_EXT_RE.test(file.name) || /^image\/(jpeg|png)$/.test(file.type);
}

function loadMediaFile(file) {
  if (!file) return;
  if (isVideoFile(file)) {
    loadVideoFile(file);
  } else if (isImageFile(file)) {
    loadImageFile(file);
  } else {
    showToast('Please choose an .mp4, .jpg, or .png file');
  }
}

function loadVideoFile(file) {
  closeNdiSocket();
  mediaFile = file;
  mediaLabel = file.name;
  mediaKind = 'video';
  mediaReady = false;
  if (mediaURL) URL.revokeObjectURL(mediaURL);
  mediaURL = URL.createObjectURL(file);
  video.src = mediaURL;
  video.load();

  nameMp4El.textContent = mediaLabel;
  dropMp4.classList.add('loaded');
  updateMediaControlsVisibility();
  updateUIState();
}

function loadImageFile(file) {
  closeNdiSocket();
  mediaFile = file;
  mediaLabel = file.name;
  mediaKind = 'image';
  mediaReady = false;
  video.pause();
  if (mediaURL) URL.revokeObjectURL(mediaURL);
  mediaURL = URL.createObjectURL(file);

  new THREE.TextureLoader().load(
    mediaURL,
    (texture) => {
      if (mediaKind !== 'image') return; // superseded by a newer load
      disposeMediaTexture();
      if ('colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;
      mediaTexture = texture;
      mediaReady = true;
      tryApplyTexture();
    },
    undefined,
    () => showToast('Unable to load image — unsupported format or corrupted file')
  );

  nameMp4El.textContent = mediaLabel;
  dropMp4.classList.add('loaded');
  updateMediaControlsVisibility();
  updateUIState();
}

// ---------- NDI ----------
function closeNdiSocket() {
  if (ndiSocket) {
    ndiSocket.onmessage = null;
    ndiSocket.onerror = null;
    ndiSocket.onclose = null;
    ndiSocket.close();
    ndiSocket = null;
  }
}

async function fetchNdiSources() {
  try {
    const res = await fetch('/api/ndi/sources');
    const body = await res.json();
    if (!res.ok || !Array.isArray(body)) {
      throw new Error(body?.error || 'NDI server unavailable');
    }
    const sources = body;
    const previousValue = ndiSelect.value;
    ndiSelect.innerHTML = '';
    if (sources.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No sources found';
      ndiSelect.appendChild(opt);
    } else {
      sources.forEach((s) => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.name;
        ndiSelect.appendChild(opt);
      });
      if (sources.some((s) => s.name === previousValue)) ndiSelect.value = previousValue;
    }
  } catch (err) {
    showToast(err.message || 'Unable to reach the NDI server');
  }
}

function handleNdiFrame(buffer) {
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const stride = view.getUint32(8, true);

  if (ndiCanvas.width !== width || ndiCanvas.height !== height) {
    ndiCanvas.width = width;
    ndiCanvas.height = height;
  }

  let pixels;
  if (stride === width * 4) {
    pixels = new Uint8ClampedArray(buffer, 12, width * height * 4);
  } else {
    // Some senders pad each row to a wider stride than the visible width; crop it out.
    const src = new Uint8Array(buffer, 12);
    pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      pixels.set(src.subarray(y * stride, y * stride + width * 4), y * width * 4);
    }
  }

  ndiCtx.putImageData(new ImageData(pixels, width, height), 0, 0);

  if (!mediaReady) {
    disposeMediaTexture();
    mediaTexture = new THREE.CanvasTexture(ndiCanvas);
    if ('colorSpace' in mediaTexture) mediaTexture.colorSpace = THREE.SRGBColorSpace;
    mediaReady = true;
    tryApplyTexture();
  } else {
    mediaTexture.needsUpdate = true;
  }
}

function connectNdi(sourceName) {
  closeNdiSocket();
  video.pause();
  mediaKind = 'ndi';
  mediaReady = false;
  mediaFile = null;
  mediaLabel = `NDI: ${sourceName}`;
  if (mediaURL) {
    URL.revokeObjectURL(mediaURL);
    mediaURL = null;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ndiSocket = new WebSocket(`${proto}://${location.host}/ws/ndi`);
  ndiSocket.binaryType = 'arraybuffer';

  ndiSocket.addEventListener('open', () => {
    ndiSocket.send(JSON.stringify({ type: 'subscribe', source: sourceName }));
  });
  ndiSocket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'error') showToast(`NDI: ${msg.message}`);
      } catch {
        /* ignore malformed control messages */
      }
      return;
    }
    handleNdiFrame(event.data);
  });
  ndiSocket.addEventListener('error', () => {
    showToast('NDI connection error — is the source still available?');
  });

  nameMp4El.textContent = mediaLabel;
  dropMp4.classList.add('loaded');
  updateMediaControlsVisibility();
  updateUIState();
}

function tryApplyTexture() {
  if (!objLoaded || !mediaReady || !currentObject || !mediaTexture) return;

  currentObject.traverse((child) => {
    if (child.isMesh && !child.userData.isBackfacePlate) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m) => m && m.dispose && m.dispose());
      child.material = new THREE.MeshStandardMaterial({
        map: mediaTexture,
        roughness: 0.6,
        metalness: 0.0,
        side: THREE.FrontSide,
      });
    }
  });
}

// Average the (world-space) face normals of the object to find which way it
// mostly "faces". Closed volumes (a box, a full character) cancel out to
// roughly zero — in that case there's no single front, so the caller falls
// back to a generic 3/4 view. Open/flat shapes (signage, a relief, a facade)
// have a dominant normal direction, and framing the camera toward it means
// we look at the textured front rather than an arbitrary fixed angle.
function computeAverageOutwardNormal(object) {
  const sum = new THREE.Vector3();
  const n = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let sampleCount = 0;

  object.traverse((child) => {
    if (!child.isMesh || child.userData.isBackfacePlate) return;
    const attr = child.geometry.attributes.normal;
    if (!attr) return;
    child.updateWorldMatrix(true, false);
    normalMatrix.getNormalMatrix(child.matrixWorld);
    const stride = Math.max(1, Math.floor(attr.count / 2000));
    for (let i = 0; i < attr.count; i += stride) {
      n.fromBufferAttribute(attr, i).applyMatrix3(normalMatrix).normalize();
      sum.add(n);
      sampleCount++;
    }
  });

  if (sampleCount === 0) return null;
  const strength = sum.length() / sampleCount;
  if (strength < 0.15) return null; // no dominant direction, e.g. a closed volume
  return sum.normalize();
}

// ---------- Camera framing ----------
function frameObject() {
  if (!currentObject) return;

  let box = new THREE.Box3().setFromObject(currentObject);
  // rest the object on the grid
  currentObject.position.y -= box.min.y;
  box = new THREE.Box3().setFromObject(currentObject);

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const fitDist = (maxDim / (2 * Math.tan((camera.fov * Math.PI) / 180 / 2))) * 1.7;
  const fallbackDir = new THREE.Vector3(1, 0.65, 1).normalize();
  const outward = computeAverageOutwardNormal(currentObject);
  // Face the object's dominant outward direction when it has one, blended with
  // a bit of the default 3/4 angle so the shot isn't a flat straight-on view.
  const dir = outward
    ? outward.multiplyScalar(0.82).add(fallbackDir.clone().multiplyScalar(0.3)).normalize()
    : fallbackDir;

  camera.near = Math.max(maxDim / 100, 0.01);
  camera.far = Math.max(maxDim * 20, 500);
  camera.updateProjectionMatrix();

  camera.position.copy(center).addScaledVector(dir, fitDist);
  controls.target.copy(center);
  controls.minDistance = maxDim * 0.35;
  controls.maxDistance = maxDim * 10;
  controls.update();

  initialCameraPos.copy(camera.position);
  initialTarget.copy(center);

  // Scale the grid and fog to the object's size so huge or tiny models both
  // read correctly instead of being swallowed by a fixed-distance fog falloff.
  const gridScale = Math.max(1, maxDim / 8);
  gridGroup.scale.setScalar(gridScale);
  gridGroup.position.set(center.x, 0, center.z);
  scene.fog.near = Math.max(FOG_NEAR_DEFAULT, fitDist * 0.9);
  scene.fog.far = Math.max(FOG_FAR_DEFAULT, fitDist * 3.5);

  // fit the fake contact shadow under the model
  const shadowDiameter = Math.max(size.x, size.z) * 1.6;
  shadowMesh.scale.set(shadowDiameter, shadowDiameter, 1);
  shadowMesh.position.set(center.x, 0.002, center.z);
  shadowMesh.visible = true;
}

function resetCameraView() {
  if (!currentObject) return;
  camera.position.copy(initialCameraPos);
  controls.target.copy(initialTarget);
  controls.update();
}

function dolly(factor) {
  const offset = camera.position.clone().sub(controls.target);
  const newLen = THREE.MathUtils.clamp(offset.length() * factor, controls.minDistance, controls.maxDistance);
  offset.setLength(newLen);
  camera.position.copy(controls.target).add(offset);
  controls.update();
}

// ---------- UI state ----------
function updateUIState() {
  if (objLoaded) {
    emptyHint.textContent = 'Now drop or browse for a video or image';
  }
  if (mediaLabel && !objLoaded) {
    emptyHint.textContent = 'Now drop or browse for the .obj';
  }
  if (objLoaded && mediaLabel) {
    emptyState.classList.add('faded');
    statusChip.classList.remove('hidden');
    toolbar.classList.remove('hidden');
    statusText.textContent = `${objFile.name} · ${mediaLabel}`;
  }
}

function updateMediaControlsVisibility() {
  const isVideo = mediaKind === 'video';
  document.getElementById('btn-play').classList.toggle('hidden', !isVideo);
  document.getElementById('btn-mute').classList.toggle('hidden', !isVideo);
}

function clearAll() {
  if (currentObject) {
    scene.remove(currentObject);
    disposeObject(currentObject);
    currentObject = null;
  }
  shadowMesh.visible = false;

  video.pause();
  video.removeAttribute('src');
  video.load();
  closeNdiSocket();
  clearInterval(ndiPollTimer);
  ndiPollTimer = null;
  ndiPanel.classList.add('hidden');

  if (objURL) URL.revokeObjectURL(objURL);
  if (mediaURL) URL.revokeObjectURL(mediaURL);
  objURL = null;
  mediaURL = null;
  objFile = null;
  mediaFile = null;
  mediaLabel = null;
  mediaKind = null;
  objLoaded = false;
  mediaReady = false;

  disposeMediaTexture();

  nameObjEl.textContent = '';
  nameMp4El.textContent = '';
  dropObj.classList.remove('loaded');
  dropMp4.classList.remove('loaded');
  emptyHint.textContent = 'Load a model and a video or image to begin';

  emptyState.classList.remove('faded');
  statusChip.classList.add('hidden');
  toolbar.classList.add('hidden');
  updateMediaControlsVisibility();

  fileObjInput.value = '';
  fileMp4Input.value = '';
}

// ---------- Icons ----------
function updatePlayIcon() {
  const svg = document.getElementById('icon-play');
  const btn = document.getElementById('btn-play');
  if (video.paused) {
    svg.innerHTML = '<path d="M6 4l14 8-14 8Z" />';
    btn.classList.remove('active');
  } else {
    svg.innerHTML = '<path d="M8 4h3v16H8zM13 4h3v16h-3z" />';
    btn.classList.add('active');
  }
}

function updateMuteIcon() {
  const svg = document.getElementById('icon-mute');
  const btn = document.getElementById('btn-mute');
  if (video.muted) {
    svg.innerHTML =
      '<path d="M4 9v6h4l5 4V5L8 9Z" /><line x1="16.5" y1="8" x2="21" y2="16" stroke="currentColor" stroke-width="1.6"/><line x1="21" y1="8" x2="16.5" y2="16" stroke="currentColor" stroke-width="1.6"/>';
    btn.classList.remove('active');
  } else {
    svg.innerHTML = '<path d="M4 9v6h4l5 4V5L8 9Z" /><path d="M17 8a5 5 0 0 1 0 8" /><path d="M19.5 5.5a9 9 0 0 1 0 13" />';
    btn.classList.add('active');
  }
}

// ---------- Drag & drop ----------
function setupDropTarget(el, onFile) {
  ['dragenter', 'dragover'].forEach((evt) =>
    el.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drag-over');
    })
  );
  ['dragleave', 'dragend'].forEach((evt) =>
    el.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drag-over');
    })
  );
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over');
    const file = e.dataTransfer.files?.[0];
    if (file) onFile(file);
  });
}

function routeFile(file) {
  if (/\.obj$/i.test(file.name)) loadObjFile(file);
  else if (isVideoFile(file) || isImageFile(file)) loadMediaFile(file);
  else showToast(`Unrecognized file type: ${file.name}`);
}

// Whole-app drop target so users can drop anywhere on the canvas/scene.
['dragenter', 'dragover'].forEach((evt) =>
  document.body.addEventListener(evt, (e) => {
    e.preventDefault();
  })
);
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files?.[0];
  if (file) routeFile(file);
});

setupDropTarget(dropObj, loadObjFile);
setupDropTarget(dropMp4, loadMediaFile);

document.getElementById('browse-obj').addEventListener('click', () => fileObjInput.click());
document.getElementById('browse-mp4').addEventListener('click', () => fileMp4Input.click());
fileObjInput.addEventListener('change', (e) => loadObjFile(e.target.files?.[0]));
fileMp4Input.addEventListener('change', (e) => loadMediaFile(e.target.files?.[0]));

ndiToggleBtn.addEventListener('click', () => {
  const opening = ndiPanel.classList.contains('hidden');
  ndiPanel.classList.toggle('hidden');
  clearInterval(ndiPollTimer);
  ndiPollTimer = null;
  if (opening) {
    fetchNdiSources();
    ndiPollTimer = setInterval(fetchNdiSources, 3000);
  }
});
ndiRefreshBtn.addEventListener('click', fetchNdiSources);
ndiConnectBtn.addEventListener('click', () => {
  const name = ndiSelect.value;
  if (!name) {
    showToast('No NDI source selected');
    return;
  }
  connectNdi(name);
  ndiPanel.classList.add('hidden');
  clearInterval(ndiPollTimer);
  ndiPollTimer = null;
});

statusClear.addEventListener('click', clearAll);

// ---------- Toolbar ----------
document.getElementById('btn-reset').addEventListener('click', resetCameraView);
document.getElementById('btn-zoom-in').addEventListener('click', () => dolly(0.82));
document.getElementById('btn-zoom-out').addEventListener('click', () => dolly(1.22));
document.getElementById('btn-play').addEventListener('click', () => {
  if (video.paused) video.play().catch(() => showToast('Unable to play video'));
  else video.pause();
});
video.addEventListener('play', updatePlayIcon);
video.addEventListener('pause', updatePlayIcon);

document.getElementById('btn-mute').addEventListener('click', () => {
  video.muted = !video.muted;
  updateMuteIcon();
});

document.getElementById('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => showToast('Fullscreen not available'));
  } else {
    document.exitFullscreen();
  }
});
document.addEventListener('fullscreenchange', () => {
  document.getElementById('btn-fullscreen').classList.toggle('active', !!document.fullscreenElement);
});

// ---------- Resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Render loop ----------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  updateKeyLight();
  renderer.render(scene, camera);
}
animate();
