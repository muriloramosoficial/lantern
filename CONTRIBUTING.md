<div align="center">

# Contribuindo com o Lantern

</div>

Obrigado pelo interesse. O projeto é pequeno de propósito: sem bundler, sem framework de UI, sem
dependências de runtime. Se você mantiver esse espírito, o pull request entra fácil.

## Ambiente

```bash
git clone https://github.com/muriloramosoficial/lantern.git
cd lantern
npm install      # baixa o Electron; é a única dependência pesada
npm start        # abre o aplicativo
```

Requisitos: Node.js 20 ou superior.

## Antes de abrir um pull request

```bash
npm run verify   # checagem de sintaxe em todos os arquivos + testes
npm start        # confirme que a interface continua abrindo
```

Os testes usam `node:test` e não precisam de rede: os adaptadores de provedor rodam contra um
servidor HTTP local que simula as respostas em streaming.

## O que esperamos de um pull request

- **Escopo pequeno.** Uma mudança por PR, com uma frase dizendo o problema que ela resolve.
- **Testes para comportamento novo.** Regra de validação, parsing de stream, montagem de contexto ou
  qualquer coisa que possa quebrar em silêncio precisa de teste.
- **Nenhuma requisição nova para fora.** O Lantern só fala com o endpoint cadastrado pelo usuário.
  PRs que adicionem telemetria, checagem de licença, login obrigatório ou coleta de dados serão
  recusados — é a razão de existir do projeto.
- **Sem novas dependências de runtime.** Se algo precisa de uma biblioteca, primeiro abra uma issue
  explicando por quê. Electron e electron-builder são as únicas permitidas.
- **Pensamento em segurança.** Chaves de API nunca devem cruzar a ponte IPC nem aparecer em logs.
  Toda leitura de arquivo passa por `resolveInside` e fica dentro da pasta de trabalho escolhida.
- **Português ou inglês.** Comentários e documentação em qualquer um dos dois idiomas.

## Estrutura

```text
src/main/providers.js   adaptadores HTTP; funções puras sempre que possível
src/main/settings.js    store JSON; validação e visão redigida dos dados
src/main/secrets.js     cofre local (safeStorage) com fallback explícito
src/main/workspace.js   listagem, leitura segura e montagem de contexto
src/main/index.js       janela, IPC e ciclo de vida
src/preload/preload.js  superfície exposta à interface
src/renderer/           interface em JS puro
bin/lantern.js          CLI do npm
scripts/                instaladores, ícone e checagem de sintaxe
test/                   testes do núcleo
```

## Ideias bem-vindas

- Adaptadores para novos dialetos de endpoint (Google Gemini, Cohere, Bedrock).
- Busca de arquivos por nome na árvore de trabalho.
- Histórico de conversas salvo localmente, com exportação em Markdown.
- Aplicar diffs sugeridas pelo modelo direto nos arquivos, com confirmação.
- Assinatura de código nos instaladores e build automatizado por tag.

## Licença das contribuições

Ao enviar um pull request você concorda em licenciar o código sob a [licença MIT](LICENSE) do
projeto.

---

## Contributing (English summary)

Keep it small: no bundler, no UI framework, no runtime dependencies. Run `npm run verify` before
opening a PR, add tests for new behaviour, and never add telemetry, license checks or mandatory
sign-in — the app talks only to the endpoint the user configured. Contributions are licensed under
MIT. See the sections above for the full guidance.
