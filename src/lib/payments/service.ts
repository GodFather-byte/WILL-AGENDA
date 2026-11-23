import type { SupabaseClient } from "@supabase/supabase-js";
import { accessKey, decryptCredential, paymentsConfigured } from "./crypto";
import { providerFor } from "./providers";
import { ProviderError, type PaymentProvider } from "./types";

// Orquestração do pagamento no servidor do app. Regras que valem aqui:
//   - nada disto roda com a cobrança desligada: sem credencial cadastrada, loadProvider devolve null;
//   - pagamento só é confirmado com o que a API do provedor responde (getPayment), nunca com o corpo
//     de um webhook nem com algo vindo do navegador;
//   - credencial e código de acesso nunca são escritos em log nem devolvidos em resposta.

type Session = { businessId: string; key: string; name: string; provider: PaymentProvider };

async function loadProvider(supabase: SupabaseClient, businessId: string): Promise<Session | null> {
  if (!paymentsConfigured()) return null;
  const key = accessKey(businessId);
  const { data, error } = await supabase.rpc("server_payment_credentials", { p_business_id: businessId, p_access_key: key });
  if (error || !data) return null;
  const { provider, ciphertext } = data as { provider: string; ciphertext: string };
  return { businessId, key, name: provider, provider: providerFor(provider, decryptCredential(businessId, ciphertext)) };
}

type PendingRefund = { id: string; provider_payment_id: string };

async function refund(supabase: SupabaseClient, session: Session, payment: PendingRefund) {
  let refundId: string | null = null;
  let ok = true;
  try {
    // A chave de idempotência é fixa por cobrança: repetir a chamada não estorna duas vezes.
    refundId = (await session.provider.refund(payment.provider_payment_id, `${payment.id}:estorno`)).refundId;
  } catch (error) {
    ok = false;
    console.error("estorno falhou", payment.id, (error as Error).message);
  }
  await supabase.rpc("server_refund_result", {
    p_business_id: session.businessId,
    p_access_key: session.key,
    p_payment_id: payment.id,
    p_ok: ok,
    p_refund_id: refundId,
  });
  return ok;
}

/** Confere uma cobrança na API do provedor e registra o resultado. Idempotente. */
async function check(supabase: SupabaseClient, session: Session, providerPaymentId: string) {
  const remote = await session.provider.getPayment(providerPaymentId);
  const { data, error } = await supabase.rpc("server_payment_result", {
    p_business_id: session.businessId,
    p_access_key: session.key,
    p_provider: session.name,
    p_provider_payment_id: providerPaymentId,
    p_status: remote.status,
    p_amount_cents: remote.amountCents,
  });
  if (error) throw new Error(error.message);
  const result = data as { state: string; payment_id?: string };
  // Pago depois de o agendamento cair ou ser cancelado: devolve na hora.
  if (result.state === "refund_pending" && result.payment_id) {
    await refund(supabase, session, { id: result.payment_id, provider_payment_id: providerPaymentId });
  }
  return result.state;
}

/** Estornos pendentes do estabelecimento (agendamento cancelado dentro da regra com sinal pago). */
export async function processRefunds(supabase: SupabaseClient, businessId: string) {
  const session = await loadProvider(supabase, businessId);
  if (!session) return { refunded: 0, failed: 0 };
  const { data } = await supabase.rpc("server_pending_refunds", { p_business_id: businessId, p_access_key: session.key });
  let refunded = 0;
  let failed = 0;
  for (const payment of (data ?? []) as PendingRefund[]) {
    if (await refund(supabase, session, payment)) refunded++;
    else failed++;
  }
  return { refunded, failed };
}

export type StartedPayment = { pix_code: string; ticket_url: string | null; amount_cents: number; expires_at: string };

/** Cria (ou devolve) a cobrança Pix do agendamento. Chamadas repetidas não geram cobranças novas. */
export async function startPayment(supabase: SupabaseClient, token: string, origin: string): Promise<StartedPayment> {
  const { data, error } = await supabase.rpc("payment_begin", { p_token: token });
  if (error) throw new PaymentError(error.code?.startsWith("AG") ? error.message : "Não foi possível iniciar o pagamento.", 409);
  const begin = data as {
    business_id: string;
    business_name: string;
    payment_id: string;
    provider: string;
    amount_cents: number;
    expires_at: string;
    pix_code: string | null;
    ticket_url: string | null;
    description: string;
    customer_name: string;
  };
  if (begin.pix_code) {
    return { pix_code: begin.pix_code, ticket_url: begin.ticket_url, amount_cents: begin.amount_cents, expires_at: begin.expires_at };
  }
  const session = await loadProvider(supabase, begin.business_id);
  if (!session) throw new PaymentError("A cobrança online não está disponível agora.", 503);
  let created;
  try {
    created = await session.provider.createPix({
      paymentId: begin.payment_id,
      amountCents: begin.amount_cents,
      description: `${begin.description} - ${begin.business_name}`,
      payerName: begin.customer_name,
      expiresAt: begin.expires_at,
      // O endereço do aviso vem da configuração do servidor quando existe, não do cabeçalho da requisição.
      notificationUrl: `${siteUrl(origin)}/api/webhooks/pagamento/${session.name}?b=${begin.business_id}`,
    });
  } catch (error) {
    console.error("criação da cobrança falhou", begin.payment_id, (error as Error).message);
    throw new PaymentError("O provedor de pagamento não respondeu. Tente de novo em instantes.", 502);
  }
  const { error: attachError } = await supabase.rpc("server_payment_attach", {
    p_business_id: begin.business_id,
    p_access_key: session.key,
    p_payment_id: begin.payment_id,
    p_provider_payment_id: created.providerPaymentId,
    p_pix_code: created.pixCode,
    p_ticket_url: created.ticketUrl,
  });
  if (attachError) {
    // Sem o identificador gravado o pagamento nunca seria reconhecido: não entrega o código ao cliente.
    // Tentar de novo é seguro, porque a criação no provedor é idempotente pela chave da cobrança.
    console.error("registro da cobrança falhou", begin.payment_id, attachError.message);
    throw new PaymentError("Não foi possível registrar a cobrança. Tente de novo em instantes.", 500);
  }
  return { pix_code: created.pixCode, ticket_url: created.ticketUrl, amount_cents: begin.amount_cents, expires_at: begin.expires_at };
}

/**
 * Chamado pela página do cliente enquanto espera: libera a reserva vencida, confere no provedor as
 * cobranças em aberto e faz os estornos pendentes deste agendamento. Não devolve nada sensível:
 * a página relê a situação pelo link secreto.
 */
export async function syncAppointment(supabase: SupabaseClient, token: string) {
  await supabase.rpc("release_hold", { p_token: token });
  const { data } = await supabase.rpc("payment_lookup", { p_token: token });
  const lookup = data as { business_id: string; payments: { id: string; status: string; provider_payment_id: string }[] } | null;
  if (!lookup || lookup.payments.length === 0) return;
  const session = await loadProvider(supabase, lookup.business_id);
  if (!session) return;
  for (const payment of lookup.payments) {
    try {
      if (payment.status === "pending") await check(supabase, session, payment.provider_payment_id);
      else if (payment.status === "refund_pending") await refund(supabase, session, payment);
    } catch (error) {
      console.error("conferência do pagamento falhou", payment.id, (error as Error).message);
    }
  }
}

/**
 * Aviso do provedor (webhook). O corpo só diz QUAL cobrança mudou; a situação é sempre buscada na
 * API do provedor com a credencial do estabelecimento.
 */
export async function handleNotification(supabase: SupabaseClient, businessId: string, providerName: string, providerPaymentId: string) {
  const session = await loadProvider(supabase, businessId);
  if (!session || session.name !== providerName) return "ignored";
  try {
    return await check(supabase, session, providerPaymentId);
  } catch (error) {
    // Cobrança que não existe na conta deste estabelecimento: aviso forjado ou de outra conta. Ignora.
    if (error instanceof ProviderError && error.status === 404) return "unknown";
    throw error;
  }
}

function siteUrl(origin: string) {
  const configured = process.env.SITE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!configured) return origin;
  return (configured.startsWith("http") ? configured : `https://${configured}`).replace(/\/+$/, "");
}

export class PaymentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
