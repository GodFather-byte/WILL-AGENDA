import { MercadoPagoProvider } from "./mercadopago";
import type { PaymentProvider } from "./types";

export const PROVIDERS = { mercadopago: "Mercado Pago" } as const;
export type ProviderName = keyof typeof PROVIDERS;

export const isProvider = (name: string): name is ProviderName => name in PROVIDERS;

/** Constrói o provedor com a credencial já decifrada do estabelecimento. */
export function providerFor(name: string, credential: string): PaymentProvider {
  if (name === "mercadopago") return new MercadoPagoProvider(credential);
  throw new Error(`Provedor de pagamento desconhecido: ${name}`);
}
