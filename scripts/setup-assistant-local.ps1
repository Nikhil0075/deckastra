param([string]$Root = (Join-Path $env:LOCALAPPDATA 'Deckastra\assistant'), [ValidateRange(4096,32768)][int]$ContextTokens = 16384)
$ErrorActionPreference = 'Stop'
$runtimeTag = 'b11146'
$modelRevision = '675cff42a74c774d6cb76f76d8eacb49b48c9b93'
$runtimeDir = Join-Path $Root "runtime\$runtimeTag"
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$downloads = @(
  @{ Name = 'llama-b11146-bin-win-cuda-12.4-x64.zip'; Digest = '3c806a6ceccc3dae1c743ceb1a1fb2cce5b76f40bfbd4c6b7b8afb6ef45a5807' },
  @{ Name = 'cudart-llama-bin-win-cuda-12.4-x64.zip'; Digest = '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' }
)
foreach ($download in $downloads) {
  $archive = Join-Path $runtimeDir $download.Name
  if (!(Test-Path -LiteralPath $archive)) {
    Write-Output "Downloading pinned runtime $($download.Name)"
    Invoke-WebRequest -Uri "https://github.com/ggml-org/llama.cpp/releases/download/$runtimeTag/$($download.Name)" -OutFile $archive -TimeoutSec 600
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $download.Digest) { throw 'Runtime checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir -Force
}
$modelRoot = Join-Path $Root 'models'
$installer = Join-Path $PSScriptRoot 'install-model-pack.py'
python $installer --repo google/gemma-4-E2B-it-qat-q4_0-gguf --file gemma-4-E2B_q4_0-it.gguf --projector-file gemma-4-E2B-it-mmproj.gguf --revision $modelRevision --id gemma4-e2b-q4 --name 'Gemma 4 E2B QAT Q4' --context $ContextTokens --license apache-2.0 --root $modelRoot
if ($LASTEXITCODE -ne 0) { throw 'Model pack installation failed.' }
$server = Get-ChildItem -LiteralPath $runtimeDir -Filter 'llama-server.exe' -Recurse | Select-Object -First 1
if (!$server) { throw 'The verified runtime archive has no llama-server.exe.' }
$config = @{
  DECKASTRA_MODEL_DIR = $modelRoot
  DECKASTRA_MODEL_PACK = 'gemma4-e2b-q4'
  DECKASTRA_ASSISTANT_PACK = 'gemma4-e2b-q4'
  DECKASTRA_ASSISTANT_RUNTIME = "$runtimeTag-cuda12.4"
  DECKASTRA_ASSISTANT_HARDWARE = ((nvidia-smi --query-gpu=name,memory.total --format=csv,noheader) -join '; ')
  DECKASTRA_MODEL_SERVER_CMD = ('"' + $server.FullName + '" -m "{model}" --port {port} -c {context} -ngl 99 --no-mmproj-offload --host 127.0.0.1 --jinja --parallel 1')
  DECKASTRA_ASSISTANT_MODE = 'hybrid'
}
$configPath = Join-Path $Root 'local-config.json'
if (Test-Path -LiteralPath $configPath) {
  $previousConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json -AsHashtable
  foreach ($key in $previousConfig.Keys) { if (!$config.ContainsKey($key)) { $config[$key] = $previousConfig[$key] } }
}
$config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
Write-Output "Local configuration saved to $(Join-Path $Root 'local-config.json'). Run benchmark-assistant.py before enabling hybrid qualification."
