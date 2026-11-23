import type { CSSProperties } from "react";

/** Luminância relativa (WCAG) de uma cor #rrggbb. */
function luminance(hex: string) {
  const channel = (index: number) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Texto que se lê em cima da cor do estabelecimento: branco, ou quase preto se a cor for clara. */
export function readableOn(hex: string) {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return "#ffffff";
  const light = luminance(hex);
  // Contraste com branco = 1.05 / (L + 0.05); com o escuro (#1c1917, L≈0.01) = (L + 0.05) / 0.06.
  return 1.05 / (light + 0.05) >= (light + 0.05) / 0.06 ? "#ffffff" : "#1c1917";
}

/** Variáveis CSS com a marca do estabelecimento, para o elemento raiz da página dele. */
export function brandStyle(color: string): CSSProperties {
  return { "--brand": color, "--brand-fg": readableOn(color) } as CSSProperties;
}
