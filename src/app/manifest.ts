import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";
import { PLATFORM_ICONS } from "@/lib/icons";

// Manifesto da plataforma: vale para quem ainda não criou o estabelecimento.
// Cada estabelecimento tem o próprio manifesto em /{slug}/manifest.webmanifest.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${BRAND.name} — Painel`,
    short_name: BRAND.shortName,
    description: BRAND.description,
    start_url: "/painel",
    display: "standalone",
    background_color: "#fafaf9",
    theme_color: BRAND.color,
    lang: "pt-BR",
    icons: PLATFORM_ICONS,
  };
}
