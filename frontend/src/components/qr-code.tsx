import qrcode from "qrcode-generator";
import { useMemo } from "react";

export type QrCodeProps = {
  value: string;
  /** Rendered size in CSS pixels. */
  size?: number;
  label: string;
  className?: string;
};

/**
 * Client-side QR code (e.g. an `otpauth://` URI) rendered as an inline SVG path:
 * the secret never leaves the browser, and no HTML string is injected.
 */
export function QrCode({ value, size = 176, label, className }: QrCodeProps) {
  const { path, modules } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          d += `M${col + 4},${row + 4}h1v1h-1z`;
        }
      }
    }
    return { path: d, modules: count + 8 };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
