<div align="center">

# 🏮 Lantern

**Bancada de trabalho desktop para os modelos de IA que você já usa.**

Traga o seu próprio endpoint. Suas chaves ficam na sua máquina.

[![License: MIT](https://img.shields.io/badge/License-MIT-f5a623.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4f8cff.svg)](#instalação)
[![Sem telemetria](https://img.shields.io/badge/telemetria-nenhuma-52c98b.svg)](#privacidade)

[English](README.en.md) · [Português](README.md)

</div>

---

## O que é

Lantern é um aplicativo desktop open-source para conversar com modelos de linguagem e usar
arquivos do seu projeto como contexto — **sem conta, sem servidor de licença e sem telemetria**.

Você aponta o Lantern para o endpoint que quiser: uma API hospedada, um gateway corporativo, um
proxy ou um servidor local. Nada é pré-configurado, nada é importado de outras ferramentas
instaladas na máquina, e o aplicativo não faz nenhuma requisição por conta própria além das que
você dispara.

```text
┌──────────────────────────────────────────────┐
│  Lantern                                     │
│                                              │
│  provider  ──►  seu endpoint  ──►  modelo    │
│  chaves    ──►  cofre do SO (DPAPI/Keychain) │
│  arquivos  ──►  contexto explícito, com tick │
└──────────────────────────────────────────────┘
```

## Recursos

| | |
|---|---|
| **Bancada de tarefas** | Cada tarefa é um painel com a própria conversa, os próprios arquivos anexados e o próprio streaming; abra até quatro lado a lado, maximize a que está usando |
| **Paleta de comandos** | `Ctrl+K` cria tarefa, troca de provider, alterna o tema e pula entre tarefas sem tirar a mão do teclado |
| **Endpoint personalizável** | Qualquer serviço compatível com o formato *chat completions* da OpenAI, mais a API nativa de Messages da Anthropic e servidores locais (Ollama, LM Studio, llama.cpp, vLLM, …) |
| **Chaves locais** | Guardadas no arquivo de configuração do app e seladas com o cofre do sistema operacional quando disponível; nunca saem da máquina e nunca aparecem na interface depois de salvas |
| **Contexto sob controle** | Você escolhe a pasta de trabalho e marca exatamente quais arquivos entram na próxima mensagem; arquivos grandes são truncados com aviso |
| **Streaming** | Respostas aparecem conforme chegam, com botão de parar e cronômetro |
| **Zero rastreamento** | Sem login, sem licença, sem telemetria, sem "phone home". Desligue a rede e continue conversando com um modelo local |
| **Sem build step** | Interface em JavaScript puro, sem bundler: `npm start` roda direto do código-fonte |

## Instalação

### Windows — uma linha no PowerShell

```powershell
irm https://raw.githubusercontent.com/muriloramosoficial/lantern/main/scripts/install.ps1 | iex
```

Instala para o usuário atual (sem senha de administrador), cria atalho no menu Iniciar e adiciona a
pasta ao `PATH`. Para a versão portátil: adicione `-Portable`.

### Windows — instalador `.exe`

Baixe `Lantern-Setup-x.y.z.exe` em [Releases](https://github.com/muriloramosoficial/lantern/releases).
Escolha o diretório de instalação, ou use a versão `Portable` se preferir não instalar.

### npm — CLI multiplataforma

```bash
npm install -g lantern-desktop
lantern install     # baixa a release mais recente
lantern             # abre o aplicativo
lantern status      # mostra onde está instalado
lantern open ./meu-projeto   # abre já com a pasta de trabalho
```

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/muriloramosoficial/lantern/main/scripts/install.sh | bash
```

### Direto do código-fonte

```bash
git clone https://github.com/muriloramosoficial/lantern.git
cd lantern
npm install
npm start          # abre o aplicativo
npm test           # 27 testes do núcleo
npm run smoke      # sobe o app real escondido e confere 25 pontos de ponta a ponta
npm run verify     # checagem de sintaxe + testes
npm run dist       # gera o instalador .exe / AppImage / dmg
```

## Primeiros passos

1. Abra o **Settings** (ele abre sozinho na primeira execução) e clique em **New provider**.
2. Escolha o tipo de endpoint, ou clique num dos atalhos (OpenAI, OpenRouter, Groq, DeepSeek,
   Anthropic, Ollama, LM Studio, llama.cpp, vLLM…) e ajuste a URL base.
3. Informe o modelo e, se o serviço exigir, a chave de API.
4. Clique em **Test connection**. Se responder, salve.
5. Crie uma **tarefa** (`Ctrl+N` ou o botão **New**), escolha uma **pasta de trabalho**, marque os
   arquivos que servem de contexto e converse. Cada tarefa mantém o seu próprio histórico.

Detalhes de configuração por provedor estão em [docs/providers.md](docs/providers.md).

## Privacidade

- Nenhuma requisição é feita para servidores de terceiros além do endpoint **que você cadastrou**.
- Não existe verificação de licença, login, contador de uso ou telemetria.
- Chaves de API ficam no arquivo de configuração do próprio aplicativo
  (`%APPDATA%\Lantern\settings.json` no Windows, `~/.config/Lantern/settings.json` no Linux,
  `~/Library/Application Support/Lantern/settings.json` no macOS). Quando o cofre do sistema
  operacional está disponível, elas são cifradas com ele; a interface mostra qual modo está em uso.
- O aplicativo não varre a máquina procurando credenciais ou configurações de outras ferramentas de
  IA. Um provedor existe apenas depois que você o cria.

## Arquitetura

```text
src/main/       processo principal do Electron: janela, IPC, persistência
  providers.js    adaptadores HTTP (OpenAI-compatible, Anthropic, Ollama, custom)
  settings.js     store JSON atômico, validação, visão redigida dos provedores
  secrets.js      cofre local via safeStorage com fallback explícito em texto puro
  workspace.js    listagem de arquivos, leitura segura, montagem de contexto
src/preload/    ponte contextBridge — única superfície exposta à interface
src/renderer/   bancada em JS puro: rail, lista de tarefas, tiles, paleta (sem framework, sem bundler)
bin/            CLI do npm (instala e abre o aplicativo)
scripts/        install.ps1, install.sh, gerador de ícone, checagem de sintaxe
test/           testes de providers, settings e workspace (node --test)
```

Modelo de segurança: interface com `contextIsolation`, `sandbox` e `nodeIntegration` desligado;
CSP restritiva e nenhuma chamada de rede fora do processo principal. As chaves nunca cruzam a
ponte IPC — o renderer recebe apenas `hasKey: true/false`.

## Contribuindo

Issues e pull requests são bem-vindos. Leia [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir uma
mudança: os testes precisam passar (`npm run verify`) e novos comportamentos pedem testes novos.

Ideias que combinam com o projeto: novos adaptadores de endpoint, busca de arquivos por nome,
histórico de conversas salvo localmente, diffs aplicáveis a partir da resposta do modelo.

## Licença

MIT © 2026 MuriloRP — veja [LICENSE](LICENSE).
