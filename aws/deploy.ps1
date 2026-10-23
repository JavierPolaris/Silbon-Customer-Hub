# Despliega la API de favoritos en AWS: pila de CloudFormation y codigo de la
# Lambda. Solo necesita el AWS CLI y Node. Sin SAM ni CDK, igual que el resto
# de pilas de Silbon (ver back_pedidos_online_clean/aws/deploy.ps1).
#
# Uso:
#   npm run aws:deploy -- -ShopifyDomain silbon-store.myshopify.com
#
#   Con dominio propio (certificado ACM REGIONAL, en eu-central-1):
#   npm run aws:deploy -- ... -DomainName favoritos.silbon.es `
#     -CertificateArn arn:aws:acm:eu-central-1:...:certificate/...
#
#   Solo subir codigo (la pila no cambia):
#   npm run aws:deploy -- ... -SkipStack
#
# Tras el PRIMER despliegue (o si cambia la URL) hay que registrar el webhook:
#   node scripts/register-webhook.mjs <URL publica>

[CmdletBinding()]
param(
  [string]$StackName = 'silbon-favoritos',
  [string]$Region = 'eu-central-1',
  [string]$SecretsPrefix = '/silbon/favoritos',
  [string]$ShopifyDomain = $env:SHOPIFY_DOMAIN,
  [string]$CorsAllowedOrigins = 'https://www.silbonshop.com,https://silbonshop.com',
  # Dominio propio opcional. Vacio = URL de execute-api.
  [string]$DomainName = '',
  [string]$CertificateArn = $env:FAVORITOS_CERTIFICATE_ARN,
  [string]$HostedZoneId = 'ZDE8KK068AVPG',
  # Salta la pila: solo empaqueta y sube el codigo.
  [switch]$SkipStack
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $SkipStack) {
  if (-not $ShopifyDomain) { throw 'Falta -ShopifyDomain (o la variable de entorno SHOPIFY_DOMAIN).' }
  if ($DomainName -and -not $CertificateArn) {
    throw 'Con -DomainName hace falta -CertificateArn (certificado ACM en la misma region que la pila).'
  }
}

function Get-StackOutput([string]$key) {
  $outputs = (aws cloudformation describe-stacks --stack-name $StackName --region $Region --output json | ConvertFrom-Json).Stacks[0].Outputs
  $salida = $outputs | Where-Object { $_.OutputKey -eq $key }
  if ($salida) { return $salida.OutputValue }
  return $null
}

# --- 1. Comprobar los secretos en SSM ----------------------------------------
# El script nunca pide ni escribe secretos: si falta alguno, imprime el
# comando para que lo cree quien tenga las claves.
$requiredSecrets = @('SHOPIFY_ACCESS_TOKEN')

Write-Host 'Comprobando secretos en SSM Parameter Store...' -ForegroundColor Cyan
$names = $requiredSecrets | ForEach-Object { "$SecretsPrefix/$_" }
$existing = @()
try {
  $result = aws ssm get-parameters --names $names --region $Region --output json | ConvertFrom-Json
  $existing = @($result.Parameters | ForEach-Object { $_.Name })
} catch {
  Write-Warning "No se pudo consultar SSM: $($_.Exception.Message)"
}

$missingRequired = @($names | Where-Object { $existing -notcontains $_ })
if ($missingRequired.Count -gt 0) {
  Write-Host ''
  Write-Host 'Faltan estos parametros. Crealos tu (no los pide este script):' -ForegroundColor Yellow
  foreach ($name in $missingRequired) {
    Write-Host "  aws ssm put-parameter --name $name --type SecureString --value '<valor>' --region $Region" -ForegroundColor Yellow
  }
  throw "Faltan $($missingRequired.Count) secretos en SSM."
}

if (-not $SkipStack) {
  # --- 2. Desplegar la pila --------------------------------------------------
  Write-Host "Desplegando la pila $StackName en $Region..." -ForegroundColor Cyan
  aws cloudformation deploy `
    --template-file "$PSScriptRoot/template.yaml" `
    --stack-name $StackName `
    --region $Region `
    --capabilities CAPABILITY_IAM `
    --no-fail-on-empty-changeset `
    --parameter-overrides `
      "SecretsPrefix=$SecretsPrefix" `
      "ShopifyDomain=$ShopifyDomain" `
      "CorsAllowedOrigins=$CorsAllowedOrigins" `
      "DomainName=$DomainName" `
      "CertificateArn=$CertificateArn" `
      "HostedZoneId=$HostedZoneId"
  if ($LASTEXITCODE -ne 0) { throw 'cloudformation deploy fallo' }
}

# --- 3. Empaquetar y subir el codigo de la Lambda -----------------------------
# El zip lleva server.js, updateExistingCustomers.js, favicon.ico y server/ en
# la raiz con las dependencias de produccion (express, cors, dotenv,
# serverless-http). El handler es server/lambda.handler.
$buildDir = Join-Path $repoRoot 'build-lambda'
$stageDir = Join-Path $buildDir 'stage'
$zipPath = Join-Path $buildDir 'function.zip'

Remove-Item -Recurse -Force $buildDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
Copy-Item -Path (Join-Path $repoRoot 'server') -Destination (Join-Path $stageDir 'server') -Recurse
foreach ($file in @('server.js', 'updateExistingCustomers.js', 'favicon.ico', 'package.json', 'package-lock.json')) {
  Copy-Item -Path (Join-Path $repoRoot $file) -Destination (Join-Path $stageDir $file)
}

Write-Host 'Instalando dependencias de produccion de la Lambda...' -ForegroundColor Cyan
Push-Location $stageDir
try {
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { throw 'npm ci fallo' }
} finally {
  Pop-Location
}

Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -Force

$fn = Get-StackOutput 'ApiFunctionName'
if (-not $fn) { throw 'La pila no expone ApiFunctionName' }
Write-Host "Subiendo codigo a $fn..." -ForegroundColor Cyan
aws lambda update-function-code --function-name $fn --zip-file "fileb://$zipPath" --region $Region --publish --output json | Out-Null
if ($LASTEXITCODE -ne 0) { throw "update-function-code fallo en $fn" }
aws lambda wait function-updated --function-name $fn --region $Region

# --- 4. Comprobar que responde ------------------------------------------------
# No hay ruta de health: GET /favorites sin customerId debe devolver 400 con
# JSON, que ya demuestra que la app arranca y enruta.
$publicUrl = Get-StackOutput 'PublicUrl'
try {
  $resp = Invoke-WebRequest -Uri "$publicUrl/favorites" -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
  Write-Warning "Esperaba 400 en GET /favorites sin customerId y respondio $($resp.StatusCode)"
} catch {
  $status = $null
  if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
  if ($status -eq 400) {
    Write-Host 'Health: GET /favorites sin customerId -> 400 (la app responde)' -ForegroundColor Green
  } else {
    Write-Warning "El health check no respondio como se esperaba: $($_.Exception.Message)"
  }
}

Write-Host ''
Write-Host 'Despliegue completado.' -ForegroundColor Green
Write-Host "URL publica: $publicUrl"
Write-Host "URL directa:  $(Get-StackOutput 'ApiUrl')"
Write-Host 'Rutas: POST /favorites/add, POST /favorites/remove, GET /favorites (tema), POST /webhooks/customers/create (Shopify)'
Write-Host "Si es el primer despliegue o cambio la URL: node scripts/register-webhook.mjs $publicUrl"
