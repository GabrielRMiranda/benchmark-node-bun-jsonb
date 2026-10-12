<#
.SYNOPSIS

.DESCRIPTION

.PARAMETER N

.PARAMETER SoPreparar

.PARAMETER Restaurar

.PARAMETER ManterClaude

.EXAMPLE
#>
[CmdletBinding()]
param(
  [int]$N = 0,
  [string]$OutBase = 'resultados/final',
  [string]$GoMemLimit = '5000MiB',
  [switch]$SoPreparar,
  [switch]$Restaurar,
  [switch]$ManterClaude,
  [switch]$SemReiniciarDocker,
  [switch]$IgnorarBateria,
  [string]$Cenarios = '',
  [string]$Payloads = '',
  [string]$Runtimes = '',
  [int]$NodeHeapMb = 0
)

$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

$esperado = @{ Cpus = 6; MemoriaGiB = 11.68; WslMemoria = '12GB'; WslProcessadores = '6'; WslSwap = '0' }
$minutosPorRepeticao = 93
$arquivoEstado = Join-Path $env:TEMP 'tcc_benchmark_estado.json'

$encerrarDireto = @(
  'Discord', 'Spotify', 'steam', 'steamwebhelper', 'EpicGamesLauncher', 'EpicWebHelper', 'ProjectZomboid64',
  'ms-teams', 'Teams', 'slack', 'WhatsApp', 'Telegram', 'Zoom', 'Dropbox', 'GoogleDriveFS', 'Postman', 'Claude'
)

$fecharComCuidado = @(
  'chrome', 'msedge', 'firefox', 'brave', 'opera', 'Code', 'idea64', 'studio64', 'datagrip64', 'azuredatastudio',
  'WINWORD', 'EXCEL', 'POWERPNT', 'OUTLOOK', 'ONENOTE', 'notepad++', 'Notion', 'Obsidian', 'javaw', 'java'
)

$servicos = @('wuauserv', 'UsoSvc', 'DoSvc', 'WSearch', 'SysMain')

function Escrever([string]$texto, [string]$cor = 'Gray') {
  Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $texto) -ForegroundColor $cor
}

function Aviso([string]$texto) { Escrever "AVISO: $texto" 'Yellow' }

function Perguntar([string]$pergunta) { return ((Read-Host "$pergunta [s/N]") -match '^[sS]') }

function CaminhoOneDrive {
  $candidatos = @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\OneDrive\OneDrive.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft OneDrive\OneDrive.exe')
  )

  foreach ($caminho in $candidatos) { if (Test-Path $caminho) { return $caminho } }

  return $null
}

function Restaurar-Ambiente($estado) {
  if (-not $estado) { return }

  foreach ($nome in $estado.Servicos) {
    try { Start-Service -Name $nome -ErrorAction Stop; Escrever "Serviço $nome religado." }

    catch { Aviso "não foi possível religar o serviço $nome ($($_.Exception.Message))." }
  }

  if ($estado.OneDrive) {
    $exe = CaminhoOneDrive

    if ($exe) { Start-Process -FilePath $exe -ArgumentList '/background'; Escrever 'OneDrive religado (vai sincronizar os resultados novos).' }
  }

  Remove-Item $arquivoEstado -ErrorAction SilentlyContinue
}

if ($Restaurar) {
  if (-not (Test-Path $arquivoEstado)) { Escrever 'Nada a restaurar.'; exit 0 }

  Restaurar-Ambiente (Get-Content $arquivoEstado -Raw | ConvertFrom-Json)

  exit 0
}

if (-not $SoPreparar -and $N -lt 1) {
  Write-Host 'Informe o total de repetições ao fim do bloco, por exemplo: -N 3 (ou use -SoPreparar).' -ForegroundColor Red

  exit 2
}

$ehAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

Escrever "Pasta do experimento: $raiz" 'Cyan'

Add-Type -AssemblyName System.Windows.Forms

$energia = [System.Windows.Forms.SystemInformation]::PowerStatus

if ($energia.PowerLineStatus -ne 'Online') {
  if ($IgnorarBateria) { Aviso 'o notebook está na bateria.' }

  else {
    Write-Host 'O notebook está na bateria. Ligue o carregador (ou use -IgnorarBateria).' -ForegroundColor Red
    exit 1
  }
}
$planoEnergia = (& powercfg /getactivescheme) -join ' '
Escrever "Energia: na tomada | $planoEnergia"

$wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
$conteudoWsl = ''
if (Test-Path $wslconfig) {
  $conteudoWsl = Get-Content $wslconfig -Raw
  $lerChave = {
    param($chave)
    $achado = [regex]::Match($conteudoWsl, "(?im)^\s*$chave\s*=\s*([^\r\n#]+)")
    if ($achado.Success) { return $achado.Groups[1].Value.Trim() }
    return '(ausente)'
  }
  $wsl = @{ memory = (& $lerChave 'memory'); processors = (& $lerChave 'processors'); swap = (& $lerChave 'swap') }
  Escrever ".wslconfig: memory=$($wsl.memory) processors=$($wsl.processors) swap=$($wsl.swap)"
  if ($wsl.memory -ne $esperado.WslMemoria -or $wsl.processors -ne $esperado.WslProcessadores -or $wsl.swap -ne $esperado.WslSwap) {
    Aviso "o TCC descreve memory=$($esperado.WslMemoria), processors=$($esperado.WslProcessadores) e swap=$($esperado.WslSwap)."
  }
} else {
  Aviso "não encontrei $wslconfig; o TCC descreve 6 processadores, 12 GB e swap desativado."
}

if (Get-Command git -ErrorAction SilentlyContinue) {
  $commit = (& git rev-parse --short HEAD 2>$null)
  if ($LASTEXITCODE -eq 0) {
    $alteracoes = & git status --porcelain -- . 2>$null
    Escrever "Commit atual: $commit"
    if ($alteracoes) {
      Aviso 'há alterações não commitadas na pasta do experimento. O commit gravado em ambiente.json não vai descrever o código que rodou.'
      $alteracoes | Select-Object -First 15 | ForEach-Object { Write-Host "    $_" }
      if (-not (Perguntar 'Continuar mesmo assim?')) { exit 1 }
    }
  } else { Aviso 'a pasta não está em um repositório git; o commit não será registrado.' }
} else { Aviso 'git não encontrado; o commit não será registrado.' }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Node.js não encontrado no PATH.' -ForegroundColor Red; exit 1 }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Host 'Docker não encontrado no PATH.' -ForegroundColor Red; exit 1 }

$ancestrais = @()
$atual = $PID
for ($i = 0; $i -lt 20 -and $atual; $i++) {
  $processo = Get-CimInstance Win32_Process -Filter "ProcessId=$atual" -ErrorAction SilentlyContinue
  if (-not $processo) { break }
  $ancestrais += [pscustomobject]@{ Id = [int]$processo.ProcessId; Nome = [IO.Path]::GetFileNameWithoutExtension($processo.Name) }
  $atual = [int]$processo.ParentProcessId
}
$nomesAncestrais = $ancestrais | ForEach-Object { $_.Nome }
if ($ManterClaude) { $encerrarDireto = $encerrarDireto | Where-Object { $_ -ne 'Claude' } }
foreach ($nome in ($encerrarDireto + $fecharComCuidado)) {
  if ($nomesAncestrais -contains $nome) {
    Aviso "o script está rodando dentro de '$nome', que por isso não será fechado. Para a coleta, prefira um terminal avulso."
  }
}
$encerrarDireto = @($encerrarDireto | Where-Object { $nomesAncestrais -notcontains $_ })
$fecharComCuidado = @($fecharComCuidado | Where-Object { $nomesAncestrais -notcontains $_ })

$fechados = @()
$diretos = if ($encerrarDireto.Count) { Get-Process -Name $encerrarDireto -ErrorAction SilentlyContinue } else { $null }
if ($diretos) {
  $fechados += $diretos | Select-Object -ExpandProperty ProcessName -Unique
  Escrever ('Encerrando: ' + (($diretos | Select-Object -ExpandProperty ProcessName -Unique) -join ', '))
  $diretos | Stop-Process -Force -ErrorAction SilentlyContinue
}

$cuidadosos = if ($fecharComCuidado.Count) { Get-Process -Name $fecharComCuidado -ErrorAction SilentlyContinue } else { $null }
if ($cuidadosos) {
  $fechados += $cuidadosos | Select-Object -ExpandProperty ProcessName -Unique
  Escrever ('Pedindo para fechar: ' + (($cuidadosos | Select-Object -ExpandProperty ProcessName -Unique) -join ', '))
  $limite = (Get-Date).AddSeconds(20)
  do {
    $comJanela = @(Get-Process -Name $fecharComCuidado -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
    foreach ($processo in $comJanela) { [void]$processo.CloseMainWindow() }
    Start-Sleep -Seconds 2
  } while ($comJanela.Count -gt 0 -and (Get-Date) -lt $limite)

  $restantes = Get-Process -Name $fecharComCuidado -ErrorAction SilentlyContinue
  if ($restantes) {
    $resumo = $restantes | Group-Object ProcessName | ForEach-Object { "$($_.Name) ($($_.Count))" }
    Aviso ('ainda abertos (processos em segundo plano ou janelas pedindo para salvar): ' + ($resumo -join ', '))
    if (Perguntar 'Forçar o encerramento? O que não estiver salvo nesses programas será perdido.') {
      $restantes | Stop-Process -Force -ErrorAction SilentlyContinue
    } else { Aviso 'eles continuam abertos e vão disputar recursos com o teste.' }
  }
}

$estado = [ordered]@{ Servicos = @(); OneDrive = $false }
if (Get-Process OneDrive -ErrorAction SilentlyContinue) {
  $exe = CaminhoOneDrive
  if ($exe) { & $exe /shutdown; Start-Sleep -Seconds 3 }
  Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $estado.OneDrive = $true
  Escrever 'OneDrive encerrado (a sincronização volta no fim do bloco).'
}

if ($ehAdmin) {
  foreach ($nome in $servicos) {
    $servico = Get-Service -Name $nome -ErrorAction SilentlyContinue
    if ($servico -and $servico.Status -eq 'Running') {
      try {
        Stop-Service -Name $nome -Force -ErrorAction Stop
        $estado.Servicos += $nome
        Escrever "Serviço $nome parado."
      } catch { Aviso "não foi possível parar o serviço $nome ($($_.Exception.Message))." }
    }
  }
} else {
  Aviso 'PowerShell sem administrador: Windows Update, Windows Search e SysMain continuam ligados. Para pará-los, abra o PowerShell como administrador.'
}
$estado | ConvertTo-Json | Set-Content -Path $arquivoEstado -Encoding UTF8

function Aguardar-Docker([int]$limiteSegundos) {
  $fim = (Get-Date).AddSeconds($limiteSegundos)
  while ((Get-Date) -lt $fim) {
    $null = & docker info --format '{{.ServerVersion}}' 2>$null
    if ($LASTEXITCODE -eq 0) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

if (-not $SemReiniciarDocker) {
  Escrever 'Reiniciando Docker Desktop e WSL...'
  $null = & docker desktop stop 2>$null
  if ($LASTEXITCODE -ne 0) {
    Get-Process 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 5
  & wsl --shutdown
  Start-Sleep -Seconds 8
  $null = & docker desktop start 2>$null
  if ($LASTEXITCODE -ne 0) {
    $exeDocker = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path $exeDocker) { Start-Process -FilePath $exeDocker }
  }
}
if (-not (Aguardar-Docker 300)) {
  Write-Host 'O Docker não respondeu em 5 minutos. Abra o Docker Desktop e rode o script de novo.' -ForegroundColor Red
  Restaurar-Ambiente $estado
  exit 1
}

$sobras = & docker ps --format '{{.Names}}' 2>$null
if ($sobras) {
  Escrever ('Parando contêineres em execução: ' + ($sobras -join ', '))
  & docker stop $sobras | Out-Null
}

if (-not $SemReiniciarDocker) {
  Escrever 'Aguardando 60 s para o Docker terminar de inicializar...'
  Start-Sleep -Seconds 60
}

$infoDocker = (& docker info --format '{{.NCPU}}|{{.MemTotal}}|{{.ServerVersion}}' 2>$null) -split '\|'
$cpusDocker = [int]$infoDocker[0]
$memoriaDockerGiB = [math]::Round([double]$infoDocker[1] / 1GB, 2)
Escrever "VM do Docker: $cpusDocker CPUs, $memoriaDockerGiB GiB (engine $($infoDocker[2]))"
if ($cpusDocker -ne $esperado.Cpus -or [math]::Abs($memoriaDockerGiB - $esperado.MemoriaGiB) -gt 0.3) {
  Aviso "o TCC descreve $($esperado.Cpus) CPUs e $($esperado.MemoriaGiB) GiB na VM do Docker."
  if (-not (Perguntar 'Continuar mesmo assim?')) { Restaurar-Ambiente $estado; exit 1 }
}

$pastaPreparacao = Join-Path $raiz (Join-Path $OutBase 'preparacao')
New-Item -ItemType Directory -Force -Path $pastaPreparacao | Out-Null
$carimbo = Get-Date -Format 'yyyyMMdd-HHmm'
$rotulo = if ($SoPreparar) { 'so_preparar' } else { 'ate_rep{0:D2}' -f $N }
if ($NodeHeapMb -gt 0) { $rotulo += "_heap$NodeHeapMb" }
$arquivoRetrato = Join-Path $pastaPreparacao "bloco_${rotulo}_$carimbo.txt"
$processos = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 25 `
  ProcessName, Id, @{ n = 'MemoriaMB'; e = { [math]::Round($_.WorkingSet64 / 1MB) } }, @{ n = 'CpuSegundos'; e = { [math]::Round($_.CPU, 1) } }
@(
  "Data: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
  "Computador: $env:COMPUTERNAME"
  "Energia: $($energia.PowerLineStatus) | bateria $([math]::Round($energia.BatteryLifePercent * 100))%"
  "Plano de energia: $planoEnergia"
  "Administrador: $ehAdmin"
  "Docker: $cpusDocker CPUs, $memoriaDockerGiB GiB, engine $($infoDocker[2])"
  "Programas fechados: $(($fechados | Sort-Object -Unique) -join ', ')"
  "OneDrive encerrado: $($estado.OneDrive)"
  "Serviços parados: $($estado.Servicos -join ', ')"
  ''
  '.wslconfig:'
  $conteudoWsl
  ''
  'Processos com mais memória depois da preparação:'
  ($processos | Format-Table -AutoSize | Out-String)
) | Set-Content -Path $arquivoRetrato -Encoding UTF8
Escrever "Retrato do ambiente gravado em $arquivoRetrato"

if ($SoPreparar) {
  Escrever 'Máquina preparada. Quando terminar, rode o script com -Restaurar para religar serviços e OneDrive.' 'Green'
  exit 0
}

$pastaBase = Join-Path $raiz $OutBase

$concluidas = @(Get-ChildItem -Path $pastaBase -Directory -Filter 'rep*' -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName '.completo') }).Count
$faltam = [math]::Max(0, $N - $concluidas)

$listaCenarios = if ($Cenarios) { $Cenarios -split ',' } else { @('A', 'B') }
$quantosPayloads = if ($Payloads) { ($Payloads -split ',').Count } else { 3 }
$listaRuntimes = if ($Runtimes) { $Runtimes -split ',' } else { @('node', 'bun', 'bunpg') }
$rodadasPorRepeticao = 0
foreach ($cenario in $listaCenarios) {
  foreach ($runtime in $listaRuntimes) {
    if (-not ($runtime.Trim() -eq 'bunpg' -and $cenario.Trim().ToUpper() -eq 'A')) { $rodadasPorRepeticao += $quantosPayloads }
  }
}
$minutosPorRepeticao = [math]::Ceiling($rodadasPorRepeticao * 6.2)
$previsao = (Get-Date).AddMinutes($faltam * $minutosPorRepeticao)

Escrever ("Repetições concluídas: $concluidas. Este bloco roda $faltam (previsão de término: " + $previsao.ToString('dd/MM HH:mm') + ').') 'Cyan'

Escrever 'Não use o notebook e não feche a tampa durante o bloco (fechar a tampa pode suspender o Windows).' 'Cyan'

if (-not ('TCC.Energia' -as [type])) {
  Add-Type -Namespace TCC -Name Energia -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
}

$ES_CONTINUOUS = [uint32]2147483648

$ES_SYSTEM_REQUIRED = [uint32]1

$codigo = 1

try {
  [void][TCC.Energia]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
  
  $argumentos = @('scripts/rodar_repeticoes.js', '--n', $N, '--out-base', $OutBase, '--gomemlimit', $GoMemLimit, '--shuffle')
  if ($Cenarios) { $argumentos += @('--scenarios', $Cenarios) }
  if ($Payloads) { $argumentos += @('--payloads', $Payloads) }
  if ($Runtimes) { $argumentos += @('--runtimes', $Runtimes) }
  if ($NodeHeapMb -gt 0) { $argumentos += @('--node-heap-mb', $NodeHeapMb) }
  Escrever ('node ' + ($argumentos -join ' '))
  & node @argumentos
  
  $codigo = $LASTEXITCODE
} finally {
  [void][TCC.Energia]::SetThreadExecutionState($ES_CONTINUOUS)

  Restaurar-Ambiente $estado

  if ($codigo -eq 0) { Escrever "Bloco concluído ($N repetições no total)." 'Green' }

  else { Aviso "o bloco terminou com código $codigo. Rode o mesmo comando para retomar as rodadas que faltaram." }
}
exit $codigo