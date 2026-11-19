# Margem

Biblioteca pessoal de PDFs com leitor de texto, OCR, imagens e destaques. O acervo aberto inclui trechos de três obras em domínio público e links para os textos completos na Wikisource.

## Executar

Requer Node.js 22.13+ na série 22 ou Node.js 24.

```sh
npm ci
npm run dev
```

Abra o endereço que o Vite imprimir no terminal, normalmente `http://localhost:5173`. A API roda na porta 3001. Em **Importar PDF**, crie uma conta e escolha o arquivo. O livro processado aparece na biblioteca.

Para executar o build com um único servidor:

```sh
npm run build
npm start
```

Abra `http://127.0.0.1:3001`. Defina `HOST` e `PORT` para mudar o endereço do servidor. Por padrão, o SQLite fica em `data/leitura.sqlite`. Para usar PostgreSQL localmente ou em outra hospedagem, passe a URL de conexão em `DATABASE_URL`. Em uma hospedagem própria com HTTPS, defina também `LEITURA_SECURE_COOKIES=1`.

## Publicar na Vercel

1. Importe `felipehaaglima/Leitura-app` em **New Project**. O `vercel.json` configura Vite, `npm run build`, a saída em `dist` e a função para `/api`.
2. Conecte um banco PostgreSQL ao ambiente **Production**. A integração **Neon** da Vercel já cria a variável `DATABASE_URL`. Se você já tiver um banco, cadastre a URL de conexão em **Settings → Environment Variables** com esse mesmo nome.
3. Publique novamente se a variável foi adicionada depois do primeiro deploy. Abra a URL do projeto, crie uma conta e teste a importação de um PDF.

O servidor cria as tabelas na primeira operação que precisa do banco. Na Vercel, os cookies de sessão usam HTTPS e os arquivos preparados para leitura são transferidos em partes. O SQLite do ambiente local é independente do banco de produção.

[Importar projeto na Vercel](https://vercel.com/new) · [Integração Neon](https://vercel.com/marketplace/neon/neon)

## Leitura e dados

- No celular, deslize para a esquerda para avançar e para a direita para voltar. Também é possível usar as setas do teclado. Toque no centro para abrir os controles. Páginas longas são divididas em partes como `1a`, `1b` e `1c`, ajustadas à tela.
- O botão Voltar do navegador ou do celular leva do leitor à biblioteca.
- No celular, pressione uma palavra para selecioná-la e arraste as alças para ampliar a seleção. Use o menu do Margem para destacar, consultar o Wikcionário ou abrir a tradução no Google Tradutor. Os links enviam o termo ou trecho selecionado ao serviço escolhido.
- O PDF é processado no navegador. O Tesseract reconhece texto em português e inglês em páginas digitalizadas ou com uma camada de texto ilegível. O arquivo original permanece no dispositivo e o servidor recebe o texto e as imagens preparados para o leitor. Para recuperar um livro afetado por caracteres ilegíveis em uma importação anterior, importe novamente o PDF original.
- A importação aceita PDFs de até 80 MB e 500 páginas. A recuperação de texto e figuras depende da qualidade do escaneamento e do layout. Páginas em que o OCR não encontra texto legível podem aparecer como imagem.
- PDFs importados, destaques e última página são salvos por conta. O progresso do acervo aberto e as preferências do leitor ficam no navegador.
- A porcentagem da importação fica visível na biblioteca depois de fechar a janela de importação. Com a aba aberta, o processamento segue em segundo plano. Ao voltar no mesmo navegador após fechar a aba ou recarregar a página, a importação retoma a partir do progresso salvo. O arquivo usado na retomada fica temporariamente no navegador e é removido ao concluir ou descartar a importação.
- Use **Ler páginas disponíveis** assim que a primeira página estiver pronta. As próximas aparecem no leitor conforme forem processadas. O progresso e os destaques dessa leitura são salvos no livro ao concluir a importação.
- Use a lixeira no cartão de um PDF para apagá-lo da biblioteca. A confirmação também remove o progresso e os destaques daquele livro.
- Selecione o texto e use **Destacar** para marcar com uma das três cores iniciais. Use **Outras cores** para escolher ou cadastrar mais cores. Toque no trecho já destacado para remover a marcação ou adicionar, editar e remover suas notas.

## Social

- Copie seu ID na aba **Social** e use o ID de outra pessoa para enviar um pedido de amizade. Após o aceite, vocês podem visitar os perfis e ver os livros e o progresso um do outro.
- No perfil de um amigo, solicite uma cópia de um livro. Quando o dono aprova, a cópia entra na sua biblioteca com o nome de quem compartilhou. Ela tem progresso e destaques próprios.
- No leitor de um livro compartilhado, toque no centro e abra **Leitura em grupo** para convidar quem tem uma cópia. Quem aceitar passa a ver a posição dos participantes e os destaques que eles escolherem compartilhar. No painel do destaque, escolha se ele aparece no grupo. Cada nota tem sua própria visibilidade. Em uma nota de grupo, selecione participantes para mencioná-los. A menção leva ao trecho pela aba **Social**.
