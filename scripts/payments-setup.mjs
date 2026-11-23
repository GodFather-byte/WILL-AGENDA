// Habilita a cobrança online numa instalação: imprime o comando SQL que registra no banco o hash
// da prova do servidor. O hash não é segredo; o PAYMENTS_SECRET nunca é impresso.
//
//   PAYMENTS_SECRET=... node scripts/payments-setup.mjs
//
// Rode o SQL impresso no SQL Editor do Supabase (uma vez por instalação, ou de novo se o
// PAYMENTS_SECRET mudar).
import { createHash, createHmac } from "node:crypto";

const secret = process.env.PAYMENTS_SECRET ?? "";
if (secret.length < 32) {
  console.error("Defina PAYMENTS_SECRET com 32 caracteres ou mais antes de rodar.");
  process.exit(1);
}
const proof = createHmac("sha256", secret).update("servidor:pagamentos").digest("hex");
const hash = createHash("sha256").update(proof).digest("hex");
console.log(
  `insert into public.server_keys (purpose, key_hash) values ('payments', '${hash}')\n` +
    `on conflict (purpose) do update set key_hash = excluded.key_hash, created_at = now();`,
);
