import {useEffect, useRef} from 'react';
import {gazeAt} from '../../src/gaze/gaze-replay.js';
import {contentRect, maskCanvas} from '../lib/frames.js';

// The glasses video, fitted whole into the stage (object-fit: contain), and a canvas over exactly the video content:
// YOLO boxes with names and distances, the SAM 3.1 segment at the gaze point, and the live gaze point itself.

const ACCENT = [65, 215, 162];
const SEGMENT_FADE_MS = 1600, DETECTION_FADE_MS = 1200;

function drawLabel(ctx, text, x, y, d, {strong = false} = {}) {
  ctx.font = `${strong ? 600 : 500} ${(strong ? 14 : 12) * d}px "IBM Plex Sans", system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 12 * d, h = (strong ? 24 : 20) * d, top = Math.max(0, y - h);
  ctx.fillStyle = strong ? 'rgba(10,12,13,.88)' : 'rgba(10,12,13,.72)';
  ctx.fillRect(x, top, w, h);
  ctx.fillStyle = strong ? `rgb(${ACCENT})` : '#e9ecee';
  ctx.fillText(text, x + 6 * d, top + h - (strong ? 7.5 : 6) * d);
}

export default function SceneStage({videoRef, track, live, onEnded, onTimeUpdate, children}) {
  const stageRef = useRef(null), canvasRef = useRef(null), maskCache = useRef({mask:null, canvas:null});

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const video = videoRef.current, canvas = canvasRef.current, stage = stageRef.current;
      if (!video || !canvas || !stage) return;
      const box = stage.getBoundingClientRect(), rect = contentRect(video, box), d = window.devicePixelRatio || 1;
      if (!rect) return;
      Object.assign(canvas.style, {left:`${rect.left}px`, top:`${rect.top}px`, width:`${rect.width}px`, height:`${rect.height}px`});
      const w = Math.round(rect.width * d), h = Math.round(rect.height * d);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, w, h);
      const state = live.current, now = performance.now();

      const det = state.detections;
      if (det && now - det.at < DETECTION_FADE_MS) {
        const sx = w / det.frame.width, sy = h / det.frame.height;
        ctx.globalAlpha = 1 - Math.max(0, (now - det.at - 400) / (DETECTION_FADE_MS - 400));
        for (const item of det.list.filter(item => item.score >= .35).slice(0, 8)) {
          const b = item.bounds, x = b.left * sx, y = b.top * sy;
          ctx.lineWidth = 1.5 * d; ctx.strokeStyle = 'rgba(233,236,238,.75)';
          ctx.strokeRect(x, y, (b.right - b.left) * sx, (b.bottom - b.top) * sy);
          const meters = item.depthM;
          drawLabel(ctx, `${item.label}${meters ? ` · ${meters.toFixed(1)} m` : ''}`, x, y, d);
        }
        ctx.globalAlpha = 1;
      }

      const seg = state.segment;
      if (seg?.mask && now - seg.at < SEGMENT_FADE_MS) {
        const m = seg.mask, sx = w / seg.frame.width, sy = h / seg.frame.height;
        if (maskCache.current.mask !== m) maskCache.current = {mask:m, canvas:maskCanvas(m, [...ACCENT, 110])};
        ctx.globalAlpha = 1 - Math.max(0, (now - seg.at - 900) / (SEGMENT_FADE_MS - 900));
        const b = m.bounds, x = b.left * sx, y = b.top * sy, bw = (b.right - b.left) * sx, bh = (b.bottom - b.top) * sy;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(maskCache.current.canvas, x, y, bw, bh);
        ctx.lineWidth = 2 * d; ctx.strokeStyle = `rgb(${ACCENT})`; ctx.strokeRect(x, y, bw, bh);
        // the gaze point SAM was prompted with, in the analysed frame (the live crosshair moves on with the head)
        ctx.fillStyle = `rgb(${ACCENT})`; ctx.beginPath(); ctx.arc(seg.gaze.x * w, seg.gaze.y * h, 5 * d, 0, Math.PI * 2); ctx.fill();
        const name = seg.label ?? 'object';
        drawLabel(ctx, `Looking at ${name}${seg.depthM ? ` · ${seg.depthM.toFixed(1)} m` : ''}${seg.memoryId ? ' · in 3D memory' : ''}`, x, y, d, {strong:true});
        ctx.globalAlpha = 1;
      }

      const gaze = track ? gazeAt(track, video.currentTime) : null;
      if (gaze) {
        const x = gaze.x * w, y = gaze.y * h, r = 10 * d;
        ctx.lineWidth = 2 * d; ctx.strokeStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.moveTo(x - r * 1.7, y); ctx.lineTo(x - r * .6, y); ctx.moveTo(x + r * .6, y); ctx.lineTo(x + r * 1.7, y);
        ctx.moveTo(x, y - r * 1.7); ctx.lineTo(x, y - r * .6); ctx.moveTo(x, y + r * .6); ctx.lineTo(x, y + r * 1.7);
        ctx.stroke();
        ctx.fillStyle = `rgb(${ACCENT})`; ctx.beginPath(); ctx.arc(x, y, 3 * d, 0, Math.PI * 2); ctx.fill();
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [videoRef, track, live]);

  return (
    <div className="stage" ref={stageRef}>
      <video ref={videoRef} className="scene-video" muted playsInline preload="auto" onEnded={onEnded} onTimeUpdate={onTimeUpdate} />
      <canvas ref={canvasRef} className="scene-overlay" aria-hidden="true" />
      {children}
    </div>
  );
}
