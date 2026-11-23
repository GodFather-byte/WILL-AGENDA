// API simulada da Claude, só para os testes: valida as FERRAMENTAS do atendente e do copiloto
// contra o banco local, sem chave e sem custo. Não diz nada sobre a qualidade das respostas do
// modelo de verdade.
//
// Como o roteiro funciona: a mensagem do usuário no teste carrega uma instrução.
//   [[nome_da_ferramenta {"json": "dos argumentos"}]]  -> o "modelo" chama essa ferramenta
//   [[diga]] texto                                      -> o "modelo" responde esse texto
// Depois que a ferramenta roda, o "modelo" responde "RESULTADO " + o que a ferramenta devolveu.
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT ?? 4010);
const requests = [];

const lastUserText = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

function reply(body) {
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((block) => block.text).join("\n");
  const last = body.messages[body.messages.length - 1];
  const results = Array.isArray(last.content) ? last.content.filter((block) => block.type === "tool_result") : [];

  let content;
  if (results.length > 0) {
    const text = results
      .map((block) => (typeof block.content === "string" ? block.content : block.content.map((part) => part.text).join("")))
      .join("\n");
    content = [{ type: "text", text: `RESULTADO ${text}` }];
  } else if (system.includes("mensagem de WhatsApp")) {
    content = [{ type: "text", text: "Oi! Sentimos sua falta. Marque seu horário aqui: {link}" }];
  } else {
    const text = lastUserText(last);
    const tool = text.match(/\[\[(\w+)\s+(\{[\s\S]*\})\]\]/);
    const say = text.match(/\[\[diga\]\]\s*([\s\S]+)$/);
    if (tool && tool[1] !== "diga") {
      content = [{ type: "tool_use", id: `toolu_${Date.now()}`, name: tool[1], input: JSON.parse(tool[2]) }];
    } else {
      content = [{ type: "text", text: say ? say[1].trim() : "Certo." }];
    }
  }
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content,
    stop_reason: content[0].type === "tool_use" ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

createServer((request, response) => {
  const send = (status, payload) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  if (request.method === "GET" && request.url === "/_requests") return send(200, requests);
  if (request.method === "GET") return send(200, { ok: true });
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    try {
      const body = JSON.parse(raw);
      requests.push({ url: request.url, beta: request.headers["anthropic-beta"] ?? null, body });
      if (requests.length > 200) requests.shift();
      send(200, reply(body));
    } catch (error) {
      send(400, { type: "error", error: { type: "invalid_request_error", message: String(error) } });
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`API simulada da IA em http://127.0.0.1:${PORT}`));
