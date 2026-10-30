# Clara v1.3 — Controle financeiro pessoal, offline + sincronização opcional

Aplicativo de finanças pessoais em **HTML, CSS e JavaScript (ES Modules)**, responsivo e instalável como PWA. Compatível com uso **100% local** ou com **sincronização entre PC e Android via Supabase**, com login por e-mail e senha.

> **IMPORTANTE:** Esta entrega contém **todo o código e o SQL**, mas **não cria nem configura automaticamente um projeto Supabase ou um GitHub Pages em seu nome**. Para ativar a nuvem, crie o projeto e preencha as duas configurações públicas de `src/cloud-config.js`. Enquanto não fizer isso, tudo funciona em modo local como na v1.1.

## 1. Executar localmente

1. Extraia o ZIP; entre na pasta `controle-financeiro` (aquela que contém `index.html`).
2. Execute `python -m http.server 8000` (ou `python3 -m http.server 8000`).
3. Abra `http://localhost:8000` no navegador. **Não abra por `file://`**: ES Modules e PWA precisam de servidor.
4. Sem configurar Supabase, use normalmente lançamentos, origens, simulador, adiantamento, relatórios, backup e importação. Todas as gravações continuam no IndexedDB.

Node.js 20+ é **opcional** e só é necessário para `npm test`. Não há `npm install`, etapa de build, CDN nem dependências JavaScript externas.

## 2. Publicar no GitHub Pages

1. Crie um repositório no GitHub, por exemplo `clara-financeiro`.
2. Envie o **conteúdo** de `controle-financeiro` para a raiz do repositório. O arquivo `index.html` deve ficar na raiz e `src/`, `assets/`, `supabase/`, `styles.css`, etc., ao lado dele.
3. Em **Settings → Pages**, selecione **Deploy from a branch**, branch `main`, pasta `/ (root)`, depois **Save**.
4. Seu site ficará no endereço `https://SEU-USUARIO.github.io/clara-financeiro/` (substitua pelo endereço real publicado pelo GitHub).
5. Abra essa URL no Chrome Android; menu **⋮ → Instalar aplicativo/Adicionar à tela inicial**. O PWA usa HTTPS e armazena os arquivos da interface em cache. A instalação pode variar por navegador.
6. Atualizações: publique os arquivos na **mesma URL** e recarregue conectado. Preserve domínio/endereço, não limpe os dados do site e faça antes um backup JSON. **Se já configurou o Supabase no projeto publicado, preserve seu `src/cloud-config.js` existente ao atualizar**; o ZIP contém valores vazios de exemplo e sobrescrevê-lo desativaria o login na nova versão até reconfigurá-lo.

**GitHub Pages apenas publica HTML/CSS/JS: não é um banco de dados.** O repositório não deve conter seus lançamentos reais, senhas, tokens, backups ou `sb_secret_...`. A chave *publishable* do Supabase é pública por design; o isolamento dos dados depende das políticas RLS instaladas no banco.

## 3. Ativar sincronização: Supabase

### 3.1 Preparar banco e autenticação

1. Crie um projeto gratuito ou pago em https://supabase.com (os limites gratuitos podem mudar).
2. No Supabase Dashboard, abra **SQL Editor → New query** e execute o arquivo completo [`supabase/schema.sql`](supabase/schema.sql).
3. Confira que existe a tabela `public.finance_snapshots`, com **RLS habilitada** e políticas separadas para `SELECT`, `INSERT`, `UPDATE` restritas a `auth.uid() = user_id`. **Nunca desabilite o RLS para “consertar” um erro 403.**
4. Em **Authentication → Providers**, mantenha **Email** habilitado. Decida se exigirá confirmação por e-mail (recomendado).
5. Configure em **Authentication → URL Configuration** o **Site URL** como a URL HTTPS publicada do Clara. Inclua a URL em Redirect URLs se configurar futuramente fluxos de recuperação/links de redirecionamento. O Clara v1.3 usa login por senha; não implementa recuperação de senha na UI.
6. Em **Project Settings → API Keys** (ou **Connect**), copie a **Project URL** e a **publishable key** `sb_publishable_...` (ou chave pública legacy `anon`). **Nunca copie `service_role`, `sb_secret_...`, senha de banco, JWT secret nem token de usuário.**

### 3.2 Configuração do app

Abra [`src/cloud-config.js`](src/cloud-config.js) e altere apenas:

```javascript
export const SUPABASE_URL = 'https://SEU-PROJETO.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_SUA_CHAVE_PUBLICA';
```

As duas informações são públicas. O aplicativo executa requisições HTTPS diretamente ao Supabase usando **Auth REST** e **PostgREST**: sem SDK externo, servidor Node ou build. Depois, publique os arquivos atualizados no GitHub Pages.

Se o projeto não está configurado, a seção **Dados, backup e nuvem** indicará o que falta, e o aplicativo continuará local.

### 3.3 Primeira conexão — procedimento seguro

1. No dispositivo que já tem os lançamentos, faça **Dados e backup → Exportar JSON** e guarde o arquivo.
2. Entre em **Dados, backup e nuvem → Criar conta / Entrar**. Se for necessário, confirme primeiro o e-mail.
3. Na primeira conexão, o Clara **não envia nem apaga nada automaticamente**. Escolha **Enviar dados deste aparelho**. Se já havia dados remotos, **essa escolha substitui o conjunto remoto após confirmação**.
4. No outro dispositivo, abra a mesma URL, entre **na mesma conta** e escolha **Usar dados da nuvem aqui**. Essa escolha **substitui a cópia local** do segundo dispositivo após confirmação. Se essa cópia tiver dados importantes, exporte-os antes.
5. Daí em diante, novas alterações são salvas primeiro no IndexedDB e sincronizadas com a conta. Use **Sincronizar agora** para forçar a consulta; quando a página está visível, há também uma verificação periódica (aproximadamente 35 segundos, dependendo de navegador e rede).

**Não é sincronização em tempo real garantida.** Os aparelhos precisam obter conexão, ter o Clara aberto/ativo e estar autenticados. O indicador mostra se os dados estão sincronizados, pendentes ou em conflito.

### 3.4 Offline, edições simultâneas e conflitos

- O Clara continua utilizável **sem internet**, desde que a aplicação tenha sido carregada/armazenada. Salva tudo no **IndexedDB**. Pendências ficam implícitas na diferença entre o estado local e a última base sincronizada, ambas guardadas **na mesma transação**. Não há fila que possa sumir ao recarregar a página.
- Quando a internet volta, compara a **base comum**, o **estado local** e o **estado remoto**. Alterações em lançamentos diferentes podem ser mescladas automaticamente por ID, inclusive exclusões e adiantamentos independentes.
- Se ambos editarem o **mesmo lançamento/origem** de maneira diferente, ou se uma origem for apagada enquanto outro aparelho criar lançamentos vinculados a ela, o Clara **interrompe** a sincronização. Não elege um vencedor silenciosamente.
- A tela de conflito oferece **Usar versão da nuvem** ou **Enviar versão local**, cada uma **com confirmação**. Ambas substituem o conjunto completo do lado perdedor. **Exporte um backup JSON em ambos os dispositivos antes de escolher.** Não existe editor de merge manual na v1.3.
- Uma coluna `revision` no PostgreSQL implementa **compare-and-swap (CAS)**: uma versão desatualizada não sobrescreve uma versão mais nova sem detectar e reprocessar. Um trigger no SQL impede pular ou reduzir revisões.
- Se um upload concluir no Supabase mas a resposta de rede falhar, a próxima tentativa consulta a revisão remota antes de prosseguir, evitando lançamentos duplicados.
- A sincronização de **outro login** não ocorre automaticamente: trocar de usuário exige escolher como associar os dados locais. Em aparelho compartilhado, a cópia IndexedDB pode ser vista por outros usuários do navegador.
- Importar um JSON em uma conta pareada substitui a base **local** e aciona sincronização após salvar. Se o outro aparelho alterou registros nesse intervalo, a detecção de conflitos continua valendo.

### 3.5 Segurança

- SQL habilita **RLS** e restringe SELECT/INSERT/UPDATE à linha cujo `user_id` é o `auth.uid()` do token validado. `anon` não tem grants sobre a tabela; `DELETE` não é concedido à aplicação.
- A chave publicável **não autentica o usuário**; autenticação é pelo token da sessão. **Nunca** use service-role/secret key no front-end.
- Senha é transmitida ao Supabase Auth sobre HTTPS; não há campo de senha em banco local. Para manter login entre visitas, o navegador armazena **tokens de sessão rotativos em localStorage**. Eles são acessíveis ao JavaScript da própria origem e a quem tenha acesso ao perfil do navegador; não há criptografia ponta a ponta.
- HTTPS, PWA e RLS não substituem proteção do aparelho. O backup JSON e o IndexedDB **não são criptografados pelo Clara**. Sair da conta remove os tokens mas **não limpa a cópia local**: em dispositivo compartilhado, exporte backup e limpe os dados do site antes de entregar o aparelho.
- A tabela contém **1 snapshot JSON por usuário** (fontes, lançamentos, parcelas e adiantamentos). Essa opção facilita preservar a integridade do modelo existente; custo: a consulta periódica transfere apenas a revisão, mas quando há uma alteração sincronizada, a gravação ou mesclagem transmite o conjunto inteiro, não apenas a mudança. Para altos volumes ou vários usuários simultâneos editando a mesma conta, seria necessário migrar para linhas normalizadas e uma sincronização por operação. Limite SQL: 10 MB de JSON por snapshot; regras do app já limitam a 20.000 lançamentos.
- A segurança RLS **precisa ser testada em um Supabase de verdade**, com dois usuários diferentes: A não deve ler/escrever linha de B, e usuário anônimo não deve acessar nenhuma linha. Os testes JavaScript mockam HTTP e **não substituem esse teste de isolamento no PostgreSQL**.

## 4. Funcionalidades financeiras (herdadas da v1.1)

- **Visão geral:** receitas, despesas, saldo do mês, despesas fixas/variáveis, totais por origem, comparativo de seis meses e navegação mensal.
- **Origens:** criar/editar/excluir categorias de receitas e despesas; não é permitido apagar uma origem que tenha lançamentos.
- **Despesas:** Pix ou dinheiro à vista; cartão em até 120 parcelas, com valor total ou por parcela; despesas fixas com recorrência por 2–240 meses ou indeterminada; não é permitida recorrência fixa junto a um parcelamento múltiplo.
- **Receitas:** pontuais ou recorrentes, com origem configurável.
- **Listagem:** busca, filtros por tipo/origem/pagamento/período, edição e exclusão com confirmação. Editar ou excluir uma série afeta todas as ocorrências.
- **Simulador (v1.3):** duas opções no mesmo painel: **Nova despesa** (fixa, variável, cartão e 1/3/6 meses, sem descrição) e **Adiantar lançamento** (selecionar despesa e ocorrência/parcela existente, definir mês anterior e adicionar diversos adiantamentos hipotéticos a um cenário). **Nunca salva simulações.** O painel mostra despesas atuais, impacto positivo/negativo, despesas projetadas e saldo projetado por competência.
- **Adiantamento:** mover uma cobrança para um mês anterior, individualmente, incluindo uma parcela específica no cartão; ação reversível. Não divide o valor da parcela.
- **Backup JSON:** exporta o formato `financas-pessoais-local` com `schemaVersion: 1`; importação valida antes de substituir os registros, com confirmação. O formato financeiro é compatível com a v1.1 e seus backups.

Regras: valores monetários são inteiros em centavos; parcelas distribuem centavos residuais sem perda (R$ 100 em 3x = 33,34 + 33,33 + 33,33). A data da compra parcelada é o mês da **primeira parcela**, não uma automação de fechamento da fatura. O painel mostra previsões por competência, não saldo bancário conciliado.

### 4.1 Simular adiantamentos já existentes (novidade v1.3)

1. Abra **Simulador → Adiantar lançamento**. A opção **Nova despesa** continua disponível ao lado.
2. Escolha o **mês inicial da análise** e se deseja visualizar **1, 3 ou 6 meses**.
3. Selecione a **despesa cadastrada**, depois a **cobrança exata** (parcela 1/3, 2/3, 3/3; ou a competência de uma despesa fixa). São apresentadas cobranças dos **24 meses seguintes** ao mês inicial; cobranças do mês inicial não podem ser antecipadas para dentro da própria janela.
4. Escolha o **mês de destino**, obrigatoriamente **anterior ao vencimento efetivo** e dentro do período exibido. Clique em **Adicionar ao cenário**. Repita para combinar antecipações de cobranças diferentes.
5. Confira a coluna de impacto de cada mês: quando a cobrança vem de dentro da janela, há **acréscimo no mês de destino e retirada do mês original**. Se a origem estiver fora da janela, a interface avisa, pois aparecerá apenas o acréscimo na janela atual.
6. Clique em **Remover** em uma cobrança do cenário ou **Limpar todos** para desfazer o planejamento. Para realmente adiantar uma parcela, use **Adiantar** na listagem normal de lançamentos, fora do Simulador.

O plano hipotético existe **exclusivamente em memória**: não vai para IndexedDB, Supabase ou JSON, não modifica lançamentos reais, não adianta pagamentos bancários e é perdido ao recarregar a página. Alterar a janela preserva os passos planejados; se algum destino deixar de caber na janela, o aplicativo informa o problema e oferece remoção individual ou limpeza. Nenhuma etapa exige descrição adicional.

**Exemplo:** cartão R$ 300 em 3x (janeiro, fevereiro e março). Simular a antecipação da parcela 3/3 de março para fevereiro resulta em janeiro R$ 100, fevereiro R$ 200, março R$ 0; o lançamento real permanece em 3x até você antecipar fora do Simulador.

## 5. Testes

Node.js 20+ (sem `npm install`):

```bash
npm test
```

**91 testes automatizados aprovados na preparação da v1.3**, incluindo os 49 antigos e novos testes de: merge de três vias, cadastro em dispositivos diferentes, conflito de mesma entrada, exclusão, origem removida, adiantamentos concorrentes, compare-and-swap, autenticação mockada, renovação de token, respostas inválidas e indisponibilidade da rede, e 14 novos cenários de simulação de adiantamentos (múltiplas parcelas, recorrências, destinos fora da janela, validação e ausência de persistência).

O navegador automatizado disponível na geração da entrega **bloqueou a navegação por política administrativa** (inclusive localhost e recursos locais), portanto não foi possível concluir um smoke test real de cliques e responsividade. **Não houve implantação real em GitHub Pages nem conexão a banco Supabase real.**

Checklist de homologação após configurar Supabase:

1. PC: importar backup antigo, registrar uma despesa, entrar na conta, exportar JSON e **enviar dados locais**.
2. Android: entrar com a mesma conta, **usar nuvem**, confirmar que a despesa aparece.
3. Android offline: criar outra despesa, recarregar app, confirmar que o registro permanece; reconectar e sincronizar.
4. PC: sincronizar, confirmar que a despesa criada offline chegou sem duplicar.
5. PC e Android offline: editar o **mesmo lançamento** de formas diferentes; reconectar ambos e confirmar aviso de conflito, sem sobrescrita silenciosa. Exportar ambas as versões antes de resolver.
6. Testar origem/recorrência, cartão parcelado e adiantamento após sincronizar e reiniciar ambos aparelhos.
7. Supabase: criar contas A e B; inspecionar via API com tokens diferentes e confirmar isolamento RLS. Nunca teste acesso usando service-role, porque ele ignora RLS.
8. GitHub Pages: conferir instalação PWA, cache em modo avião, layout 360/390/768/1280 px, atualizações na mesma URL e login persistente após reabertura.

## 6. Estrutura do projeto

```text
controle-financeiro/
├── index.html                 # SPA, formulários financeiros e área de conta/nuvem
├── styles.css                 # CSS responsivo
├── src/
│   ├── app.js                 # UI, commits locais, fluxo de conta e sincronização
│   ├── core.js                # Regras puras, centavos, recorrências, parcelas e backups
│   ├── storage.js             # IndexedDB, snapshot e base de sync atômicos
│   ├── sync.js                # Comparação/merge de três vias e detecção de conflito
│   ├── cloud.js               # Cliente HTTP Auth + PostgREST; token refresh; CAS
│   └── cloud-config.js        # URL e chave pública do projeto (vazio por padrão)
├── supabase/
│   └── schema.sql             # Tabela, RLS, grants e trigger de revisão
├── tests/
│   ├── core.test.js
│   ├── advanced.test.js
│   ├── simulated-advances.test.js # Cenários somente em memória
│   ├── sync.test.js
│   └── cloud.test.js
├── assets/                    # Ícones SVG e PNG
├── manifest.webmanifest       # PWA
├── sw.js                      # Cache offline apenas do app, não dos dados da API
├── .nojekyll                  # Publicação estática GitHub Pages
├── package.json              # npm test / npm run serve
├── ARQUITETURA.md            # Decisões de engenharia, riscos e falhas
└── README.md
```

## 7. Arquitetura resumida

```text
                  GitHub Pages (arquivos estáticos HTTPS)
                        │                 │
                        ▼                 ▼
                     PC/PWA           Android/PWA
                       │                  │
                 IndexedDB PC      IndexedDB Android
                       │                  │
                       └──── HTTPS REST ──┘
                                │
                     Supabase Auth (e-mail)
                                │ token JWT
                PostgREST + PostgreSQL + RLS
                                │
                    finance_snapshots(user_id,
                        revision, payload)
```

O **salvamento local é obrigatório e imediato** antes de atualizar a tela. O **envio à nuvem é eventual**, falhas deixam os dados locais preservados e o indicador avisa. Ao convergir, dados financeiros, revisão remota e ancestral de comparação são salvos na mesma transação do IndexedDB. O banco remoto é separado por conta com RLS; não é um repositório público do GitHub.

## Clara 1.4 — Recuperação de senha e sessão

Em **Dados, backup e nuvem**, informe o e-mail e clique em **Esqueci minha senha**. O Supabase envia um link de recuperação (sujeito aos limites de envio de e-mail do projeto). Abra o link recebido: o Clara abre um formulário para definir e confirmar uma senha nova, com mínimo de 12 caracteres. Depois, faça login normalmente. Não compartilhe os links de recuperação, que contêm credenciais temporárias.

**Configuração obrigatória:** em Supabase → Authentication → URL Configuration, defina `Site URL` como `https://SEU_USUARIO.github.io/clara-financeiro/` e adicione este mesmo caminho a `Redirect URLs`. O Clara utiliza o fragmento `#access_token=...&type=recovery` do fluxo implícito; caso o projeto use um fluxo de recuperação PKCE (`?code=...`), essa variante exige integração adicional e não deve ser considerada suportada por esta build. O formulário remove imediatamente o token da barra de endereço e guarda-o somente em memória até a atualização da senha. Não é preciso executar outra migração SQL.

**Sessão:** o Clara armazena tokens de acesso/renovação no armazenamento local e tenta renovar o acesso automaticamente. No Supabase, a sessão não possui validade máxima por padrão, mas poderá terminar por logout, troca de senha, expiração/revogação do token de renovação, limpeza do navegador ou limites de sessão configurados pelo administrador. Nunca use aparelhos públicos para manter uma sessão pessoal. O projeto Free do Supabase pode ser pausado por inatividade e tem cotas de recursos; uma pausa interrompe a sincronização até o projeto ser retomado. Os lançamentos salvos localmente permanecem disponíveis no IndexedDB, sujeito à retenção do navegador. Continue exportando backups JSON.

**Importante ao publicar:** se `src/cloud-config.js` já estiver configurado no seu GitHub, preserve seus dois valores públicos ao substituir o projeto pelos arquivos desta versão; o ZIP é distribuído sem credenciais. A versão 1.4 corrige o contexto do `fetch` nativo para evitar erros de rede falsos em certos navegadores.


## Clara v1.5 — Favorecidos, quitações e origens independentes

**Antes da atualização:** exporte um backup JSON no Clara v1.4, sincronize os dispositivos e execute `supabase/migrate-v1.5.sql` no **SQL Editor do projeto Supabase**. Em seguida publique todos os arquivos da v1.5 no GitHub Pages. **Preserve o `src/cloud-config.js` preenchido do seu repositório**; o arquivo distribuído vem sem credenciais. Atualize todos os aparelhos para v1.5 antes de editar/sincronizar. A migração SQL permite dados v1 preexistentes e rejeita regravações que retornem um snapshot v2 para v1.

- **Favorecidos:** menu Favorecidos, cadastro independente com nome, tipo e observação; vínculo opcional a receitas e despesas; edição e exclusão segura (vínculos ficam vazios, lançamentos são preservados).
- **Origens:** menu Origens; crie e renomeie origens sem editar lançamentos; desative origens para impedir novos vínculos sem perder o histórico; para excluir origem em uso, escolha uma origem substituta do mesmo tipo e confirme a reclassificação de todos os lançamentos; origem sem vínculos pode ser excluída diretamente.
- **Contas a pagar:** em Lançamentos ou no painel Favorecidos, cada cobrança de despesa exibe Pendente, Parcial ou Paga; clique em Pagar para registrar valor e data em uma ocorrência específica; é possível quitar parcialmente, completar posteriormente ou desfazer a quitação da ocorrência. A mesma série pode conter meses pagos e pendentes. As parcelas são individualizadas pelo índice original, mesmo depois de adiantadas.
- **Importação e migração:** backups v1 e v2 são aceitos e validados. No v1, favorecidos e pagamentos são inicializados vazios. Depois da importação, o backup exportado será v2.
- **Simulador:** mantém o comportamento de despesa e adiantamentos hipotéticos; nenhum cenário interfere em pagamentos reais. O saldo previsto continua sendo receita prevista menos despesa prevista; pagamentos registrados não diminuem novamente o orçamento.

**Limitações explícitas:** não existe integração bancária nem pagamento real; Pagar registra uma confirmação manual. O aplicativo não oferece um extrato de caixa por data de pagamento. Se precisar ajustar o valor ou a estrutura da série, desfaça antes os pagamentos registrados para não mudar silenciosamente o valor já quitado. As ocorrências se repetem apenas até o limite da visualização e da recorrência configurados.

**Reverter:** o botão Desfazer pagamento apaga a quitação registrada para aquela ocorrência, inclusive um pagamento parcial acumulado. Faça backup antes de operações de manutenção.
