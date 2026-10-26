import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      width: size * 2,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#07060d', light: '#ffffff' },
    })
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null));
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return (
    <div
      className="rounded-2xl bg-white p-3 shadow-[0_0_60px_-10px_var(--color-neon-violet)]"
      style={{ width: size + 24, height: size + 24 }}
    >
      {src && <img src={src} width={size} height={size} alt={`QR code to join: ${value}`} />}
    </div>
  );
}
