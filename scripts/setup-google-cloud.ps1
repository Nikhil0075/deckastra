<#
.SYNOPSIS
  Connect Deckastra's translation and voices to a Google Cloud project.

.DESCRIPTION
  Integration plan 01 §3.7/§3.8 and plan 04. Everything happens in a gcloud
  configuration of Deckastra's own (CLOUDSDK_CONFIG), so the machine's usual
  gcloud login, its default project and its application-default credentials are
  left exactly as they were: Deckastra sends slide text to the project named
  here, under the account signed in here, and nothing else changes.

  Steps:
    1. Sign in once, in the browser (gcloud auth login --update-adc). That
       writes a credentials file Deckastra renews tokens from by itself.
    2. Point that configuration and the credentials' billing at the project.
    3. Enable the Cloud Translation and Text-to-Speech APIs.
    4. Print (or, with -Persist, save for this Windows user) the variables the
       app reads: DECKASTRA_GOOGLE_CREDENTIALS, GOOGLE_CLOUD_PROJECT,
       DECKASTRA_TRANSLATION=google and DECKASTRA_SPEECH=google.

  The project needs billing enabled; both APIs have a free monthly allowance.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/setup-google-cloud.ps1 -Project deckastra -Persist
#>
param(
  [string]$Project = "deckastra",
  [string]$Account = "",
  [switch]$Persist,
  [switch]$SkipLogin
)

$ErrorActionPreference = "Stop"
$configDir = Join-Path $env:APPDATA "Deckastra\gcloud"
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
$env:CLOUDSDK_CONFIG = $configDir
$credentials = Join-Path $configDir "application_default_credentials.json"

Write-Host "Deckastra's own gcloud configuration: $configDir"

if (-not $SkipLogin) {
  Write-Host "Sign in with the Google account that owns '$Project' (a browser window opens)."
  if ($Account) { gcloud auth login $Account --update-adc --brief } else { gcloud auth login --update-adc --brief }
  if ($LASTEXITCODE -ne 0) { throw "Sign-in did not finish." }
}
if (-not (Test-Path $credentials)) { throw "No credentials file at $credentials. Run again without -SkipLogin." }

gcloud config set project $Project --quiet | Out-Null
gcloud auth application-default set-quota-project $Project --quiet
if ($LASTEXITCODE -ne 0) { throw "Could not set '$Project' as the project to bill. Does this account have access to it?" }

$billing = gcloud billing projects describe $Project --format="value(billingEnabled)" 2>$null
if ($billing -ne "True") {
  Write-Warning "Billing does not appear to be enabled on '$Project' (or this account cannot see it). Translation and voices will be refused until it is."
}

Write-Host "Enabling Cloud Translation and Text-to-Speech on '$Project'..."
gcloud services enable translate.googleapis.com texttospeech.googleapis.com --project $Project
if ($LASTEXITCODE -ne 0) { throw "Enabling the APIs failed." }

$variables = [ordered]@{
  DECKASTRA_GOOGLE_CREDENTIALS = $credentials
  GOOGLE_CLOUD_PROJECT         = $Project
  DECKASTRA_TRANSLATION        = "google"
  DECKASTRA_SPEECH             = "google"
}
if ($Persist) {
  foreach ($name in $variables.Keys) {
    [Environment]::SetEnvironmentVariable($name, $variables[$name], "User")
  }
  Write-Host "Saved for this Windows user. Start Deckastra from a new terminal (or sign out and in) to pick them up."
} else {
  Write-Host "Set these before starting Deckastra (PowerShell):"
  foreach ($name in $variables.Keys) { Write-Host ("  `$env:{0} = '{1}'" -f $name, $variables[$name]) }
}
Write-Host "Check it end to end with: python scripts/check-google-cloud.py"
