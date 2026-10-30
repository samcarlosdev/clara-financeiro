# Clara v1.3 — Decisões de arquitetura e riscos

## Requisitos e restrições

- Mesmo aplicativo estático no GitHub Pages, sem servidor próprio e sem etapa de compilação.
- Uso local obrigatório; conexão Supabase opcional por e-mail e senha.
- Preservar o esquema financeiro v1.1 (`schemaVersion=1`), os backups e os cálculos de parcelas/adiantamentos.
- Alterações offline persistidas antes de confirmação na UI.
- Nunca resolver edições incompatíveis com “último a salvar vence”.

## Por que snapshot JSON e não uma tabela por parcela?

O Clara não armazena parcelas individualmente: uma compra guarda total, número de parcelas, mês inicial e adiantamentos por índice original; os meses são **projeções calculadas**. Um banco de parcelas normalizado exigiria preservar regras derivadas e sincronizar exclusões/recorrências mutáveis em várias tabelas. Para um único usuário com dois ou poucos dispositivos, um snapshot por conta reduz o risco de gravar uma série parcial.

- **Prós:** mantém as operações transacionais existentes, uma leitura e uma escrita versionada, backup simples, RLS objetiva.
- **Contras:** gravações enviam JSON completo, duas edições sobre o mesmo registro podem bloquear a sincronização, não há consultas analíticas SQL por parcela.
- **Futuro:** para vários usuários trabalhando simultaneamente ou histórico grande, migrar para `entries`, `sources`, `operations`, tombstones e cursores incrementais, com servidor de resolução de conflitos.

## Fluxo de gravação e estados

```text
formulário
  │ validar regras financeiras (`validateState`)
  ▼
commit na transação IndexedDB
  │    [revision local, data local, sync {userId, base, remoteRevision}]
  ├── falha → UI não assume alteração e exibe erro
  └── sucesso → atualiza UI e agenda sincronização
                                  │
             se deslogado → somente local
             se offline   → estado local permanece
             se pareado   → consulta `revision` remoto
                                  │
                nenhum lado mudou → sincronizado
                só local mudou → PATCH com CAS
                só remoto mudou → baixa e aplica
                ambos mudaram  → merge por ID
                                  │
                   conflito → pausa sem sobrescrever
                   sem conflito → CAS + commit local
```

A operação de sincronização e os commits estão **serializados** na mesma fila para evitar uma resposta atrasada da rede sobrescrever um estado editado simultaneamente na UI. Consequência operacional: uma requisição lenta pode atrasar temporariamente a conclusão de uma edição iniciada durante a sync (timeout HTTP de 12 segundos). Esta é uma limitação conhecida da v1.2, não um comportamento de sincronização em tempo real.

## Ancestral e conflitos

`sync.base`: último estado que foi confirmado como comum aos dois lados. `sync.remoteRevision`: revisão do banco para aquela base. As duas coisas são persistidas com a cópia financeira em **uma única transação**.

Comparação por `id` estável em cada coleção:

- Se só um lado mudou um registro em relação à base, usar esse lado.
- Se os dois lados mudaram o mesmo registro para o mesmo conteúdo, aceitar.
- Se alteraram o mesmo registro de formas distintas (incluindo excluir × editar), interromper.
- Se um registro foi excluído e a outra ponta não o mudou, a exclusão prevalece.
- Depois do merge, executar `validateState`. Caso crie dependência inválida (origem removida enquanto surge uma despesa associada), interromper.

Não há merge campo-a-campo do mesmo lançamento: ele poderia juntar mudanças aparentemente independentes que invalidam a programação de parcelas ou adiantamentos. Melhor exigir revisão humana.

## Compare-and-swap remoto

- Primeiro snapshot: `INSERT ... ON CONFLICT DO NOTHING` (sem sobrescrever outro dispositivo).
- Atualizações: `PATCH WHERE user_id = <uid> AND revision = <revisão lida>` com `revision = antiga + 1`.
- Zero linhas atualizadas significa versão obsoleta: buscar novamente e recalcular o plano. Até quatro tentativas.
- Trigger PostgreSQL proíbe mudar `user_id` ou incrementar `revision` por valores diferentes de 1.
- Caso upload tenha sido gravado e o retorno falhe, a próxima sync busca a revisão corrente e pode reconhecer o estado remoto como igual à alteração local; assim não cria transação duplicada.

## Modelo de segurança

- Front-end hospedado em HTTPS (GitHub Pages).
- Supabase Auth autentica cada login; PostgREST valida `Authorization: Bearer <access_token>`.
- Chave `sb_publishable_...` identificadora de aplicativo é pública. Não concede acesso a outros usuários sem token e política RLS.
- `finance_snapshots` tem RLS obrigatória: `user_id = auth.uid()` em SELECT, INSERT e UPDATE; não concede DELETE nem acesso `anon`.
- Refresh token fica em `localStorage`, sessão rotativa, e é excluído no logout local. Exposição potencial por XSS/comprometimento do navegador. O Clara usa `textContent` para dados do usuário, mas **não substitui uma auditoria de segurança formal**.
- IndexedDB e backups JSON não são criptografados ponta a ponta; Supabase consegue tecnicamente acessar o conteúdo da coluna JSON. Não guardar senhas bancárias ou outros segredos em descrições.
- Uma conta conectada não restringe o acesso à cópia local pré-existente. Sair não limpa IndexedDB; uso em dispositivos compartilhados requer limpar os dados do site depois do backup.
- Não colocar finanças ou tokens no repositório GitHub. Ninguém precisa de arquivos JSON reais para implantar o app.

## Migração e idempotência

- Backups v1.1 preservam o esquema 1; `advances` ausente vira array vazio por `validateState`.
- IndexedDB v1: registros antigos sem `sync` continuam válidos (`syncMeta=null`). Não precisa apagar o banco.
- Usuário faz exportação antes de conectar; nenhuma migração remota acontece em segundo plano sem escolha.
- `supabase/schema.sql` usa `IF NOT EXISTS` para tabela e recriação controlada de policies/trigger sem apagar dados. Executar primeiro em projeto de teste.
- PWA: nova versão do service-worker usa cache `clara-shell-v5`, com módulos `sync.js`, `cloud.js`, `cloud-config.js`.

## Falhas conhecidas / aceitação

| Falha | Comportamento esperado |
|---|---|
| Celular perde internet após editar | Commit IndexedDB permanece; sync pendente |
| Fechar/reabrir após editar offline | Dados e ancestral recuperados do IndexedDB |
| Timeout depois do Supabase gravar | Releitura e convergência por revisão + ID |
| Dois dispositivos mudam registros diferentes | Merge automático com validação |
| Dois dispositivos mudam a mesma parcela | Conflito, sem escolha automática |
| Outra aba mexe no IndexedDB | CAS de revisão local rejeita sobrescrita |
| Não existe tabela SQL / RLS errada | Status erro/pendente; estado local intacto |
| Conta nova em dispositivo com dados | Exige escolher envio ou substituição |
| Importação de JSON antigo | Validação antes de salvar; sinc posterior segue CAS |
| Logout | Remove sessão, mantém cache financeiro local |

## Não implementado nesta versão

Recuperação de senha via interface, 2FA específico no app, notificação push, colaboração entre usuários, banco financeiro externo, criptografia ponta a ponta, fechamento de cartão por dia, pagamentos parciais de adiantamento, merge visual por campo, sincronização em tempo real de baixa latência ou hospedagem já provisionada. O SDK Supabase oficial não é usado: integração HTTP é pequena e auditável, porém exige manter os endpoints REST compatíveis em futuras atualizações.

## Simulador de adiantamento — v1.3

A simulação é **um overlay efêmero de ocorrências sobre o snapshot financeiro já validado**, não um comando persistido. `simulateAdvances(state, plan, fromMonth, months)` valida o plano, deriva o mês efetivo atual (considerando adiantamentos reais), aplica `advanceOccurrence` em cópias de objetos e calcula `monthSummary` da base e do cenário para cada competência. Cada alteração é identificada por `(entryId, occurrenceIndex)`; indices representam a ocorrência *original*, não a posição no mês, portanto o cenário suporta várias parcelas no mesmo mês e séries fixas sem duplicar.

- O plano existe somente em variável JavaScript no `app.js`. Não é passado a `commit`, `saveState`, `requestCloudSync` ou `exportSnapshot`.
- Destino estritamente anterior à competência **efetiva** atual; para uma cobrança já antecipada de março para fevereiro, novo cenário só pode mover para janeiro ou antes, nunca voltar a março.
- Destino precisa pertencer a janela de 1, 3 ou 6 meses. A escolha de cobranças permite procurar até 24 competências futuras. Cobranças do mês inicial não aparecem porque não podem ser adiantadas para mês anterior *dentro* da janela escolhida.
- Vários adiantamentos diferentes podem ser simulados, com remoção individual; a mesma ocorrência não pode ser adicionada duas vezes no mesmo plano.
- O comparativo calcula `expenseChange` por competência, positivo no destino e negativo na origem quando ambas constam da janela. Valores das parcelas são os mesmos centavos da regra real, sem recalcular ou criar lançamento.
- Mudança de horizonte pode invalidar o destino de um passo; o erro é exibido e cada passo continua disponível para remoção, sem alteração silenciosa da intenção do usuário.
- Nenhuma migração IndexedDB/Supabase nem SQL adicional: o esquema financeiro e formato JSON continuam `schemaVersion = 1`. Atualização PWA muda somente o identificador do cache estático.

**Limites:** o planejamento é previsional, não efetua pagamentos no cartão nem contabiliza juros/descontos por antecipação. Os testes unitários são executáveis sem build; a interface precisa de verificação manual em GitHub Pages/Android porque a política do navegador automatizado neste ambiente bloqueia navegação.


## v1.5 — migração de esquema e consistência

O esquema de snapshot passa de `schemaVersion:1` para `schemaVersion:2`. `validateState` migra v1 em memória sem alterar origens/lançamentos. A atualização do Supabase (`supabase/migrate-v1.5.sql`) deve ser executada antes da aplicação nova; um trigger impede downgrade de payload de 2 para 1, protegendo campos que versões antigas desconhecem.

`payees[]` tem identidades imutáveis e é incluído no merge de três vias. Cada `entry` pode ter `payeeId` opcional e `settlements[]` contendo `{index, paidCents, paidAt}`; `index` é o índice original da recorrência/parcela, não o mês movido por antecipação. A quitação é cumulativa dentro de uma ocorrência; pagamentos parciais são representados pelo agregado (não é um ledger imutável de pagamentos). Alterações simultâneas na mesma entry geram conflito. O total de orçamento não é reduzido ao registrar uma quitação.

A exclusão de origem com dependentes é transacional: reclassifica os lançamentos para outra origem válida do mesmo tipo na mesma atualização atômica do snapshot. Remover favorecido desvincula lançamentos antes de apagar o cadastro. A UI nunca deleta uma cobrança para marcar como paga. Todos os estados persistem em IndexedDB e entram em backup/sync.
