import { NextResponse } from "next/server";
import { fetchBusinessBySlug } from "@/lib/data";
import { businessIcons } from "@/lib/icons";
import { createPublicClient } from "@/lib/supabase/public";

// Manifesto do painel: o dono instala a agenda com o nome e o logotipo do estabelecimento.
export async function GET(_request: Request, { params }: RouteContext<"/[slug]/painel.webmanifest">) {
  const { slug } = await params;
  const business = await fetchBusinessBySlug(createPublicClient(), slug);
  if (!business) return NextResponse.json({ error: "Estabelecimento não encontrado." }, { status: 404 });
  return NextResponse.json(
    {
      name: `${business.name} — agenda`,
      short_name: business.name.slice(0, 12),
      start_url: "/painel",
      scope: "/painel",
      display: "standalone",
      background_color: "#fafaf9",
      theme_color: business.primary_color,
      lang: "pt-BR",
      icons: businessIcons(business),
    },
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}
