// Space Data Rig :: 3D mission room (Three.js).
//
// A round-table war room rendered in WebGL. Six particle-humanoid avatars -- one Chair
// (Mission Director) plus the five pipeline seats -- are seated around a glowing circular
// table. Above the table floats a hologram of the target currently under discussion. When
// a seat speaks, its figure brightens and agitates, a bloom-style halo and floor ring flare,
// a one-shot ring pulse ripples outward, a light beam rises, and a speech bubble tracks its
// head -- the others dim.
//
// Aesthetic pass (polish): the renderer uses ACESFilmic tone mapping + sRGB output for a
// cinematic highlight rolloff; every emissive element gets an additive halo sprite so the
// scene reads with a soft bloom even without a post-processing composer (three.js is vendored
// as a single ESM file, so the examples/jsm addons -- EffectComposer/UnrealBloomPass -- are
// not available; the additive halos + tone mapping approximate bloom). Each figure is grounded
// with a soft contact-shadow disc, and the DOM name-tags are de-cluttered every frame so they
// never stack when avatars overlap in screen space.
//
// three.js is served locally from /vendor/three.js. If WebGL is unavailable, init() returns
// false and the page still works via the text transcript below the canvas.
//
// Public API (used by app.js):
//   MissionRoom.init(canvas) -> boolean
//   MissionRoom.setAgents(list)   // [{name,status}]
//   MissionRoom.say(seat, text)   // show bubble + make seat the speaker
//   MissionRoom.setSpeaker(seat)  // highlight without a bubble
//   MissionRoom.setHologram(name) // label the central hologram
//   MissionRoom.resize(); MissionRoom.dispose()

import * as THREE from "/vendor/three.js";

export const SEAT_META = {
  chair: { color: "#ffd166", glyph: "DIR", label: "CHAIR", role: "Mission Director",
    build: { h: 1.34, shoulder: 0.46, head: 0.19, torso: 0.32, pts: 2600 } },
  "data-fetch": { color: "#3ae0ff", glyph: "DF", label: "DATA", role: "Fetch & hash light curves",
    build: { h: 1.2, shoulder: 0.36, head: 0.17, torso: 0.27, pts: 2100 } },
  "anomaly-scout": { color: "#a78bff", glyph: "AS", label: "SCOUT", role: "Find transit dips",
    build: { h: 1.32, shoulder: 0.32, head: 0.16, torso: 0.23, pts: 2100 } },
  "sim-runner": { color: "#ffb14d", glyph: "SR", label: "SIM", role: "Noise-replay confidence",
    build: { h: 1.16, shoulder: 0.46, head: 0.18, torso: 0.35, pts: 2200 } },
  "mission-critic": { color: "#ff5d8f", glyph: "MC", label: "CRITIC", role: "Cross-match & verdict",
    build: { h: 1.28, shoulder: 0.34, head: 0.15, torso: 0.25, pts: 2150 } },
  reporter: { color: "#37e2a3", glyph: "RP", label: "REPORT", role: "Narrate & seal bundle",
    build: { h: 1.2, shoulder: 0.4, head: 0.19, torso: 0.29, pts: 2100 } },
};

// seating order around the table; rotated 30deg so no figure blocks the central hologram.
const RING = ["data-fetch", "anomaly-scout", "mission-critic", "sim-runner", "reporter", "chair"];

// Screen-space tag layout: minimum vertical gap between overlapping tags (px).
const TAG_MIN_GAP = 22;
const TAG_X_PROX = 96;

// Soft white radial sprite (reused as point sprite + additive halo cores).
function sprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, "rgba(255,255,255,1)");
  rg.addColorStop(0.3, "rgba(255,255,255,0.7)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

// Radial alpha disc used for the soft ground contact-shadow under each figure.
function shadowSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  rg.addColorStop(0, "rgba(0,0,0,0.6)");
  rg.addColorStop(0.55, "rgba(0,0,0,0.3)");
  rg.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

// Build a humanoid bust point cloud in local space (feet ~0, head ~1.6).
function humanoid(b) {
  const pos = [];
  const headY = 1.5 * b.h;
  const shoulderY = 1.16 * b.h;
  const hipY = 0.52 * b.h;
  const n = b.pts;
  const headN = Math.floor(n * 0.22);
  const torsoN = Math.floor(n * 0.5);
  const armN = n - headN - torsoN;
  const rnd = () => Math.random() * 2 - 1;
  // head (sphere shell)
  for (let i = 0; i < headN; i++) {
    const u = Math.random() * Math.PI * 2, v = Math.acos(2 * Math.random() - 1);
    const r = b.head * (0.85 + Math.random() * 0.15);
    pos.push(Math.sin(v) * Math.cos(u) * r, headY + Math.cos(v) * r * 1.05, Math.sin(v) * Math.sin(u) * r);
  }
  // torso (tapered cone shoulders->hips, filled)
  for (let i = 0; i < torsoN; i++) {
    const ty = hipY + Math.random() * (shoulderY - hipY);
    const k = (ty - hipY) / (shoulderY - hipY);
    const rad = (b.torso * (1 - k) + b.shoulder * k) * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    pos.push(Math.cos(a) * rad, ty, Math.sin(a) * rad * 0.62);
  }
  // arms (two thin cones hanging from shoulders)
  for (let i = 0; i < armN; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const ay = shoulderY - Math.random() * (shoulderY - hipY - 0.05);
    const k = (shoulderY - ay) / (shoulderY - hipY);
    const off = side * (b.shoulder * 0.92 + 0.03 + rnd() * 0.02);
    pos.push(off, ay, rnd() * 0.05);
  }
  const arr = new Float32Array(pos);
  return arr;
}

let SHADOW_TEX = null;

function makeAvatar(seat, tex, R) {
  const meta = SEAT_META[seat];
  const col = new THREE.Color(meta.color);
  const base = humanoid(meta.build);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(base.slice(), 3));
  const mat = new THREE.PointsMaterial({
    size: 0.058, map: tex, color: col, transparent: true, opacity: 0.92,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);

  const group = new THREE.Group();

  // Additive halo behind the figure -- the bloom-style glow. Rises when speaking.
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, color: col, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  halo.scale.set(meta.build.h * 1.5, meta.build.h * 1.7, 1);
  halo.position.y = meta.build.h * 0.95;
  group.add(halo);

  // Soft contact shadow disc on the floor -- grounds the figure (drawn under everything).
  if (!SHADOW_TEX) SHADOW_TEX = shadowSprite();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.1),
    new THREE.MeshBasicMaterial({ map: SHADOW_TEX, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.012;
  shadow.renderOrder = -1;
  group.add(shadow);

  group.add(points);

  // light beam (spotlight feel) from table up through the figure
  const beamGeo = new THREE.CylinderGeometry(0.02, 0.5, 3.2, 20, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = 1.6;
  group.add(beam);

  // persistent floor ring under the seat
  const ringGeo = new THREE.TorusGeometry(0.55, 0.02, 8, 40);
  const ringMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);

  // one-shot expanding ring pulse, triggered on say(); scaled out + faded in frame().
  const pulseGeo = new THREE.TorusGeometry(0.55, 0.03, 8, 48);
  const pulseMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, blending: THREE.AdditiveBlending });
  const pulse = new THREE.Mesh(pulseGeo, pulseMat);
  pulse.rotation.x = Math.PI / 2;
  pulse.position.y = 0.03;
  group.add(pulse);

  const idx = RING.indexOf(seat);
  const a = (idx / RING.length) * Math.PI * 2 + Math.PI / 6; // 30deg offset keeps the centre clear
  group.position.set(Math.sin(a) * R, 0, Math.cos(a) * R);
  group.scale.setScalar(1.42);
  group.lookAt(0, group.position.y, 0);

  return {
    seat, group, points, mat, base, count: base.length / 3,
    beam, beamMat, ring, ringMat, pulse, pulseMat, halo, shadow, color: col,
    amp: 0.008, targetAmp: 0.008, glow: 0.92, targetGlow: 0.92,
    haloOpacity: 0.22, targetHalo: 0.22, pulseT: -1,
    haloBase: new THREE.Vector3(meta.build.h * 1.5, meta.build.h * 1.7, 1),
    phase: Math.random() * Math.PI * 2,
    headLocal: new THREE.Vector3(0, 1.5 * meta.build.h + 0.3, 0),
  };
}

const MissionRoom = (function () {
  let renderer, scene, camera, canvas, raf = 0, ok = false;
  let avatars = [], tex, holo, holoMat, haloMat, ringLight, star, clock;
  let speaker = null, hologramLabel = "SYSTEM";
  let mouseX = 0, mouseY = 0, camAngle = 0;
  const tmpV = new THREE.Vector3();

  function buildStars() {
    const n = 2200, p = new Float32Array(n * 3), s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = 40 + Math.random() * 42, u = Math.random() * Math.PI * 2, v = Math.acos(2 * Math.random() - 1);
      p[i * 3] = r * Math.sin(v) * Math.cos(u);
      p[i * 3 + 1] = r * Math.cos(v) * 0.6 + 6;
      p[i * 3 + 2] = r * Math.sin(v) * Math.sin(u);
      s[i] = 0.35 + Math.random() * 0.65;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    g.setAttribute("size", new THREE.BufferAttribute(s, 1));
    const m = new THREE.PointsMaterial({ size: 0.5, color: 0xaad0ff, transparent: true, opacity: 0.85, map: tex, depthWrite: false, blending: THREE.AdditiveBlending });
    star = new THREE.Points(g, m);
    scene.add(star);
  }

  function buildTable() {
    const R = 2.9;
    // holo table surface texture: concentric rings + radial spokes
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const g = c.getContext("2d");
    g.fillStyle = "#050c18"; g.fillRect(0, 0, 512, 512);
    g.translate(256, 256);
    g.strokeStyle = "rgba(70,150,220,0.5)";
    for (let r = 40; r < 256; r += 40) { g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); }
    g.strokeStyle = "rgba(60,130,200,0.3)";
    for (let a = 0; a < 12; a++) { g.rotate(Math.PI / 6); g.beginPath(); g.moveTo(0, 0); g.lineTo(256, 0); g.stroke(); }
    const surfTex = new THREE.CanvasTexture(c);
    const surf = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.MeshBasicMaterial({ map: surfTex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    surf.rotation.x = -Math.PI / 2;
    surf.position.y = 1.0;
    scene.add(surf);

    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.03, 12, 96), new THREE.MeshBasicMaterial({ color: 0x3ae0ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending }));
    rim.rotation.x = Math.PI / 2; rim.position.y = 1.0;
    scene.add(rim);

    // soft rim halo so the table glows like a bloom source
    const rimGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x2a86c8, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
    rimGlow.scale.set(R * 2.6, R * 2.6, 1);
    rimGlow.position.y = 1.0;
    scene.add(rimGlow);

    // pedestal
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.6, 1.0, 32, 1, true), new THREE.MeshBasicMaterial({ color: 0x0a1830, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    ped.position.y = 0.5; scene.add(ped);

    // floor grid disc
    const grid = new THREE.Mesh(new THREE.RingGeometry(3.3, 9.5, 48, 6), new THREE.MeshBasicMaterial({ color: 0x123055, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
    grid.rotation.x = -Math.PI / 2; grid.position.y = 0.001; scene.add(grid);
  }

  function buildHologram() {
    holo = new THREE.Group();
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), new THREE.MeshBasicMaterial({ color: 0xffcf7a, wireframe: true, transparent: true, opacity: 0.9 }));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.45, 24, 24), new THREE.MeshBasicMaterial({ color: 0xffb14d, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending }));
    // additive halo sprite so the hologram blooms
    haloMat = new THREE.SpriteMaterial({ map: tex, color: 0xffb14d, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending });
    const halo = new THREE.Sprite(haloMat);
    halo.scale.set(3.2, 3.2, 1);
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.012, 8, 64), new THREE.MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending }));
    orbit.rotation.x = Math.PI / 2.4;
    const moon = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), new THREE.MeshBasicMaterial({ color: 0x9fe8ff }));
    moon.position.set(1.15, 0, 0);
    orbit.add(moon);
    holoMat = glow.material;
    holo.add(halo, core, glow, orbit);
    holo.position.y = 2.95;
    holo.userData = { core, orbit, moon };
    scene.add(holo);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    const t = clock.getElapsedTime();
    const spk = speakerObj();

    // shimmer + speaking agitation + FX
    for (const av of avatars) {
      const isSpk = av === spk;
      av.amp += (av.targetAmp - av.amp) * 0.08;
      av.glow += (av.targetGlow - av.glow) * 0.08;
      const arr = av.points.geometry.attributes.position.array;
      const base = av.base;
      for (let i = 0; i < arr.length; i += 3) {
        const bx = base[i], by = base[i + 1], bz = base[i + 2];
        const w = t * 2.2 + av.phase + by * 3.0;
        arr[i] = bx + Math.sin(w) * av.amp;
        arr[i + 1] = by + Math.cos(w * 1.3) * av.amp;
        arr[i + 2] = bz + Math.sin(w * 0.7) * av.amp;
      }
      av.points.geometry.attributes.position.needsUpdate = true;
      av.mat.opacity = av.glow;
      av.mat.size = 0.05 + av.amp * 2.4;

      // gentle breathing; the contact shadow + grounded feet keep them planted.
      av.group.position.y = Math.sin(t * 0.8 + av.phase) * 0.008;

      // bloom halo eases toward its target; pulses a little while speaking.
      av.targetHalo = isSpk ? 0.6 : 0.22;
      av.haloOpacity += (av.targetHalo - av.haloOpacity) * 0.1;
      const hb = isSpk ? 1 + Math.sin(t * 3.2 + av.phase) * 0.06 : 1;
      av.halo.material.opacity = av.haloOpacity;
      av.halo.scale.set(av.haloBase.x * hb, av.haloBase.y * hb, 1);

      av.beamMat.opacity += ((isSpk ? 0.26 : 0) - av.beamMat.opacity) * 0.1;
      av.ringMat.opacity = 0.2 + (isSpk ? 0.6 : 0) + Math.sin(t * 3 + av.phase) * 0.05;

      // one-shot ring pulse (advances 0..1 over ~1.1s from say()), then rests transparent.
      if (av.pulseT >= 0) {
        const p = (t - av.pulseT) / 1.1;
        if (p >= 1) {
          av.pulseT = -1;
          av.pulseMat.opacity = 0;
          av.pulse.scale.setScalar(1);
        } else {
          av.pulse.scale.setScalar(1 + p * 2.4);
          av.pulseMat.opacity = 0.55 * (1 - p);
        }
      }
    }

    // hologram motion + slow halo breathe
    if (holo) {
      holo.rotation.y = t * 0.4;
      holo.userData.orbit.rotation.z = t * 0.6;
      holo.position.y = 2.95 + Math.sin(t * 0.9) * 0.06;
      holoMat.opacity = 0.2 + 0.1 * Math.sin(t * 2);
      haloMat.opacity = 0.34 + 0.1 * Math.sin(t * 1.4);
    }
    if (star) star.rotation.y = t * 0.01;
    if (ringLight) ringLight.intensity = 1.1 + Math.sin(t * 1.5) * 0.2;

    // camera: slow drift + mouse parallax
    camAngle += 0.0006;
    const rad = 8.4;
    const sway = Math.sin(camAngle) * 0.5 + mouseX * 0.9;
    camera.position.x += (sway - camera.position.x) * 0.03;
    camera.position.y += (3.9 + mouseY * -1.0 - camera.position.y) * 0.03;
    camera.position.z = rad * Math.cos(Math.sin(camAngle) * 0.12);
    camera.lookAt(0, 1.75, 0);

    renderer.render(scene, camera);
    updateOverlay();
  }

  function speakerObj() { return speaker ? avatars.find((a) => a.seat === speaker) : null; }

  // project avatar heads to screen for DOM tags + speech bubble
  const overlay = { root: null, tags: {}, bubble: null, bubbleText: null, bubbleSeat: null };
  function updateOverlay() {
    if (!overlay.root) return;
    const rect = canvas.getBoundingClientRect();
    // 1) compute raw head screen positions
    const items = [];
    for (const av of avatars) {
      tmpV.copy(av.headLocal).applyMatrix4(av.group.matrixWorld).project(camera);
      const x = (tmpV.x * 0.5 + 0.5) * rect.width;
      const y = (-tmpV.y * 0.5 + 0.5) * rect.height;
      items.push({ av, x, y, visible: tmpV.z < 1 });
    }
    // 2) de-clutter: sort by screen y and push overlapping tags below their neighbour
    const sorted = items.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i], prev = sorted[i - 1];
      if (Math.abs(cur.x - prev.x) < TAG_X_PROX && cur.y - prev.y < TAG_MIN_GAP) cur.y = prev.y + TAG_MIN_GAP;
    }
    // 3) apply
    for (const it of items) {
      const tag = overlay.tags[it.av.seat];
      if (!tag) continue;
      const isSpk = it.av.seat === speaker;
      tag.style.transform = `translate(-50%,-50%) translate(${it.x}px,${it.y}px)`;
      tag.classList.toggle("is-speaker", isSpk);
      // when a seat is speaking, the bubble already carries its identity -> fade its tag.
      let op = speaker ? (isSpk ? 0 : 0.5) : 0.85;
      if (!it.visible) op = 0;
      tag.style.opacity = String(op);
      if (isSpk && overlay.bubble) {
        const half = Math.min(160, rect.width / 2 - 8);
        const bx = Math.max(half, Math.min(rect.width - half, it.x));
        overlay.bubble.style.transform = `translate(-50%,-100%) translate(${bx}px,${it.y - 34}px)`;
      }
    }
  }

  function attachOverlay(root) {
    overlay.root = root;
    for (const av of avatars) {
      const meta = SEAT_META[av.seat];
      const tag = document.createElement("div");
      tag.className = "avatar-tag";
      tag.style.setProperty("--sc", meta.color);
      tag.innerHTML = `<span class="at-glyph">${meta.glyph}</span><span class="at-name">${meta.label}</span>`;
      root.appendChild(tag);
      overlay.tags[av.seat] = tag;
    }
    const b = document.createElement("div");
    b.className = "speech-bubble";
    b.innerHTML = `<span class="sb-seat"></span><span class="sb-text"></span>`;
    root.appendChild(b);
    overlay.bubble = b;
    overlay.bubbleText = b.querySelector(".sb-text");
    overlay.bubbleSeat = b.querySelector(".sb-seat");
  }

  function setHighlight() {
    for (const av of avatars) {
      const isSpk = av.seat === speaker;
      av.targetAmp = isSpk ? 0.034 : 0.008;
      av.targetGlow = speaker ? (isSpk ? 1.0 : 0.28) : 0.92;
    }
    if (overlay.bubble) overlay.bubble.classList.toggle("show", Boolean(speaker));
  }

  return {
    init(cv) {
      canvas = cv;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
      } catch (e) {
        return false;
      }
      if (!renderer.getContext()) return false;
      renderer.setClearColor(0x000000, 0);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.22;
      if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
      scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x03050d, 0.026);
      camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
      camera.position.set(0, 3.9, 8.4);
      clock = new THREE.Clock();
      tex = sprite();

      scene.add(new THREE.AmbientLight(0x2a3a5a, 0.75));
      ringLight = new THREE.PointLight(0x66aaff, 1.3, 32);
      ringLight.position.set(0, 5.2, 2);
      scene.add(ringLight);

      buildStars();
      buildTable();
      buildHologram();
      const R = 3.85;
      avatars = RING.map((s) => makeAvatar(s, tex, R));
      avatars.forEach((a) => scene.add(a.group));

      ok = true;
      this.resize();
      window.addEventListener("resize", () => this.resize());
      raf = requestAnimationFrame(frame);
      return true;
    },

    attachOverlay,

    setAgents(list) {
      if (!list) return;
      for (const s of list) {
        const av = avatars.find((a) => a.seat === s.name);
        if (av) av.status = s.status;
      }
    },

    setSpeaker(seat) {
      speaker = seat || null;
      setHighlight();
    },

    say(seat, text) {
      speaker = seat;
      setHighlight();
      const av = avatars.find((a) => a.seat === seat);
      if (av) av.pulseT = clock ? clock.getElapsedTime() : 0; // trigger ring pulse
      if (overlay.bubble && text != null) {
        const meta = SEAT_META[seat];
        overlay.bubble.style.setProperty("--sc", meta ? meta.color : "#3ae0ff");
        overlay.bubbleSeat.textContent = meta ? meta.label : seat;
        overlay.bubbleText.textContent = text.length > 150 ? text.slice(0, 148) + "..." : text;
      }
    },

    setHologram(name) {
      hologramLabel = name || "SYSTEM";
    },

    resize() {
      if (!ok || !canvas) return;
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },

    pointer(nx, ny) { mouseX = nx; mouseY = ny; },

    dispose() {
      ok = false;
      cancelAnimationFrame(raf);
      if (renderer) renderer.dispose();
    },
  };
})();

export { MissionRoom };
