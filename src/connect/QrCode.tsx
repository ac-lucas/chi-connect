import QRCode from 'qrcode';
import { useEffect, useState } from 'preact/hooks';

/** Renders text as a QR image. Always dark on white with a quiet zone, whatever the theme, so cameras can read it. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setSrc(null);
    QRCode.toDataURL(text, { errorCorrectionLevel: 'L', margin: 4, width: 640, color: { dark: '#000000', light: '#ffffff' } })
      .then((url) => live && setSrc(url))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [text]);

  if (failed) return <p class="error">Couldn’t draw the code. Use the link below instead.</p>;
  if (!src) return <div class="qr qr-loading" role="img" aria-label="Drawing your code" />;
  return <img class="qr" src={src} alt={label} width={640} height={640} />;
}
