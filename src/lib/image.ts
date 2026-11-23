import type { SupabaseClient } from "@supabase/supabase-js";

// Imagens do celular chegam com vários MB: reduzimos no aparelho antes de enviar ao Storage (bucket "marcas").

const BUCKET = "marcas";

async function decode(source: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(source, { imageOrientation: "from-image" });
    } catch {
      // Formato que o createImageBitmap não abre: tenta pela tag <img>.
    }
  }
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Reduz a imagem para caber em `size` px. Com `square`, centraliza num quadrado de fundo branco
 * (ícone do app).
 */
export async function resizeImage(
  source: Blob,
  { size, square = false, type = "image/jpeg" }: { size: number; square?: boolean; type?: "image/jpeg" | "image/png" },
): Promise<Blob> {
  const image = await decode(source);
  const scale = Math.min(1, size / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = square ? size : width;
  canvas.height = square ? size : height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível preparar a imagem.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Não foi possível preparar a imagem."))), type, 0.85),
  );
}

/** Envia para marcas/{businessId}/{path} e devolve o endereço público (com carimbo para furar o cache ao trocar). */
export async function uploadBrandImage(supabase: SupabaseClient, businessId: string, path: string, blob: Blob) {
  const full = `${businessId}/${path}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(full, blob, { upsert: true, contentType: blob.type, cacheControl: "31536000" });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(full);
  return `${data.publicUrl}?v=${Date.now()}`;
}
