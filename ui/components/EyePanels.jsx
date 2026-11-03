import {useEffect, useRef} from 'react';

// The Aria eye-tracking camera (both eyes side by side in one video), split into a left and a right panel and kept in
// step with the scene video. These are the images the glasses' eye gaze is computed from.
export default function EyePanels({src, sceneRef}) {
  const eyesRef = useRef(null), leftRef = useRef(null), rightRef = useRef(null);

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const eyes = eyesRef.current, scene = sceneRef.current;
      if (!eyes || !scene || !src) return;
      if (Math.abs(eyes.currentTime - scene.currentTime) > .15) eyes.currentTime = scene.currentTime;
      if (scene.paused !== eyes.paused) scene.paused ? eyes.pause() : void eyes.play().catch(() => {});
      if (eyes.readyState < 2 || !eyes.videoWidth) return;
      const half = eyes.videoWidth / 2, h = eyes.videoHeight;
      [leftRef.current, rightRef.current].forEach((canvas, index) => {
        if (!canvas) return;
        if (canvas.width !== half || canvas.height !== h) { canvas.width = half; canvas.height = h; }
        canvas.getContext('2d').drawImage(eyes, index * half, 0, half, h, 0, 0, half, h);
      });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [src, sceneRef]);

  return (
    <section className="eyes" aria-label="Eye-tracking camera">
      <video ref={eyesRef} src={src ?? undefined} muted playsInline preload="auto" hidden />
      <figure><canvas ref={leftRef} /><figcaption>Left eye</figcaption></figure>
      <figure><canvas ref={rightRef} /><figcaption>Right eye</figcaption></figure>
    </section>
  );
}
