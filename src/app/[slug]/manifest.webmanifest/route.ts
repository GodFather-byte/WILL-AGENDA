import { NextResponse } from "next/server";
import { fetchBusinessBySlug } from "@/lib/data";
import { businessIcons } from "@/lib/icons";
import { createPublicClient } from "@/lib/supabase/public";

// Manifesto por estabelecimento: o cliente instala "o salão" na tela inicial, não a plataforma.
export async function GET(_request: Request, { params }: RouteContext<"/[slug]/manifest.webmanifest">) {
  const { slug } = await params;
  const business = await fetchBusinessBySlug(createPublicClient(), slug);
  if (!business) return NextResponse.json({ error: "Estabelecimento não encontrado." }, { status: 404 });
  return NextResponse.json(
    {
      name: business.name,
      short_name: business.name.slice(0, 12),
      description: business.description ?? `Agende seu horário em ${business.name}`,
      start_url: `/${business.slug}`,
      scope: `/${business.slug}`,
      display: "standalone",
      background_color: "#fafaf9",
      theme_color: business.primary_color,
      lang: "pt-BR",
      icons: businessIcons(business),
    },
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}
