# api_workbenchs_runtimes

Benchmark de duas runtimes JavaScript, **Node.js** e **Bun**, como servidor de uma API HTTP que recebe `POST /produtos`, valida o JSON e responde `201`.

| Cenário | O que a API faz |
|---|---|
| **A** | desserializa e valida o payload (sem banco) |
| **B** | o mesmo, e grava o payload em uma coluna JSONB do PostgreSQL |

No cenário B há três variantes de servidor: Node com o driver `pg`, Bun com `Bun.sql` e `bunpg` (Bun com o driver `pg`), que separa o efeito do driver do efeito do runtime.

Payloads: `pequeno` (~2 KB), `medio` (~64 KB) e `grande` (~1 MB). A carga é gerada pelo k6 e a CPU e a memória do contêiner da API, do k6 e do Postgres são coletadas com `docker stats`.

A matriz completa tem 15 rodadas: o cenário A (2 runtimes × 3 payloads) e o cenário B (3 variantes × 3 payloads).

## Como rodar

**Requisitos:** Docker com Compose v2 (Docker Desktop no Windows ou macOS) e Node.js 18 ou superior. O Node do host só executa o runner e o monitor; as APIs rodam em contêineres.

```bash
git clone <url-do-repositorio>
cd <repositorio>/api_workbenchs_runtimes

node scripts/rodar_matriz.js --smoke
node scripts/rodar_matriz.js --dry-run
node scripts/rodar_matriz.js
```

1. `--smoke` confere se as 5 APIs sobem e respondem 201.
2. `--dry-run` mostra o plano sem executar.
3. A terceira linha roda a matriz completa uma vez (cerca de 1 h 30 min).

Não é preciso criar `.env`: todos os parâmetros têm valor padrão. Para customizar (senha do banco, portas, versões, memória da API), copie `.env.example` para `.env`.

Os resultados vão para `resultados/run-<hostname>-<data>/`, uma pasta nova a cada execução.

### Opções do runner

```
--scenarios A,B                   cenários (padrão: A,B)
--payloads pequeno,medio,grande   payloads (padrão: todos)
--runtimes node,bun,bunpg         runtimes (padrão: todos; bunpg só no cenário B)
--shuffle                         sorteia a ordem dos runtimes dentro de cada bloco cenário × payload
--vus 10,20,40                    substitui os níveis de VU
--gomemlimit 5000MiB              limita a memória do k6
--out <dir>                       destino; reutilize o mesmo para retomar uma execução interrompida
--cooldown <s>                    descanso entre rodadas (padrão 30)
--force                           refaz rodadas que já existem em --out
--dry-run | --smoke | --help
```

### Repetições e agregação

```bash
node scripts/rodar_repeticoes.js --n 10 --out-base resultados/final --gomemlimit 5000MiB --shuffle
node scripts/agregar.js --out-base resultados/final
```

`rodar_repeticoes.js` chama o runner uma vez por repetição (`rep01`, `rep02`, ...) e pula as repetições marcadas com `.completo`, o que permite retomar uma coleta interrompida. As opções que ele não reconhece são repassadas ao runner.

`agregar.js` grava em `resultados/final/`:

- `agregado.json` e `agregado.csv`: média, desvio padrão e IC de 95% por condição e métrica
- `testes.json` e `teste_hipotese.csv`: teste t de Welch, p ajustado por Holm (calculado sobre o p sem arredondamento), diferença relativa com IC de 95% e marca de equivalência (±5%, coluna `equivalente_5pct`) nas comparações `bun_vs_node`, `bunpg_vs_node` e `bunsql_vs_bunpg`
- `brutos.csv`: uma linha por repetição
- `oom.csv`: quais rodadas terminaram com o contêiner da API morto e com qual código
- `saturacao.csv` e `saturacao_resumo.csv`: ponto de saturação de cada execução e o resumo por condição (mínimo, mediana, máximo e o ponto na curva das médias). Critério (seção 3.6.1): primeiro estágio com erro ≥ 1%, ou com vazão útil < 1,05 × a do estágio anterior e P99 das respostas 201 > 1,5 × o do estágio anterior. O limiar de 1,5 (e não 2) vem do modelo fechado: com Z = 0, R = N/X, então dobrar os VUs com a vazão parada já faz a latência média crescer ~1,9×. As colunas `vus_erro_1pct_*` trazem, em separado, o primeiro estágio com erro ≥ 1%
- `interacao.csv`: se a razão entre runtimes muda do Cenário A para o B (`tipo=cenario`, segunda parte da H1) ou de um payload para o seguinte (`tipo=payload`). O teste é um contraste de Welch em escala log: `razao_de` e `razao_para` são razões de médias geométricas (alt/ref) e `razao_para_sobre_de` é quanto a razão mudou, com IC de 95% e Holm por família tipo × comparação × métrica. `efeito` diz se o alternativo ficou relativamente melhor ou pior no "para", levando em conta se a métrica é melhor quando maior (vazão) ou menor (latência)
- `decomposicao.csv`: para cada runtime, `delta` = Cenário B − Cenário A (custo da persistência, ΔT_io), com IC de 95%. A base do Cenário A do `bunpg` é o Bun
- `decomposicao_comparacao.csv`: se o custo da persistência difere entre runtimes, isto é, (B − A) do alternativo − (B − A) da referência, com Holm por comparação × métrica

As métricas `requisicoes_total` e `requisicoes_ok` (quantidade de requisições na fase sustentada de cada estágio) entram em `agregado.csv` para mostrar de quantas observações sai cada percentil, mas não entram nos testes.

### Coleta em blocos

Cada repetição da matriz leva cerca de 1 h 30 min, e as 10 repetições, cerca de 16 a 17 h. A coleta pode ser dividida em blocos de repetições inteiras: como `rodar_repeticoes.js` pula as repetições com `.completo`, basta aumentar `--n` a cada bloco, sempre com o mesmo `--out-base` e as mesmas opções.

No Windows, `scripts/rodar_bloco.ps1` prepara a máquina e roda o bloco. Abra o PowerShell **como administrador**, fora do VS Code, na pasta do experimento:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rodar_bloco.ps1 -N 3    # bloco 1: rep01-rep03 (~4 h 40 min)
powershell -ExecutionPolicy Bypass -File .\scripts\rodar_bloco.ps1 -N 6    # bloco 2: rep04-rep06 (~4 h 40 min)
powershell -ExecutionPolicy Bypass -File .\scripts\rodar_bloco.ps1 -N 8    # bloco 3: rep07-rep08 (~3 h 05 min)
powershell -ExecutionPolicy Bypass -File .\scripts\rodar_bloco.ps1 -N 10   # bloco 4: rep09-rep10 (~3 h 05 min)
node scripts/agregar.js --out-base resultados/final
```

O script:

1. confere se o notebook está na tomada, se o `.wslconfig` tem 6 processadores, 12 GB e swap desativado, e se não há alterações sem commit (o commit vai para `ambiente.json`);
2. fecha navegadores, IDEs, Office, apps de conversa, jogos e o app Claude (`-ManterClaude` evita). Programas que podem ter trabalho não salvo recebem um pedido de fechamento; os que sobrarem só são forçados se você confirmar;
3. encerra o OneDrive e, como administrador, para Windows Update, Otimização de Entrega, Windows Search e SysMain;
4. reinicia o Docker Desktop e o WSL, para contêineres que tenham sobrado e confere CPUs e memória da VM do Docker;
5. grava um retrato do ambiente (programas fechados, serviços parados, processos restantes) em `resultados/final/preparacao/`;
6. roda `rodar_repeticoes.js --n <N> --out-base resultados/final --gomemlimit 5000MiB --shuffle` impedindo o Windows de suspender e, ao terminar ou com Ctrl+C, religa os serviços e o OneDrive.

Sem o script, os comandos equivalentes são `node scripts/rodar_repeticoes.js --n 3 --out-base resultados/final --gomemlimit 5000MiB --shuffle`, depois `--n 6`, `--n 8` e `--n 10`. Com `-SoPreparar` o script só prepara a máquina; `-Restaurar` religa depois os serviços e o OneDrive.

Uma repetição nunca é dividida entre blocos, para que as 15 condições de cada repetição sejam percorridas em sequência. Se um bloco for interrompido, o mesmo comando retoma a repetição incompleta a partir das rodadas que faltam. Os horários de início e fim de cada repetição ficam em `resultados/final/resumo-repeticoes.json`. Não feche a tampa do notebook durante o bloco.

## Gerador de carga

`k6/teste_rampa.js` roda em todas as rodadas, de **10 a 1280 VUs** (8 patamares de 10 s de rampa e 30 s sustentados), com tempo limite de 10 s por requisição. Exporta P95 e P99, a latência só das respostas 201, o tempo total com conexão, a contagem de respostas por classe (ok, timeout, conexão, 4xx e 5xx) e o instante de início do teste.

## O que cada rodada faz

1. Para todas as APIs e sobe só a API alvo (e o Postgres, no cenário B, com o schema do `init.sql` e as tabelas truncadas).
2. Aguarda a API responder e confere `POST /produtos → 201`.
3. Inicia o monitor (`docker stats` a cada 1 s) para a API, para o k6 e, no cenário B, para o Postgres, e depois o k6.
4. Grava o resultado, os stats, o estado da API (`OOMKilled`, código de saída, reinícios) e o log do contêiner.
5. Descansa e passa à próxima rodada.

Arquivos gerados em `--out`:

```
ambiente.json                       hardware, versões, commit git e parâmetros
execucao.json                       status de cada rodada
node/resultado_cenarioA_node_pequeno.json    métricas do k6 por estágio
node/stats_cenarioA_node_pequeno.json        CPU e memória da API ao longo do teste
node/stats_k6_...json, stats_pg_...json      CPU e memória do k6 e do Postgres
bun/, bunpg/                                 o mesmo para as outras variantes
logs/                               saída do k6, do monitor e da API por rodada
```

## Requisitos de hardware e memória

Todos os contêineres (APIs, Postgres e k6) dividem a mesma VM do Docker. A coleta de referência usou uma VM do WSL2 com 6 vCPUs e 11,68 GiB.

Limites por contêiner (em `docker-compose.yml`): API com 2 CPUs e 3 GiB (`API_MEMORY` no `.env` altera), Postgres com 1 CPU e 1 GiB, k6 com 4 CPUs e 6 GiB.

- O k6 mantém todos os VUs em memória. Com payload grande e 1280 VUs ele usa vários GiB; abaixo de 8 GiB na VM o runner avisa.
- Windows (WSL2): ajuste `memory=` e `processors=` em `%UserProfile%\.wslconfig` e rode `wsl --shutdown`. Desative o swap para que a falta de memória termine o processo em vez de degradar a latência.
- Para comparações justas, feche outros programas durante a coleta e não use o computador no meio.

## Estrutura

```
api-node/, api-bun/     as APIs (server-a.js = cenário A, server-b.js = cenário B) e seus Dockerfiles
shared/validacao.js     validação do payload, compartilhada pelas duas runtimes
init.sql                tabelas do cenário B
payloads/               os três payloads
k6/teste_rampa.js       script de carga
monitor/coletor_status.js     coleta CPU e memória de um contêiner até a sentinela aparecer
scripts/rodar_matriz.js       executa a matriz (módulos em scripts/lib/)
scripts/rodar_repeticoes.js   repete a matriz
scripts/agregar.js            agrega as repetições (estatística em scripts/estatistica.js)
scripts/diagnosticar_node.js  diagnóstico das falhas do Node no cenário A
scripts/rodar_bloco.ps1       prepara o Windows e roda um bloco de repetições
resultados/             dados coletados
docker-compose.yml      postgres, 5 APIs e o serviço k6 (profile "tools")
```

Os módulos de `scripts/lib/`: `util.js` (espera, log e erro), `configuracao.js` (argumentos, `.env` e serviços), `docker.js` (Docker, Compose, banco e ambiente) e `rodada.js` (uma rodada: monitores e k6).

## Uso manual (sem o runner)

```bash
docker compose build
docker compose up -d api-node-a
curl -X POST -H 'Content-Type: application/json' \
     --data-binary @payloads/payload_pequeno.json http://localhost:3011/produtos

docker compose up -d api-bun-b
docker compose run --rm -T \
  -e TARGET=http://api-bun-b:3002/produtos \
  -e PAYLOAD=/payloads/payload_medio.json \
  -e OUT_FILE=/resultados/resumo.json \
  k6 run /k6/teste_rampa.js
docker compose down
```

Portas no host: A-Node `3011`, A-Bun `3012`, B-Node `3001`, B-Bun `3002`, B-Bun+pg `3003`, Postgres `5433`.

## Versões fixadas

Node `24.21.0`, Bun `1.4.2`, PostgreSQL `16.13`, k6 `2.3.0` e pacote `pg` `8.23.0` (via `package-lock.json`). Podem ser alteradas no `.env`; as versões efetivas de cada execução ficam em `ambiente.json`.

## Diagnóstico das falhas do Node

`scripts/diagnosticar_node.js` sobe o Node do cenário A em variantes e roda o k6 em 160 e 320 VUs com payload grande (padrão):

- `padrao_sem_diag` e `padrao`: configuração original, sem e com instrumentação
- `timeouts_altos`: `keepAliveTimeout=65000`, `headersTimeout=70000`, `requestTimeout=0`
- `corpo_buffer`: leitura do corpo com `Buffer.concat` em vez de concatenar strings
- `timeouts_altos_corpo_buffer`: as duas alterações juntas
- `bun_referencia`: o Bun do cenário A, para comparação

A instrumentação é ligada por `DIAGNOSTICO=1` e registra no log do servidor as conexões, `clientError`, erros de socket, status das respostas e requisições abortadas. As variáveis `SERVER_KEEPALIVE_MS`, `SERVER_HEADERS_MS`, `SERVER_REQUEST_MS` e `SERVER_BODY_MODE` só têm efeito quando definidas.

## Problemas comuns

- **k6 termina com exit 137:** falta de memória na VM do Docker. Aumente a memória da VM ou use `--gomemlimit`.
- **Porta em uso:** ajuste `*_HOST_PORT` no `.env`.
- **`Docker não encontrado ou daemon parado`:** inicie o Docker Desktop ou o serviço do Docker.
- **Rodada isolada em pasta que já tem outras:** o `execucao.json` é atualizado rodada a rodada, sem apagar as entradas das outras; o `ambiente.json`, porém, é regravado com os parâmetros da última chamada.
