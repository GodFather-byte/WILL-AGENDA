import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

// Credenciais de pagamento são do estabelecimento e nunca ficam legíveis fora do servidor do app:
//   - chegam do dono por uma rota autenticada, são cifradas aqui (AES-256-GCM) e só o texto cifrado
//     vai para o banco;
//   - a chave mestra (PAYMENTS_SECRET) existe só nas variáveis de ambiente do servidor;
//   - para pedir o texto cifrado de volta, o servidor apresenta ao banco uma chave de acesso derivada
//     por estabelecimento, da qual o banco guarda só o hash.

const VERSION = "v1";

function masterSecret() {
  const secret = process.env.PAYMENTS_SECRET ?? "";
  if (secret.length < 32) return null;
  return secret;
}

/** A instalação tem a chave mestra configurada? Sem ela, a cobrança online não pode ser ligada. */
export const paymentsConfigured = () => masterSecret() !== null;

function requireSecret() {
  const secret = masterSecret();
  if (!secret) throw new Error("PAYMENTS_SECRET não configurado.");
  return secret;
}

const encryptionKey = () => Buffer.from(hkdfSync("sha256", requireSecret(), "will-agenda", "credenciais-de-pagamento", 32));

/** Cifra a credencial. O identificador do estabelecimento entra como dado autenticado: o texto não serve para outro. */
export function encryptCredential(businessId: string, plaintext: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(businessId));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), data.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decryptCredential(businessId: string, ciphertext: string) {
  const [version, iv, data, tag] = ciphertext.split(".");
  if (version !== VERSION || !iv || !data || !tag) throw new Error("Credencial em formato desconhecido.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(businessId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/** Chave que o servidor apresenta ao banco para agir em nome de um estabelecimento. */
export const accessKey = (businessId: string) =>
  createHmac("sha256", requireSecret()).update(`acesso:${businessId}`).digest("hex");

/**
 * Prova de que a chamada vem do servidor do app. O banco só aceita cadastrar credencial com ela
 * (guarda o hash em server_keys), para o dono não conseguir gravar uma chave de acesso própria.
 */
export const serverProof = () => createHmac("sha256", requireSecret()).update("servidor:pagamentos").digest("hex");

/** Hash da prova, para semear em server_keys ao habilitar a cobrança na instalação. Não é segredo. */
export const serverProofHash = () => createHash("sha256").update(serverProof()).digest("hex");

/** O que o banco guarda da chave de acesso. */
export const accessHash = (businessId: string) => createHash("sha256").update(accessKey(businessId)).digest("hex");
