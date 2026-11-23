// Camada independente de provedor. O resto do sistema só conhece esta interface; para trocar ou
// acrescentar um provedor, basta implementar estas três chamadas e registrar em providers.ts.

export type ProviderPaymentStatus = "pending" | "approved" | "failed";

export type CreatePixInput = {
  /** Identificador da cobrança no nosso banco: referência externa e chave de idempotência. */
  paymentId: string;
  amountCents: number;
  description: string;
  payerName: string;
  expiresAt: string;
  /** Endereço que o provedor chama quando a situação muda. */
  notificationUrl: string;
};

export type CreatedPix = { providerPaymentId: string; pixCode: string; ticketUrl: string | null };

export type ProviderPayment = {
  status: ProviderPaymentStatus;
  amountCents: number;
  /** A referência externa gravada na criação (o id da nossa cobrança). */
  reference: string | null;
};

export interface PaymentProvider {
  createPix(input: CreatePixInput): Promise<CreatedPix>;
  /** Situação consultada na API do provedor. É a única fonte aceita para confirmar pagamento. */
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  /** Estorno total. A chave de idempotência garante que repetir não estorna duas vezes. */
  refund(providerPaymentId: string, idempotencyKey: string): Promise<{ refundId: string }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
