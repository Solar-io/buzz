import { useEffect, useRef } from "react";
import jsQR from "jsqr";

/**
 * Camera QR scanner for device pairing. Renders a live <video> and polls
 * frames through jsQR; calls `onResult` exactly once, then unmounts the
 * camera. Requires a secure context (tailnet HTTPS qualifies).
 */
export function QrScanner({
  onResult,
  onError,
}: {
  onResult: (text: string) => void;
  onError: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const scan = () => {
      const video = videoRef.current;
      if (
        !cancelled &&
        !firedRef.current &&
        video &&
        context &&
        video.readyState === video.HAVE_ENOUGH_DATA
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (canvas.width > 0 && canvas.height > 0) {
          context.drawImage(video, 0, 0);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(image.data, image.width, image.height, {
            inversionAttempts: "dontInvert",
          });
          if (code?.data) {
            firedRef.current = true;
            onResult(code.data);
            return;
          }
        }
      }
      if (!cancelled && !firedRef.current) {
        raf = requestAnimationFrame(scan);
      }
    };

    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" } })
      .then((mediaStream) => {
        if (cancelled) {
          for (const track of mediaStream.getTracks()) {
            track.stop();
          }
          return;
        }
        stream = mediaStream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = mediaStream;
          void video.play();
        }
        raf = requestAnimationFrame(scan);
      })
      .catch(() => {
        onError(
          "Camera unavailable. Allow camera access or paste the key instead.",
        );
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      for (const track of stream?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, [onResult, onError]);

  return (
    <video
      ref={videoRef}
      playsInline
      muted
      autoPlay
      className="w-full max-w-sm rounded-lg bg-black aspect-square object-cover"
    />
  );
}
