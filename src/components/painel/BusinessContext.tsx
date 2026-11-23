"use client";

import { createContext, useContext } from "react";
import type { Business, Catalog } from "@/lib/types";

type BusinessContextValue = {
  business: Business;
  catalog: Catalog;
  /** Hoje em São Paulo, calculado no servidor quando o painel abriu. */
  today: string;
  setBusiness: (business: Business) => void;
  /** Recarrega serviços, profissionais e expediente depois de uma alteração. */
  reload: () => Promise<void>;
};

export const BusinessContext = createContext<BusinessContextValue | null>(null);

export function useBusiness() {
  const value = useContext(BusinessContext);
  if (!value) throw new Error("useBusiness fora do painel");
  return value;
}

/** Evento que as telas do painel escutam para recarregar (disparado pelo copiloto, por exemplo). */
export const DATA_CHANGED = "wag:data-changed";
