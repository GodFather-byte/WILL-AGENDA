// Gera o "Pix copia e cola" (BR Code estático) com o valor exato.
// Não confirma pagamento: serve para o cliente pagar o valor exato sem digitar nada.

const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

const ascii = (text: string, max: number) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim()
    .toUpperCase()
    .slice(0, max) || "ESTABELECIMENTO";

function crc16(payload: string) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

export function pixPayload(params: { key: string; amountCents: number; merchantName: string; txid: string }) {
  const account = field("00", "br.gov.bcb.pix") + field("01", params.key.trim());
  const txid = params.txid.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";
  const payload =
    field("00", "01") +
    field("26", account) +
    field("52", "0000") +
    field("53", "986") +
    field("54", (params.amountCents / 100).toFixed(2)) +
    field("58", "BR") +
    field("59", ascii(params.merchantName, 25)) +
    field("60", "BRASIL") +
    field("62", field("05", txid)) +
    "6304";
  return payload + crc16(payload);
}
