# Cadastro de Vencimentos

Aplicação para controle de vencimentos de documentos de segurança do trabalho, com cadastro de colaboradores, empresas, usuários, histórico de ações e geração de carteirinhas.

## Visão geral

O sistema permite:

- cadastrar colaboradores e documentos por empresa;
- acompanhar vencimentos de ASO, NR e outros treinamentos;
- visualizar alertas por prazo e status;
- gerenciar múltiplas empresas;
- controlar usuários e permissões;
- manter histórico de alterações e lixeira de registros;
- gerar carteirinhas com foto, logo e assinatura;
- publicar a aplicação em Cloudflare Workers com D1.

## Tecnologias

- HTML, CSS e JavaScript puro
- Cloudflare Workers
- Cloudflare D1
- Wrangler CLI

## Estrutura do projeto

```text
.
├── public/
│   ├── index.html
│   ├── sw.js
│   ├── app-c.js
│   ├── carteirinha-patch.js
│   ├── fix-excluir-empresa.js
│   ├── manifest.json
│   ├── icon-180.png
│   └── icon-512.png
├── lib/
│   └── auth.js
├── worker.js
├── wrangler.toml
├── README.md
└── .gitignore
```

## Requisitos

- Node.js 18+
- npm
- Wrangler CLI
- Conta no Cloudflare com acesso a Workers e D1

## Como executar localmente

1. Instale o Wrangler:

```bash
npm install -g wrangler
```

2. Faça login no Cloudflare:

```bash
wrangler login
```

3. Inicie o projeto localmente:

```bash
wrangler dev --local --port 8787
```

4. Abra no navegador:

```text
http://localhost:8787/
```

## Publicação no Cloudflare

Para publicar a aplicação:

```bash
wrangler deploy
```

Se o banco D1 ainda não existir:

```bash
wrangler d1 create cadastro-vencimentos-db
```

Em seguida, atualize o `database_id` no arquivo `wrangler.toml` e execute o deploy novamente.

## Configuração do Worker

O projeto usa `worker.js` como entrypoint e serve os arquivos estáticos em `public/` via `ASSETS`.

Arquivo principal: `worker.js`
Servidor estático: `public/`
Banco de dados: D1 via binding `DB`

## Funcionalidades principais

- login e autenticação de usuários;
- criação de empresas e usuários;
- edição de dados de colaboradores;
- controle de documentos por empresa;
- alertas de vencimento automáticos;
- histórico de ações e lixeira;
- importação e exportação de dados;
- geração de carteirinhas de treinamentos;
- upload de fotos e logo da empresa.

## Observações

- A aplicação foi desenvolvida para ambiente interno/organizacional.
- O banco D1 precisa estar configurado corretamente para o funcionamento do sistema.
- A autenticação e sessão são tratadas no backend do Worker.

## Licença

Este repositório não possui uma licença pública definida no projeto.
