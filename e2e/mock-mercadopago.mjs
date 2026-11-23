// Simulador do Mercado Pago, só para os testes: imita as três chamadas que o sistema usa
// (criar Pix, consultar pagamento, estornar) e registra tudo o que recebeu.
// Valida a LÓGICA do checkout; o Mercado Pago de verdade nunca foi chamado.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_MERCADOPAGO_PORT ?? 4020);
const TOKEN = process.env.MOCK_MERCADOPAGO_TOKEN ?? "TEST-credencial-simulada-do-estabelecimento-1234";

const payments = new Map(); // id -> pagamento
const byKey = new Map(); // chave de idempotência -> id
const refundsByKey = new Map();
const calls = [];
let sequence = 9000;

createServer((request, response) => {
  const send = (status, payload) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const url = new URL(request.url, "http://x");
    const body = raw ? JSON.parse(raw) : {};

    // Controles do teste (não existem no provedor de verdade).
    if (url.pathname === "/_state") {
      return send(200, { calls, payments: [...payments.values()] });
    }
    const approve = url.pathname.match(/^\/_approve\/(\d+)$/);
    if (approve) {
      const payment = payments.get(approve[1]);
      if (!payment) return send(404, {});
      payment.status = "approved";
      if (body.amount !== undefined) payment.transaction_amount = body.amount;
      return send(200, payment);
    }
    if (request.method === "GET" && url.pathname === "/") return send(200, { ok: true });

    const authorized = request.headers.authorization === `Bearer ${TOKEN}`;
    const key = request.headers["x-idempotency-key"] ?? null;
    calls.push({ method: request.method, path: url.pathname, authorized, key });
    if (!authorized) return send(401, { message: "unauthorized" });

    if (request.method === "POST" && url.pathname === "/v1/payments") {
      if (key && byKey.has(key)) return send(200, payments.get(byKey.get(key)));
      const id = String(++sequence);
      const payment = {
        id: Number(id),
        status: "pending",
        transaction_amount: body.transaction_amount,
        external_reference: body.external_reference,
        notification_url: body.notification_url,
        payer_email: body.payer?.email,
        refunds: 0,
        point_of_interaction: {
          transaction_data: { qr_code: `00020126SIMULADO${id}`, ticket_url: `http://127.0.0.1:${PORT}/ticket/${id}` },
        },
      };
      payments.set(id, payment);
      if (key) byKey.set(key, id);
      return send(201, payment);
    }
    const one = url.pathname.match(/^\/v1\/payments\/(\d+)$/);
    if (request.method === "GET" && one) {
      const payment = payments.get(one[1]);
      return payment ? send(200, payment) : send(404, { message: "not found" });
    }
    const refund = url.pathname.match(/^\/v1\/payments\/(\d+)\/refunds$/);
    if (request.method === "POST" && refund) {
      const payment = payments.get(refund[1]);
      if (!payment) return send(404, { message: "not found" });
      if (key && refundsByKey.has(key)) return send(200, { id: refundsByKey.get(key) });
      payment.status = "refunded";
      payment.refunds += 1;
      const id = ++sequence;
      if (key) refundsByKey.set(key, id);
      return send(201, { id });
    }
    return send(404, { message: "not found" });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`Simulador do Mercado Pago em http://127.0.0.1:${PORT}`));
