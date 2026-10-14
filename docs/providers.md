<div align="center">

# Configurando provedores

</div>

Lantern não vem com nenhum provedor. Você cria exatamente os que quiser, e cada um aponta para uma
URL que você digitou. Nada é lido de outras ferramentas instaladas na máquina.

## Tipos de endpoint

| Tipo | Quando usar | Autenticação |
|---|---|---|
| **OpenAI-compatible** | Qualquer serviço que fale `POST /chat/completions` | `Authorization: Bearer <chave>` |
| **Anthropic** | API nativa de Messages da Anthropic | `x-api-key: <chave>` + `anthropic-version: 2023-06-01` |
| **Ollama / servidor local** | Ollama, LM Studio, llama.cpp, vLLM e similares | opcional |
| **Custom endpoint** | Gateway próprio ou serviço exótico | opcional, cabeçalhos livres |

Os dois últimos usam o mesmo formato de requisição do OpenAI-compatible; a diferença é só que a
chave de API não é obrigatória.

## Exemplos prontos

### OpenAI

- Tipo: `OpenAI-compatible`
- Base URL: `https://api.openai.com/v1`
- Path: `/chat/completions`
- Modelo: `gpt-4o-mini` (ou qualquer modelo da sua conta)
- Chave: `sk-...`

### OpenRouter

- Base URL: `https://openrouter.ai/api/v1`
- Modelo: `anthropic/claude-sonnet-4.5`, `google/gemini-2.0-flash-001`, …
- Cabeçalhos extras opcionais:

```json
{ "HTTP-Referer": "https://github.com/muriloramosoficial/lantern", "X-Title": "Lantern" }
```

### Groq

- Base URL: `https://api.groq.com/openai/v1`
- Modelo: `llama-3.3-70b-versatile`, …

### DeepSeek

- Base URL: `https://api.deepseek.com/v1`
- Modelo: `deepseek-chat` ou `deepseek-reasoner`

### Anthropic

- Tipo: `Anthropic`
- Base URL: `https://api.anthropic.com/v1`
- Path: `/messages`
- Modelo: `claude-sonnet-4-5`
- Temperatura e `max_tokens` são enviados no formato nativo da API

### Ollama (local)

```bash
ollama serve
ollama pull qwen2.5-coder:7b
```

- Tipo: `Ollama / servidor local`
- Base URL: `http://127.0.0.1:11434/v1`
- Modelo: `qwen2.5-coder:7b`
- Chave: deixe vazio

### LM Studio (local)

Ative o servidor local em *Developer → Start Server* e use:

- Base URL: `http://127.0.0.1:1234/v1`
- Modelo: o identificador mostrado no LM Studio

### llama.cpp / vLLM (local)

```bash
# llama.cpp
llama-server -m modelo.gguf --port 8080

# vLLM
vllm serve Qwen/Qwen2.5-Coder-7B-Instruct --port 8000
```

- Base URL: `http://127.0.0.1:8080/v1` ou `http://127.0.0.1:8000/v1`

### Gateway corporativo

Se a sua empresa expõe um proxy compatível com OpenAI:

- Base URL: `https://ia.interno.example.com/v1`
- Cabeçalhos extras: o que o gateway exigir, por exemplo `{ "X-Team": "engenharia" }`

## Cabeçalhos extras

O campo **Extra headers** aceita um objeto JSON de strings, enviado junto com cada requisição:

```json
{
  "HTTP-Referer": "https://example.com",
  "X-Request-Source": "lantern"
}
```

Cabeçalhos obrigatórios de cada tipo (como `anthropic-version`) já são aplicados automaticamente e
não precisam ser repetidos.

## Descobrir os modelos

Com o provedor salvo, clique em **list** ao lado do campo de modelo: o Lantern consulta
`GET {baseUrl}/models` e preenche a lista enquanto você digita. Nem todo serviço implementa esse
endpoint — nesse caso digite o nome do modelo manualmente.

## Onde as chaves ficam

- O valor é guardado no `settings.json` do aplicativo, no `userData` do próprio Lantern.
- Se o cofre do sistema operacional estiver disponível (DPAPI no Windows, Keychain no macOS,
  libsecret no Linux), a chave é cifrada por ele. O rodapé da janela mostra qual modo está ativo.
- Sem cofre, a chave é gravada em texto puro no arquivo e a interface avisa.
- A chave nunca é enviada para a interface: o renderer só recebe `hasKey: true/false`.
- A única requisição que carrega a chave é a que vai para o endpoint que você cadastrou.

## Solução de problemas

| Sintoma | Causa provável |
|---|---|
| `HTTP 401` no teste | Chave ausente, inválida ou de outro serviço |
| `HTTP 404` | Base URL sem `/v1` ou path errado para o tipo escolhido |
| `HTTP 429` | Limite de uso do provedor; tente de novo ou troque de modelo |
| `fetch failed` / `ECONNREFUSED` | Servidor local desligado ou porta diferente |
| Resposta vazia | Modelo exige `max_tokens` maior, ou o serviço não suporta `stream_options` |
| Certificado inválido | Proxy corporativo com CA própria: use `NODE_EXTRA_CA_CERTS` ao iniciar |

Se o provedor não aceitar `stream_options`, desmarque **stream responses** no formulário — o Lantern
passa a pedir a resposta completa de uma vez.
