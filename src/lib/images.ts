export const MAX_SOURCE_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_COMPRESSED_IMAGE_BYTES = 1_500_000;
const SUPPORTED_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Decode and redraw photographs to strip metadata and cap dimensions and storage size. */
export async function compressImage(file: File): Promise<Blob> {
  if (!SUPPORTED_TYPES.includes(file.type))
    throw new Error(
      "Choose a JPEG, PNG or WebP image. HEIC photos must be exported as JPEG first.",
    );
  if (!file.size || file.size > MAX_SOURCE_IMAGE_BYTES)
    throw new Error("Choose an image smaller than 12 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("This image could not be opened. Try another photo."));
      image.src = url;
    });
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      image.naturalWidth * image.naturalHeight > 100_000_000
    )
      throw new Error(
        "This photo is too large to process safely. Choose a smaller image.",
      );
    const scale = Math.min(
      1,
      1600 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Image processing is unavailable in this browser.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.84, 0.72, 0.58, 0.42]) {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value
              ? resolve(value)
              : reject(new Error("Image compression failed.")),
          "image/jpeg",
          quality,
        ),
      );
      if (blob.size <= MAX_COMPRESSED_IMAGE_BYTES) return blob;
    }
    throw new Error(
      "This photo is still too large after compression. Crop it or choose a smaller image.",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
