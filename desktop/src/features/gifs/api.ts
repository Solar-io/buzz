import type { BlobDescriptor } from "@/shared/api/tauri";

type KlipyAsset = {
  height?: number;
  size?: number;
  url?: string;
  width?: number;
};

type KlipyFileSet = {
  gif?: KlipyAsset;
  jpg?: KlipyAsset;
  webp?: KlipyAsset;
};

type KlipyRawGif = {
  file?: {
    hd?: KlipyFileSet;
    md?: KlipyFileSet;
    sm?: KlipyFileSet;
    xs?: KlipyFileSet;
  };
  id?: number;
  slug?: string;
  title?: string;
  type?: string;
};

export type KlipyResponse = {
  data?: {
    data?: KlipyRawGif[];
  };
  errors?: {
    message?: string[];
  };
  result?: boolean;
};

export type KlipyGif = {
  id: number;
  original: Required<KlipyAsset>;
  preview: Required<KlipyAsset>;
  slug: string;
  title: string;
};

export type RelayGifSearchInfo = {
  gif_search?: {
    provider?: string;
  };
};

/** Whether a relay's public NIP-11 document advertises KLIPY proxy support. */
export function relayInfoSupportsKlipy(info: RelayGifSearchInfo): boolean {
  return info.gif_search?.provider === "klipy";
}

function isCompleteAsset(
  asset: KlipyAsset | undefined,
): asset is Required<KlipyAsset> {
  return (
    typeof asset?.url === "string" &&
    asset.url.length > 0 &&
    typeof asset.width === "number" &&
    typeof asset.height === "number" &&
    typeof asset.size === "number"
  );
}

function firstCompleteAsset(
  ...assets: Array<KlipyAsset | undefined>
): Required<KlipyAsset> | null {
  return assets.find(isCompleteAsset) ?? null;
}

/**
 * Normalize KLIPY's mixed media response to GIF-only results. The API can
 * interleave ad/content records without a file payload; those are intentionally
 * omitted until Buzz has an explicit third-party ad surface.
 */
export function normalizeKlipyGifs(items: KlipyRawGif[]): KlipyGif[] {
  const gifs: KlipyGif[] = [];

  for (const item of items) {
    if (item.type !== "gif" || !item.file || !item.slug) continue;

    const original = firstCompleteAsset(
      item.file.md?.gif,
      item.file.hd?.gif,
      item.file.sm?.gif,
      item.file.xs?.gif,
    );
    const preview = firstCompleteAsset(
      item.file.sm?.webp,
      item.file.sm?.gif,
      item.file.xs?.webp,
      item.file.xs?.gif,
      item.file.md?.webp,
      original ?? undefined,
    );
    if (!original || !preview) continue;

    gifs.push({
      id: item.id ?? gifs.length,
      original,
      preview,
      slug: item.slug,
      title: item.title?.trim() || "GIF",
    });
  }

  return gifs;
}

export function klipyGifFilename(gif: KlipyGif): string {
  const safeSlug = gif.slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safeSlug || "klipy-gif"}.gif`;
}

/**
 * Represent a selected KLIPY GIF as externally hosted media. The empty hash
 * intentionally distinguishes it from bytes uploaded to Buzz media storage;
 * NIP-92 permits URL-only media metadata.
 */
export function klipyGifAttachment(gif: KlipyGif): BlobDescriptor {
  return {
    dim: `${gif.original.width}x${gif.original.height}`,
    filename: klipyGifFilename(gif),
    sha256: "",
    size: gif.original.size,
    type: "image/gif",
    uploaded: 0,
    url: gif.original.url,
  };
}
