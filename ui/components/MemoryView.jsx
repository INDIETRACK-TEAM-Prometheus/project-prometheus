import {useEffect, useRef} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {CSS2DRenderer, CSS2DObject} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {poseAt} from '../../src/gaze/gaze-replay.js';

// The 3D memory: every object the wearer looked at and SAM 3.1 segmented, placed where it is in the room (MPS world
// frame, metres, +z up), with the wearer's path so far and where they are and face now.

const ACCENT = 0x41d7a2;

export default function MemoryView({track, sceneRef, objects, recalledCloud}) {
  const hostRef = useRef(null), apiRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    const renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    host.append(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'memory-labels';
    host.append(labels.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 1, .05, 200);
    camera.up.set(0, 0, 1); camera.position.set(-4, -4, 5);
    const controls = new OrbitControls(camera, labels.domElement);
    controls.enableDamping = true;
    const grid = new THREE.GridHelper(20, 20, 0x3a4044, 0x262a2d);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid, new THREE.AmbientLight(0xffffff, .9));
    const path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({color:0x8a9196}));
    const wearer = new THREE.Mesh(new THREE.ConeGeometry(.12, .3, 16), new THREE.MeshBasicMaterial({color:0xffffff}));
    const sight = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({color:ACCENT, dashSize:.08, gapSize:.06}));
    const objectGroup = new THREE.Group();
    // the room itself: MPS SLAM semi-dense points, coloured by height
    const cloud = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({size:.025, vertexColors:true, transparent:true, opacity:.55}));
    // room points remembered from earlier recordings of the same place
    const earlier = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({size:.02, color:0x6f8da3, transparent:true, opacity:.35}));
    scene.add(earlier, cloud, path, wearer, sight, objectGroup);
    let frame = 0, followed = false;
    const target = new THREE.Vector3();
    const resize = () => {
      const {width, height} = host.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height); labels.setSize(width, height);
      camera.aspect = width / height; camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize); observer.observe(host); resize();
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const {track: t, sceneRef: s, lastObject} = apiRef.current ?? {};
      const time = s?.current?.currentTime ?? 0, pose = t ? poseAt(t, time) : null;
      if (pose) {
        const position = new THREE.Vector3(pose[3], pose[7], pose[11]), forward = new THREE.Vector3(pose[2], pose[6], pose[10]).normalize();
        wearer.position.copy(position);
        wearer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), forward);
        // follow the wearer smoothly; the user can still orbit around them
        target.lerp(position, followed ? .05 : 1); followed = true;
        const delta = target.clone().sub(controls.target);
        controls.target.add(delta); camera.position.add(delta);
        if (lastObject) { sight.geometry.setFromPoints([position, new THREE.Vector3(...lastObject.position)]); sight.computeLineDistances(); sight.visible = true; }
        else sight.visible = false;
      }
      controls.update();
      renderer.render(scene, camera); labels.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);
    apiRef.current = {...apiRef.current, path, objectGroup, cloud, earlier};
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); renderer.dispose();
      renderer.domElement.remove(); labels.domElement.remove();
    };
  }, []);

  // The wearer's path over the whole clip (a few hundred poses), recomputed when the clip changes.
  useEffect(() => {
    apiRef.current = {...apiRef.current, track, sceneRef};
    const path = apiRef.current.path;
    if (!path) return;
    const points = (track?.samples ?? []).filter(s => s.pose).map(s => new THREE.Vector3(s.pose[3], s.pose[7], s.pose[11]));
    path.geometry.dispose(); path.geometry = new THREE.BufferGeometry().setFromPoints(points);
    const cloud = apiRef.current.cloud, xyz = track?.cloud;
    cloud.geometry.dispose(); cloud.geometry = new THREE.BufferGeometry();
    if (xyz) {
      let low = Infinity, high = -Infinity;
      for (let i = 2; i < xyz.length; i += 3) { low = Math.min(low, xyz[i]); high = Math.max(high, xyz[i]); }
      const colors = new Float32Array(xyz.length);
      for (let i = 0; i < xyz.length; i += 3) { const v = .25 + .55 * (xyz[i + 2] - low) / Math.max(.01, high - low); colors[i] = v * .85; colors[i + 1] = v * .92; colors[i + 2] = v; }
      cloud.geometry.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
      cloud.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
  }, [track, sceneRef]);

  useEffect(() => {
    const earlier = apiRef.current?.earlier;
    if (!earlier) return;
    earlier.geometry.dispose(); earlier.geometry = new THREE.BufferGeometry();
    if (recalledCloud?.length) earlier.geometry.setAttribute('position', new THREE.BufferAttribute(recalledCloud, 3));
  }, [recalledCloud]);

  useEffect(() => {
    const group = apiRef.current?.objectGroup;
    apiRef.current = {...apiRef.current, lastObject:objects.reduce((a, b) => !a || b.lastT > a.lastT ? b : a, null)};
    if (!group) return;
    for (const child of [...group.children]) { child.traverse(node => { if (node.isCSS2DObject) node.element.remove(); }); group.remove(child); }
    const latest = apiRef.current.lastObject;
    for (const object of objects) {
      const fresh = object === latest, earlierOnly = object.recalled && !object.seenAgain;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(fresh ? .1 : .07, 16, 12), new THREE.MeshBasicMaterial({color:fresh ? ACCENT : earlierOnly ? 0x6f8da3 : 0xe9ecee}));
      dot.position.set(...object.position);
      const tag = document.createElement('span');
      tag.className = fresh ? 'memory-tag fresh' : earlierOnly ? 'memory-tag recalled' : 'memory-tag';
      tag.textContent = `${object.label ?? 'object'}${object.count > 1 ? ` ×${object.count}` : ''}${earlierOnly ? ' · earlier' : object.recalled ? ' · found again' : ''}`;
      const label = new CSS2DObject(tag); label.position.set(0, 0, .18); dot.add(label);
      group.add(dot);
    }
  }, [objects]);

  return <div className="memory-canvas" ref={hostRef} />;
}
