import { useState, useRef, useEffect } from 'react';
import './CropModal.css';

function CropModal({ src, onConfirm, onCancel }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const cropRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  const dragRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const padding = 48;
      const headerH = 180;
      const maxW = Math.min(window.innerWidth - padding, 600);
      const maxH = Math.min(window.innerHeight - headerH, 520);
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);

      // Default: full image selected
      cropRef.current = { x: 0, y: 0, w: canvas.width, h: canvas.height };
      redraw();
      setReady(true);
    };
    img.src = src;
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const redraw = () => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    const { x, y, w, h } = cropRef.current;

    // Full image (dimmed)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (w > 0 && h > 0) {
      // Bright crop area
      ctx.drawImage(img, x, y, w, h, x, y, w, h);

      // Border
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);

      // Rule-of-thirds grid
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.5;
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath(); ctx.moveTo(x + (w * i) / 3, y); ctx.lineTo(x + (w * i) / 3, y + h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y + (h * i) / 3); ctx.lineTo(x + w, y + (h * i) / 3); ctx.stroke();
      }

      // Corner handles
      const hs = 9;
      ctx.fillStyle = 'white';
      [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy]) => {
        ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      });
    }
  };

  const getPos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches?.[0];
    const cx = ((touch?.clientX ?? e.clientX) - rect.left) * (canvas.width / rect.width);
    const cy = ((touch?.clientY ?? e.clientY) - rect.top) * (canvas.height / rect.height);
    return {
      x: Math.max(0, Math.min(canvas.width, cx)),
      y: Math.max(0, Math.min(canvas.height, cy)),
    };
  };

  const handleDown = (e) => {
    e.preventDefault();
    const pos = getPos(e);
    dragRef.current = { startX: pos.x, startY: pos.y };
  };

  const handleMove = (e) => {
    e.preventDefault();
    if (!dragRef.current) return;
    const pos = getPos(e);
    cropRef.current = {
      x: Math.min(dragRef.current.startX, pos.x),
      y: Math.min(dragRef.current.startY, pos.y),
      w: Math.abs(pos.x - dragRef.current.startX),
      h: Math.abs(pos.y - dragRef.current.startY),
    };
    redraw();
  };

  const handleUp = (e) => {
    e.preventDefault();
    dragRef.current = null;
  };

  const handleConfirm = () => {
    const img = imgRef.current;
    const display = canvasRef.current;
    if (!img || !display) return;

    let { x, y, w, h } = cropRef.current;
    if (!w || !h || w < 10 || h < 10) {
      x = 0; y = 0; w = display.width; h = display.height;
    }

    const scaleX = img.naturalWidth / display.width;
    const scaleY = img.naturalHeight / display.height;
    const out = document.createElement('canvas');
    out.width = Math.round(w * scaleX);
    out.height = Math.round(h * scaleY);
    out.getContext('2d').drawImage(img, x * scaleX, y * scaleY, w * scaleX, h * scaleY, 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      onConfirm(new File([blob], `crop-${Date.now()}.jpg`, { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  };

  return (
    <div className="crop-modal-overlay">
      <div className="crop-modal-box">
        <div className="crop-modal-header">
          <strong>Crop Image</strong>
          <span className="crop-modal-hint">Drag to adjust the crop area</span>
        </div>

        {!ready && <div className="crop-loading">Loading…</div>}
        <canvas
          ref={canvasRef}
          className={`crop-canvas${ready ? '' : ' crop-canvas-hidden'}`}
          onMouseDown={handleDown}
          onMouseMove={handleMove}
          onMouseUp={handleUp}
          onMouseLeave={handleUp}
          onTouchStart={handleDown}
          onTouchMove={handleMove}
          onTouchEnd={handleUp}
          style={{ touchAction: 'none', cursor: 'crosshair', display: 'block', maxWidth: '100%' }}
        />

        <div className="crop-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Retake</button>
          <button type="button" className="btn btn-primary" onClick={handleConfirm}>Use This</button>
        </div>
      </div>
    </div>
  );
}

export default CropModal;
