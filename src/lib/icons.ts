import type { Business } from "./types";

type Icon = { src: string; sizes: string; type: string; purpose?: "any" | "maskable" };

export const PLATFORM_ICONS: Icon[] = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

/** Ícones do app instalado: o logotipo do estabelecimento (512 e 192, enviados juntos) ou os da plataforma. */
export function businessIcons(business: Pick<Business, "logo_url">): Icon[] {
  if (!business.logo_url) return PLATFORM_ICONS;
  return [
    { src: business.logo_url.replace("/logo.png", "/logo-192.png"), sizes: "192x192", type: "image/png" },
    { src: business.logo_url, sizes: "512x512", type: "image/png" },
  ];
}
