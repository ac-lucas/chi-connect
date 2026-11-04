import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'preact/hooks';

type CameraState = 'starting' | 'running' | 'denied' | 'unavailable' | 'error';

interface Props {
  /** Called with the raw text of the first QR code seen. Return false to keep scanning (for example, a bad code). */
  onResult: (text: string) => Promise<boolean> | boolean;
}

const SCAN_EVERY_MS = 200;
const MAX_FRAME_WIDTH = 720;

/**
 * Reads QR codes from the camera with jsQR. Camera access needs a secure context (HTTPS or localhost);
 * behaviour across iOS Safari and Android Chrome is "verify" until tested on devices.
 */
export function QrScanner({ onResult }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<CameraState>('starting');
  const latest = useRef(onResult);
  latest.current = onResult;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let busy = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia || !ctx) {
        setState('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      } catch (e) {
        const name = (e as DOMException)?.name;
        setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : name === 'NotFoundError' ? 'unavailable' : 'error');
        return;
      }
      if (stopped || !video.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const v = video.current;
      v.srcObject = stream;
      try {
        await v.play();
      } catch {
        // Some browsers need the muted + playsinline attributes, which are set; ignore and keep trying frames.
      }
      setState('running');
      tick();
    }

    function tick() {
      if (stopped) return;
      timer = setTimeout(async () => {
        const v = video.current;
        if (!busy && v && v.readyState >= 2 && v.videoWidth > 0 && ctx) {
          const scale = Math.min(1, MAX_FRAME_WIDTH / v.videoWidth);
          canvas.width = Math.round(v.videoWidth * scale);
          canvas.height = Math.round(v.videoHeight * scale);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
          if (found?.data) {
            busy = true;
            const done = await latest.current(found.data);
            busy = false;
            if (done) return; // stop scanning; the parent will unmount us
          }
        }
        tick();
      }, SCAN_EVERY_MS);
    }

    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div class="scanner stack">
      <div class="scanner-frame" hidden={state !== 'starting' && state !== 'running'}>
        <video ref={video} muted playsInline aria-label="Camera view for scanning their code" />
      </div>
      <p role="status" class="hint">
        {state === 'starting' && 'Starting the camera…'}
        {state === 'running' && 'Point the camera at their code. It reads it on its own.'}
        {state === 'denied' && 'Camera access is off for this site. You can paste their link below instead, or allow the camera in your browser settings.'}
        {state === 'unavailable' && 'No camera available here. Paste their link below instead.'}
        {state === 'error' && 'The camera didn’t start. Paste their link below instead, or try again.'}
      </p>
    </div>
  );
}
