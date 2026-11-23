import { ProviderError, type CreatePixInput, type PaymentProvider, type ProviderPaymentStatus } from "./types";

// Mercado Pago, API de pagamentos (Pix). A credencial é o access token de produção do
// estabelecimento. MERCADOPAGO_API_URL existe só para os testes apontarem para o simulador.
//
// ATENÇÃO: este cliente foi exercitado contra um simulador local, nunca contra o Mercado Pago de
// verdade. Antes de ligar para um estabelecimento, valide com as credenciais de teste dele.

const baseUrl = () => (process.env.MERCADOPAGO_API_URL ?? "https://api.mercadopago.com").replace(/\/+$/, "");

const STATUS: Record<string, ProviderPaymentStatus> = {
  approved: "approved",
  pending: "pending",
  in_process: "pending",
  authorized: "pending",
  rejected: "failed",
  cancelled: "failed",
  refunded: "failed",
  charged_back: "failed",
};

export class MercadoPagoProvider implements PaymentProvider {
  constructor(private readonly accessToken: string) {}

  private async call(method: string, path: string, options: { body?: unknown; idempotencyKey?: string } = {}) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          ...(options.idempotencyKey ? { "X-Idempotency-Key": options.idempotencyKey } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ProviderError("Sem resposta do Mercado Pago.");
    }
    if (!response.ok) {
      // O corpo do erro não é propagado: pode repetir dados do pedido. Só o código HTTP.
      throw new ProviderError(`Mercado Pago respondeu ${response.status}.`, response.status);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async createPix(input: CreatePixInput) {
    const [firstName, ...rest] = input.payerName.trim().split(/\s+/);
    const data = await this.call("POST", "/v1/payments", {
      idempotencyKey: input.paymentId,
      body: {
        transaction_amount: input.amountCents / 100,
        description: input.description.slice(0, 200),
        payment_method_id: "pix",
        external_reference: input.paymentId,
        notification_url: input.notificationUrl,
        date_of_expiration: input.expiresAt,
        // O sistema guarda só nome e WhatsApp do cliente; o e-mail exigido pela API é um endereço
        // técnico por cobrança, que não recebe mensagens.
        payer: {
          email: `cobranca-${input.paymentId}@pagamentos.invalid`,
          first_name: firstName || "Cliente",
          last_name: rest.join(" ") || undefined,
        },
      },
    });
    const transaction = (data.point_of_interaction as { transaction_data?: { qr_code?: string; ticket_url?: string } } | undefined)
      ?.transaction_data;
    if (data.id === undefined || !transaction?.qr_code) throw new ProviderError("Mercado Pago não devolveu o código Pix.");
    return { providerPaymentId: String(data.id), pixCode: transaction.qr_code, ticketUrl: transaction.ticket_url ?? null };
  }

  async getPayment(providerPaymentId: string) {
    const data = await this.call("GET", `/v1/payments/${encodeURIComponent(providerPaymentId)}`);
    return {
      status: STATUS[String(data.status)] ?? "pending",
      amountCents: Math.round(Number(data.transaction_amount) * 100),
      reference: typeof data.external_reference === "string" ? data.external_reference : null,
    };
  }

  async refund(providerPaymentId: string, idempotencyKey: string) {
    const data = await this.call("POST", `/v1/payments/${encodeURIComponent(providerPaymentId)}/refunds`, {
      idempotencyKey,
      body: {},
    });
    return { refundId: String(data.id ?? "") };
  }
}
