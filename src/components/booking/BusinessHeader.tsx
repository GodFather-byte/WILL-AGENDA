/* eslint-disable @next/next/no-img-element -- logotipo vem do Storage já reduzido */

import Link from "next/link";
import type { Business } from "@/lib/types";

/** Cabeçalho com a marca do estabelecimento: é ele que o cliente vê, não a plataforma. */
export function BusinessHeader({
  business,
  children,
}: {
  business: Pick<Business, "slug" | "name" | "logo_url"> & { description?: string | null };
  children?: React.ReactNode;
}) {
  return (
    <header className="bg-brand text-brand-fg">
      <div className="mx-auto max-w-2xl px-4 py-6">
        <Link href={`/${business.slug}`} className="flex items-center gap-4">
          {business.logo_url && (
            <img
              src={business.logo_url}
              alt={`Logotipo de ${business.name}`}
              className="h-16 w-16 shrink-0 rounded-2xl bg-white object-contain shadow-sm"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-2xl font-bold leading-tight">{business.name}</p>
            {business.description && <p className="mt-1 text-sm opacity-90">{business.description}</p>}
          </div>
        </Link>
        {children}
      </div>
    </header>
  );
}
